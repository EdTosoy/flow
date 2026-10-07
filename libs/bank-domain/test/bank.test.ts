import assert from 'node:assert/strict';
import { test } from 'node:test';
import fc from 'fast-check';
import { Money, MAX_MINOR_UNITS, MIN_MINOR_UNITS } from '@flow/money';
import { normalize } from '@flow/ingestion-domain';
import { movement, calculatedClosing, semanticIdentity } from '../src/index';
const bytes = (r: unknown) => Buffer.from(JSON.stringify(r));
const m = (amountMinor: string, currency = 'PHP') => ({
  amountMinor,
  currency,
});
test('statement conservation is exact across signs and totals wider than BIGINT', () => {
  fc.assert(
    fc.property(
      fc.bigInt({ min: MIN_MINOR_UNITS, max: MAX_MINOR_UNITS }),
      fc.array(
        fc
          .bigInt({ min: -MAX_MINOR_UNITS, max: MAX_MINOR_UNITS })
          .filter((x) => x !== 0n),
        { maxLength: 25 },
      ),
      (opening, amounts) => {
        assert.equal(
          calculatedClosing(
            Money.of(opening, 'PHP'),
            amounts.map((x) => movement(Money.of(x, 'PHP'))),
          ),
          opening + amounts.reduce((a, b) => a + b, 0n),
        );
      },
    ),
    { numRuns: 500, seed: 70501 },
  );
  assert.equal(
    calculatedClosing(Money.of(MAX_MINOR_UNITS, 'PHP'), [
      movement(Money.of(MAX_MINOR_UNITS, 'PHP')),
    ]),
    2n * MAX_MINOR_UNITS,
  );
  assert.throws(() => movement(Money.of(MIN_MINOR_UNITS, 'PHP')), RangeError);
  assert.throws(() => movement(Money.of(0n, 'PHP')), RangeError);
  assert.throws(() =>
    calculatedClosing(Money.of(0n, 'PHP'), [movement(Money.of(1n, 'USD'))]),
  );
});
test('bank normalization preserves exact amounts, direction, dates and deterministic identity', () => {
  fc.assert(
    fc.property(
      fc
        .bigInt({ min: -MAX_MINOR_UNITS, max: MAX_MINOR_UNITS })
        .filter((x) => x !== 0n),
      (n) => {
        const r = {
          id: 'entry',
          status: 'booked',
          amount: m(n.toString()),
          bookedAt: '2026-01-02T03:04:05.678Z',
          sourceOccurredAt: '2026-01-01T03:04:05.678Z',
          valueDate: '2026-01-03',
          transferReference: 'ordinary-source-reference',
        };
        const a = normalize(bytes(r), 'entry', 'synthetic-bank-entry-v1');
        assert.deepEqual(
          a,
          normalize(bytes(r), 'entry', 'synthetic-bank-entry-v1'),
        );
        assert.equal(a.state, 'NORMALIZED');
        if (a.state !== 'NORMALIZED' || a.observation.type !== 'bank-entry')
          throw new Error('Wrong result');
        assert.equal(Money.fromJSON(a.observation.amount).amountMinor, n);
        const domain = movement(Money.fromJSON(a.observation.amount));
        assert.equal(domain.direction, n > 0n ? 'CREDIT' : 'DEBIT');
        assert.equal(domain.amount.amountMinor, n < 0n ? -n : n);
        assert.equal(a.observation.valueDate, '2026-01-03');
        assert.equal(a.observation.sourceOccurredAt, r.sourceOccurredAt);
      },
    ),
    { numRuns: 500, seed: 70502 },
  );
});
test('semantic identity includes both versions without amount/reference heuristics', () => {
  fc.assert(
    fc.property(fc.uuid(), fc.uuid(), (revision, version) => {
      const id = semanticIdentity(revision, 'synthetic-bank-entry-v1');
      assert.equal(id, semanticIdentity(revision, 'synthetic-bank-entry-v1'));
      assert.notEqual(id, semanticIdentity(revision, version));
      assert.notEqual(
        id,
        semanticIdentity(revision, 'synthetic-bank-entry-v1', version),
      );
    }),
    { numRuns: 500, seed: 70503 },
  );
});
test('bank source optionality, malformed claims, no-ID and stock semantics are explicit', () => {
  const entry = {
    status: 'booked',
    amount: m('970000'),
    bookedAt: '2026-01-01T00:00:00.000Z',
  };
  const noId = normalize(bytes(entry), null, 'synthetic-bank-entry-v1');
  assert.equal(noId.state, 'NORMALIZED');
  if (noId.state === 'NORMALIZED' && noId.observation.type === 'bank-entry')
    assert.equal(noId.observation.externalId, null);
  for (const [change, code] of [
    [{ amount: m('0') }, 'INVALID_MONEY'],
    [{ amount: m(MIN_MINOR_UNITS.toString()) }, 'INVALID_MONEY'],
    [{ direction: 'DEBIT' }, 'INVALID_MONEY'],
    [{ amount: { amountMinor: 970000, currency: 'PHP' } }, 'INVALID_MONEY'],
    [{ valueDate: '2026-02-30' }, 'INVALID_TIMESTAMP'],
    [{ bookedAt: '2026-01-01T00:00:00+08:00' }, 'INVALID_TIMESTAMP'],
    [{ sequence: 1 }, 'INVALID_STRUCTURE'],
    [{ status: 'pending' }, 'INVALID_STRUCTURE'],
  ] as const) {
    assert.deepEqual(
      normalize(
        bytes({ ...entry, ...change }),
        null,
        'synthetic-bank-entry-v1',
      ),
      { state: 'FAILED', code },
    );
  }
  const report = {
    id: 's',
    currency: 'PHP',
    reportedAt: '2026-01-03T00:00:00.000Z',
  };
  const unknown = normalize(bytes(report), 's', 'synthetic-bank-statement-v1');
  assert.equal(unknown.state, 'NORMALIZED');
  if (
    unknown.state === 'NORMALIZED' &&
    unknown.observation.type === 'bank-statement'
  ) {
    assert.equal(unknown.observation.amount, null);
    assert.equal(unknown.observation.opening, null);
    assert.equal(unknown.observation.lineIds, null);
  }
  const zero = normalize(
    bytes({
      ...report,
      opening: m('0'),
      closing: m('0'),
      lineIds: [],
      expectedLineCount: 0,
    }),
    's',
    'synthetic-bank-statement-v1',
  );
  assert.notDeepEqual(zero, unknown);
  assert.deepEqual(
    normalize(
      bytes({ ...report, opening: m('1', 'USD') }),
      's',
      'synthetic-bank-statement-v1',
    ),
    { state: 'FAILED', code: 'INVALID_MONEY' },
  );
});
