import assert from 'node:assert/strict';
import { test } from 'node:test';
import fc from 'fast-check';
import { Money } from '@flow/money';
import {
  partitionStatus,
  discrepancy,
  totalStatus,
  exposureTotals,
  serializeControl,
} from '../src/index';
test('1000 processing and reconciliation partition conservation trials', () => {
  fc.assert(
    fc.property(
      fc.tuple(
        fc.bigInt({ min: 0n, max: 1000000n }),
        fc.bigInt({ min: 0n, max: 1000000n }),
        fc.bigInt({ min: 0n, max: 1000000n }),
      ),
      ([a, b, c]) => {
        assert.equal(partitionStatus(a + b + c, a, b, c), 'PASS');
        assert.equal(partitionStatus(a + b + c + 1n, a, b, c), 'FAIL');
        const matched = a,
          unmatched = b,
          ambiguous = c,
          ineligible = 17n;
        assert.equal(
          partitionStatus(
            matched + unmatched + ambiguous + ineligible,
            matched,
            unmatched,
            ambiguous + ineligible,
          ),
          'PASS',
        );
      },
    ),
    { numRuns: 1000, seed: 70901 },
  );
});
test('1000 exact discrepancy and currency isolation trials, including wider than Money totals', () => {
  fc.assert(
    fc.property(
      fc.bigInt({ min: -9223372036854775808n, max: 9223372036854775807n }),
      fc.bigInt({ min: -9223372036854775808n, max: 9223372036854775807n }),
      (a, b) => {
        assert.equal(
          discrepancy(Money.of(a, 'PHP'), Money.of(b, 'PHP')).amountMinor,
          (b - a).toString(),
        );
        assert.throws(() =>
          discrepancy(Money.of(a, 'PHP'), Money.of(b, 'USD')),
        );
        assert.equal(totalStatus(null, b.toString()), 'UNKNOWN');
      },
    ),
    { numRuns: 1000, seed: 70902 },
  );
});
test('1000 duplicate/permutation/accepted-risk exposure trials never add case references as value', () => {
  fc.assert(
    fc.property(
      fc.bigInt({ min: 0n, max: 9223372036854775807n }),
      fc.boolean(),
      (amount, risk) => {
        const a = {
            identity: 'economic-condition',
            currency: 'PHP' as const,
            amount: Money.of(amount, 'PHP').toJSON(),
            acceptedRisk: risk,
          },
          b = {
            identity: 'other-currency',
            currency: 'USD' as const,
            amount: Money.of(17n, 'USD').toJSON(),
            acceptedRisk: true,
          };
        assert.deepEqual(exposureTotals([a, b, a]), exposureTotals([b, a]));
        const php = exposureTotals([a, a])[0]!;
        assert.equal(php.unreconciledMinor, amount.toString());
        assert.equal(php.acceptedRiskMinor, risk ? amount.toString() : '0');
      },
    ),
    { numRuns: 1000, seed: 70903 },
  );
  assert.equal(
    exposureTotals([
      {
        identity: 'unknown',
        currency: 'PHP',
        amount: null,
        acceptedRisk: true,
      },
    ])[0]!.unknownCount,
    1,
  );
});
test('configuration identity normalizes only equivalent run ordering; conflicting identities and unsupported policy fail', () => {
  const c = {
    bookId: 'book',
    runKey: 'key',
    actorId: 'actor',
    reconciliationRunIds: ['b', 'a'],
  };
  assert.equal(
    serializeControl(c),
    serializeControl({ ...c, reconciliationRunIds: ['a', 'b'] }),
  );
  assert.throws(() =>
    serializeControl({ ...c, reconciliationRunIds: ['a', 'a'] }),
  );
  assert.throws(() => serializeControl({ ...c, maxAgeSeconds: 0 }));
});

test('unknown exposure has null full total and explicit known/unknown risk subtotals', () => {
  const t = exposureTotals([
    {
      identity: 'known',
      currency: 'PHP',
      amount: Money.of(17n, 'PHP').toJSON(),
      acceptedRisk: true,
    },
    { identity: 'unknown', currency: 'PHP', amount: null, acceptedRisk: true },
  ])[0]!;
  assert.equal(t.unreconciledMinor, null);
  assert.equal(t.acceptedRiskMinor, null);
  assert.equal(t.knownUnreconciledMinor, '17');
  assert.equal(t.knownAcceptedRiskMinor, '17');
  assert.equal(t.acceptedRiskUnknownCount, 1);
});
