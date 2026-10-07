import assert from 'node:assert/strict';
import { test } from 'node:test';
import fc from 'fast-check';
import { Money } from '@flow/money';
import { normalize } from '@flow/ingestion-domain';
import {
  evaluateGrouped,
  serializeCommand,
  GROUPED_RULE_VERSION,
  MAX_GROUP_SIZE,
  type GroupedInput,
} from '../src/index';
const pt = '2026-01-02T00:00:00.000Z',
  bt = '2026-01-03T00:00:00.000Z';
const processor = (
  id: string,
  amount: bigint,
  members: readonly string[] = ['a', 'b', 'c'],
  extra: Partial<GroupedInput> = {},
): GroupedInput => ({
  id,
  externalId: id,
  eligible: true,
  reference: 'transfer',
  amount: Money.of(amount, 'PHP'),
  time: pt,
  declarations: [members],
  ...extra,
});
const bank = (amount: bigint, id = 'bank') => ({
  id,
  eligible: true,
  reference: 'transfer',
  amount: Money.of(amount, 'PHP'),
  time: bt,
});
const sample = () => [
  processor('a', 400000n),
  processor('b', 300000n),
  processor('c', 270000n),
];
test('complete declared set conserves; no evidence, subsets, currency/direction/window/control/missing-member deviations never prove a group', () => {
  assert.ok(
    [...evaluateGrouped(sample(), [bank(970000n)]).outcomes.values()].every(
      (x) => x === 'MATCHED',
    ),
  );
  for (const p of [
    sample().map((x) => ({ ...x, declarations: [] })),
    sample().slice(0, 2),
    sample().map((x, i) => (i === 0 ? { ...x, eligible: false } : x)),
    sample().map((x, i) =>
      i === 0 ? { ...x, amount: Money.of(400000n, 'USD') } : x,
    ),
    sample().map((x, i) =>
      i === 0 ? { ...x, time: '2026-01-04T00:00:00.000Z' } : x,
    ),
    [...sample(), processor('extra', 1n, [], { declarations: [] })],
  ])
    assert.ok(
      ![...evaluateGrouped(p, [bank(970000n)]).outcomes.values()].includes(
        'MATCHED',
      ),
    );
  assert.equal(
    evaluateGrouped(sample(), [bank(969999n)]).outcomes.get('bank'),
    'UNMATCHED',
  );
  assert.equal(
    evaluateGrouped(sample(), [bank(-970000n)]).outcomes.get('bank'),
    'UNMATCHED',
  );
});
test('explicit competing groups and duplicate equal values remain distinct and ambiguous; duplicate bank candidates never tie-break', () => {
  const p = [
    processor('a', 1000n, ['a', 'c']),
    processor('b', 1000n, ['b', 'c']),
    processor('c', 2000n, [], {
      declarations: [
        ['a', 'c'],
        ['b', 'c'],
      ],
    }),
  ];
  assert.ok(
    [...evaluateGrouped(p, [bank(3000n)]).outcomes.values()].every(
      (x) => x === 'AMBIGUOUS',
    ),
  );
  assert.ok(
    [
      ...evaluateGrouped(sample(), [
        bank(970000n),
        bank(970000n, 'copy'),
      ]).outcomes.values(),
    ].every((x) => x === 'AMBIGUOUS'),
  );
  const equal = [
    processor('a', 1000n, ['a', 'b']),
    processor('b', 1000n, ['a', 'b']),
  ];
  assert.equal(
    evaluateGrouped(equal, [bank(2000n)]).candidates[0]!.processors.length,
    2,
  );
});
test('oversized explicit declarations refuse without truncation, and command identity pins the grouped rule', () => {
  const ids = Array.from({ length: MAX_GROUP_SIZE + 1 }, (_, i) => 'p' + i);
  const r = evaluateGrouped(
    ids.map((id) => processor(id, 1n, ids)),
    [bank(BigInt(ids.length))],
  );
  assert.ok([...r.outcomes.values()].every((x) => x === 'INELIGIBLE'));
  const command = {
    mappingId: 'mapping',
    runKey: 'run',
    from: pt,
    to: bt,
    effectiveAt: bt,
    actorId: 'actor',
    ruleVersion: GROUPED_RULE_VERSION as typeof GROUPED_RULE_VERSION,
  };
  assert.equal(
    JSON.parse(serializeCommand(command)).ruleVersion,
    GROUPED_RULE_VERSION,
  );
  assert.equal(serializeCommand(command), serializeCommand({ ...command }));
});
test('supplemental normalization preserves v1 financial meaning and rejects missing declarations', () => {
  const body = {
    id: 'a',
    transferReference: 'transfer',
    reportedAt: pt,
    componentIds: [],
    gross: { amountMinor: '9007199254740993', currency: 'PHP' },
    fees: { amountMinor: '0', currency: 'PHP' },
    refunds: { amountMinor: '0', currency: 'PHP' },
    chargebacks: { amountMinor: '0', currency: 'PHP' },
    net: { amountMinor: '9007199254740993', currency: 'PHP' },
    payoutMemberIds: ['a', 'b'],
  };
  const bytes = Buffer.from(JSON.stringify(body));
  const base = normalize(bytes, 'a', 'synthetic-settlement-v1'),
    group = normalize(bytes, 'a', 'synthetic-settlement-group-v1');
  assert.equal(group.state, 'NORMALIZED');
  if (group.state === 'NORMALIZED' && group.observation.type === 'settlement') {
    const { payoutMemberIds, ...financial } = group.observation;
    assert.deepEqual({ state: 'NORMALIZED', observation: financial }, base);
    assert.deepEqual(payoutMemberIds, ['a', 'b']);
  }
  assert.equal(
    normalize(
      Buffer.from(JSON.stringify({ ...body, payoutMemberIds: null })),
      'a',
      'synthetic-settlement-group-v1',
    ).state,
    'FAILED',
  );
});
test('500 generated whole-group conservation, permutation, deterministic replay, identity and no-double-consumption trials', () => {
  fc.assert(
    fc.property(
      fc.array(fc.bigInt({ min: 1n, max: 9007199254740993n }), {
        minLength: 2,
        maxLength: 12,
      }),
      (amounts) => {
        const ids = amounts.map((_, i) => 'p' + i),
          p = amounts.map((v, i) => processor(ids[i]!, v, ids)),
          total = amounts.reduce((a, b) => a + b, 0n),
          b = bank(total);
        const r = evaluateGrouped(p, [b]);
        assert.ok([...r.outcomes.values()].every((x) => x === 'MATCHED'));
        assert.equal(r.candidates[0]!.totalMinor, total.toString());
        assert.equal(new Set(r.candidates[0]!.processors).size, amounts.length);
        const reverse = evaluateGrouped([...p].reverse(), [b]);
        assert.deepEqual([...r.outcomes].sort(), [...reverse.outcomes].sort());
        assert.deepEqual(r.candidates, reverse.candidates);
        for (let i = 0; i < 3; i++)
          assert.deepEqual(evaluateGrouped(p, [b]), r);
      },
    ),
    { numRuns: 500, seed: 70701 },
  );
});
test('500 generated ambiguity safety and duplicate amount identity trials', () => {
  fc.assert(
    fc.property(fc.bigInt({ min: 1n, max: 1000000000000n }), (amount) => {
      const p = [
        processor('a', amount, ['a', 'b']),
        processor('b', amount, ['a', 'b']),
      ];
      const r = evaluateGrouped(p, [
        bank(amount * 2n),
        bank(amount * 2n, 'other'),
      ]);
      assert.ok([...r.outcomes.values()].every((x) => x === 'AMBIGUOUS'));
      assert.ok(
        !r.candidates.some((c) => r.outcomes.get(c.bank) === 'MATCHED'),
      );
    }),
    { numRuns: 500, seed: 70702 },
  );
});
test('declaration explosion refuses explicitly before accepting any group', () => {
  const p = Array.from({ length: 257 }, (_, i) =>
    processor('a' + i, 1n, ['a' + i, 'b' + i], { reference: 'r' + i }),
  );
  assert.throws(() => evaluateGrouped(p, []), /Unsupported grouped/);
});
test('same-direction debits conserve without unsigned shortcuts', () => {
  const p = [
    processor('a', -4000n, ['a', 'b']),
    processor('b', -3000n, ['a', 'b']),
  ];
  assert.ok(
    [...evaluateGrouped(p, [bank(-7000n)]).outcomes.values()].every(
      (x) => x === 'MATCHED',
    ),
  );
  assert.equal(
    evaluateGrouped(p, [bank(7000n)]).outcomes.get('bank'),
    'UNMATCHED',
  );
});
