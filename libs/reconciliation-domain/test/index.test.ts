import assert from 'node:assert/strict';
import { test } from 'node:test';
import fc from 'fast-check';
import { Money } from '@flow/money';
import {
  evaluate,
  evidence,
  serializeCommand,
  type RuleInput,
} from '../src/index';
const p: RuleInput = {
  id: 'p',
  eligible: true,
  reference: 'transfer',
  amount: Money.of(970000n, 'PHP'),
  time: '2026-01-02T00:00:00.000Z',
};
const b: RuleInput = { ...p, id: 'b', time: '2026-01-03T00:00:00.000Z' };
test('exact reference proof, signed direction, UTC window and missing evidence are conservative', () => {
  assert.equal(evaluate([p], [b]).get('p'), 'MATCHED');
  for (const changed of [
    { ...b, reference: 'other' },
    { ...b, reference: null },
    { ...b, amount: Money.of(969999n, 'PHP') },
    { ...b, amount: Money.of(970000n, 'USD') },
    { ...b, amount: Money.of(-970000n, 'PHP') },
    { ...b, time: '2026-01-01T23:59:59.999Z' },
    { ...b, time: '2026-01-05T00:00:00.001Z' },
  ])
    assert.equal(evaluate([p], [changed]).get('p'), 'UNMATCHED');
  assert.equal(
    evidence(p, { ...b, time: '2026-01-05T00:00:00.000Z' }).bookingWindowValid,
    true,
  );
  assert.equal(
    evaluate([p], [{ ...b, eligible: false }]).get('p'),
    'UNMATCHED',
  );
  assert.throws(() =>
    serializeCommand({
      mappingId: 'x',
      runKey: 'r',
      from: p.time,
      to: p.time,
      effectiveAt: p.time,
      actorId: 'a',
    }),
  );
  assert.throws(() => evaluate([p, p], [b]));
});
test('500 exact signed conservation and currency trials', () => {
  fc.assert(
    fc.property(
      fc
        .bigInt({ min: -9223372036854775807n, max: 9223372036854775807n })
        .filter((n) => n !== 0n),
      fc.constantFrom('PHP' as const, 'USD' as const),
      (amount, currency) => {
        const left = { ...p, amount: Money.of(amount, currency) },
          right = { ...b, amount: Money.of(amount, currency) };
        assert.equal(evaluate([left], [right]).get('p'), 'MATCHED');
        assert.ok(evidence(left, right).amountExact);
        assert.equal(
          evaluate(
            [left],
            [{ ...right, amount: Money.of(-amount, currency) }],
          ).get('p'),
          'UNMATCHED',
        );
      },
    ),
    { numRuns: 500, seed: 70601 },
  );
});
test('500 ambiguity/identity stability trials never break ties or hide ineligible reference competition', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 2, max: 12 }),
      fc.boolean(),
      (n, eligible) => {
        const banks = Array.from({ length: n }, (_, i) => ({
          ...b,
          id: 'b' + i,
          eligible: i === 0 ? eligible : true,
        }));
        const r = evaluate([p], banks);
        assert.equal(r.get('p'), 'AMBIGUOUS');
        assert.ok([...r.values()].every((x) => x !== 'MATCHED'));
        assert.deepEqual(
          [...r].sort(),
          [...evaluate([p], banks.toReversed())].sort(),
        );
        assert.deepEqual([...r].sort(), [...evaluate([p], banks)].sort());
      },
    ),
    { numRuns: 500, seed: 70602 },
  );
});
test('500 population permutation, exact uniqueness and independent-currency trials', () => {
  fc.assert(
    fc.property(
      fc.array(fc.integer({ min: 1, max: 100000 }), {
        minLength: 0,
        maxLength: 15,
      }),
      (amounts) => {
        const ps = amounts.map((a, i) => ({
          ...p,
          id: 'p' + i,
          reference: 'ref' + i,
          amount: Money.of(BigInt(a), 'PHP'),
        }));
        const bs = amounts.map((a, i) => ({
          ...b,
          id: 'b' + i,
          reference: 'ref' + i,
          amount: Money.of(BigInt(a), 'PHP'),
        }));
        const results = evaluate(ps, bs);
        assert.ok([...results.values()].every((x) => x === 'MATCHED'));
        assert.deepEqual(
          [...results].sort(),
          [...evaluate(ps.toReversed(), bs.toReversed())].sort(),
        );
      },
    ),
    { numRuns: 500, seed: 70603 },
  );
});
