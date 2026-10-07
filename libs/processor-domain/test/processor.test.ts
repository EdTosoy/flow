import assert from 'node:assert/strict';
import { test } from 'node:test';
import fc from 'fast-check';
import { Money, MAX_MINOR_UNITS } from '@flow/money';
import { normalize, canonicalJson } from '@flow/ingestion-domain';
import {
  interpret,
  lifecycle,
  settlementNet,
  derivationIdentity,
} from '../src/index';
test('explicit signs, full/partial refunds and chargebacks remain distinct', () => {
  const kinds = ['capture', 'fee', 'refund', 'chargeback'] as const;
  const amounts = [10000n, -300n, -2000n, -5000n];
  for (let i = 0; i < kinds.length; i++) {
    const a = interpret({
      type: 'movement',
      subtype: kinds[i]!,
      externalId: 'a',
      amount: Money.of(amounts[i]!, 'PHP').toJSON(),
      occurredAt: '2026-01-01T00:00:00.000Z',
      direction: i === 0 ? 'inflow' : 'outflow',
      reference: 'p',
      parentReference: i === 0 ? null : 'c',
    });
    assert.equal(a.control, null);
  }
  assert.equal(
    settlementNet(
      amounts.map((a) => Money.of(a, 'PHP')),
      'PHP',
    ),
    2700n,
  );
  assert.equal(lifecycle(100n, 20n, 0n, []), 'partially_refunded');
  assert.equal(lifecycle(100n, 100n, 0n, []), 'refunded');
  assert.equal(lifecycle(100n, 0n, 100n, []), 'charged_back');
  assert.equal(lifecycle(100n, 101n, 0n, []), 'under_review');
  assert.equal(lifecycle(0n, 0n, 0n, []), 'observed');
  assert.throws(() => settlementNet([Money.of(1n, 'USD')], 'PHP'));
  assert.equal(
    settlementNet(
      [Money.of(MAX_MINOR_UNITS, 'PHP'), Money.of(MAX_MINOR_UNITS, 'PHP')],
      'PHP',
    ),
    MAX_MINOR_UNITS * 2n,
  );
});
test('itemized reports normalize through explicit version, retain duplicates and reject malformed money/time', () => {
  const report = {
    id: 's',
    transferReference: 't',
    componentIds: ['a', 'a'],
    reportedAt: '2026-01-01T00:00:00.000Z',
    net: Money.of(-10n, 'PHP').toJSON(),
    gross: Money.of(0n, 'PHP').toJSON(),
    fees: Money.of(-10n, 'PHP').toJSON(),
    refunds: Money.of(0n, 'PHP').toJSON(),
    chargebacks: Money.of(0n, 'PHP').toJSON(),
  };
  const run = (r: unknown) =>
    normalize(Buffer.from(canonicalJson(r)), 's', 'synthetic-settlement-v1');
  const result = run(report);
  assert.equal(result.state, 'NORMALIZED');
  if (result.state === 'NORMALIZED' && result.observation.type === 'settlement')
    assert.deepEqual(result.observation.componentIds, ['a', 'a']);
  assert.deepEqual(run({ ...report, componentIds: [1] }), {
    state: 'FAILED',
    code: 'INVALID_STRUCTURE',
  });
  assert.deepEqual(
    run({ ...report, net: { amountMinor: 1, currency: 'PHP' } }),
    { state: 'FAILED', code: 'INVALID_MONEY' },
  );
  assert.deepEqual(run({ ...report, reportedAt: '2026-02-30T00:00:00.000Z' }), {
    state: 'FAILED',
    code: 'INVALID_TIMESTAMP',
  });
});
test('settlement conservation property: 500 trials seed 70401', () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.bigInt({ min: -9223372036854775808n, max: MAX_MINOR_UNITS }),
        { maxLength: 50 },
      ),
      (amounts) => {
        assert.equal(
          settlementNet(
            amounts.map((a) => Money.of(a, 'PHP')),
            'PHP',
          ),
          amounts.reduce((a, b) => a + b, 0n),
        );
      },
    ),
    { numRuns: 500, seed: 70401 },
  );
});
test('refund bound and lifecycle property: 500 trials seed 70402', () => {
  fc.assert(
    fc.property(
      fc.bigInt({ min: 1n, max: MAX_MINOR_UNITS }),
      fc.integer({ min: 0, max: 100 }),
      (capture, percent) => {
        const refund = (capture * BigInt(percent)) / 100n;
        assert.ok(refund <= capture);
        assert.notEqual(lifecycle(capture, refund, 0n, []), 'under_review');
        assert.equal(lifecycle(capture, capture + 1n, 0n, []), 'under_review');
      },
    ),
    { numRuns: 500, seed: 70402 },
  );
});
test('semantic derivation identity property: 500 trials seed 70403', () => {
  fc.assert(
    fc.property(
      fc.uuid(),
      fc.constantFrom('synthetic-movement-v1', 'synthetic-movement-v2'),
      fc.integer({ min: 1, max: 20 }),
      (id, version, n) => {
        const keys = Array.from({ length: n }, () =>
          derivationIdentity(id, version),
        );
        assert.equal(new Set(keys).size, 1);
        assert.notEqual(
          derivationIdentity(id, version),
          derivationIdentity(
            id,
            version === 'synthetic-movement-v1'
              ? 'synthetic-movement-v2'
              : 'synthetic-movement-v1',
          ),
        );
      },
    ),
    { numRuns: 500, seed: 70403 },
  );
});
