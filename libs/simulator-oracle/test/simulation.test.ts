import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fc from 'fast-check';
import { stableJson, sha256, type ProcessorActivity } from '@flow/simulator';
import {
  generateSimulation,
  resolveConfig,
  ANOMALY_KINDS,
  type Simulation,
  type AnomalyKind,
} from '../src';
import { Random } from '../src/random';

const base = {
  seed: 828192,
  paymentCount: 60,
  batchSizeRange: [4, 8] as const,
  fullRefundCount: 5,
  partialRefundCount: 7,
  chargebackCount: 3,
};
function consistent(s: Simulation): void {
  const allIds = [
    ...s.oracle.payments.map((p) => p.id),
    ...s.oracle.activities.map((a) => a.id),
    ...s.oracle.settlements.map((b) => b.id),
    ...s.oracle.bank.map((b) => b.id),
    ...s.input.internalExpectations.map((e) => e.id),
  ];
  assert.equal(new Set(allIds).size, allIds.length);
  const activities = new Map(s.oracle.activities.map((a) => [a.id, a]));
  const assigned = new Set<string>();
  for (const batch of s.oracle.settlements) {
    const totals = { capture: 0n, fee: 0n, refund: 0n, chargeback: 0n };
    for (const id of batch.componentIds) {
      assert(!assigned.has(id));
      assigned.add(id);
      const a = activities.get(id)!;
      assert(a);
      assert.equal(a.amount.currency, 'PHP');
      const amount = BigInt(a.amount.amountMinor);
      assert(a.kind === 'capture' ? amount > 0n : amount <= 0n);
      totals[a.kind] += amount;
      assert(Date.parse(a.occurredAt) < Date.parse(batch.reportedAt));
    }
    assert.equal(BigInt(batch.gross.amountMinor), totals.capture);
    assert.equal(BigInt(batch.fees.amountMinor), -totals.fee);
    assert.equal(BigInt(batch.refunds.amountMinor), -totals.refund);
    assert.equal(BigInt(batch.chargebacks.amountMinor), -totals.chargeback);
    const expected =
      totals.capture + totals.fee + totals.refund + totals.chargeback;
    assert.equal(BigInt(batch.net.amountMinor), expected);
    const banks = s.oracle.bank.filter(
      (b) => b.transferReference === batch.transferReference,
    );
    assert.equal(banks.length, expected === 0n ? 0 : 1);
    if (banks[0]) {
      assert.equal(BigInt(banks[0].amount.amountMinor), expected);
      assert(Date.parse(banks[0].bookedAt) > Date.parse(batch.reportedAt));
    }
  }
  assert.equal(assigned.size, activities.size);
  for (const p of s.oracle.payments) {
    const capture = activities.get(p.captureActivityId)!;
    const fee = activities.get(p.feeActivityId)!;
    const gross = BigInt(capture.amount.amountMinor);
    assert.equal(
      -BigInt(fee.amount.amountMinor),
      (gross * BigInt(s.oracle.replay.feeBasisPoints)) / 10000n +
        BigInt(s.oracle.replay.feeFixedMinor),
    );
    const adjustment = p.adjustmentActivityId
      ? activities.get(p.adjustmentActivityId)!
      : null;
    const debit = adjustment ? -BigInt(adjustment.amount.amountMinor) : 0n;
    assert(debit >= 0n && debit <= gross);
    if (p.adjustmentKind === 'partial-refund')
      assert(debit > 0n && debit < gross);
    if (p.adjustmentKind === 'full-refund' || p.adjustmentKind === 'chargeback')
      assert.equal(debit, gross);
    assert.equal(BigInt(p.refundableRemaining.amountMinor), gross - debit);
    const batch = s.oracle.settlements.find((b) => b.id === p.settlementId)!;
    assert(batch.componentIds.includes(capture.id));
    assert(batch.componentIds.includes(fee.id));
    if (adjustment) assert(batch.componentIds.includes(adjustment.id));
  }
}
test('deterministic identity, byte output, explicit seed, differentiated seeds and normalized defaults', () => {
  const first = generateSimulation(base);
  for (let i = 0; i < 5; i++)
    assert.equal(stableJson(generateSimulation(base)), stableJson(first));
  assert.equal(
    stableJson(generateSimulation(resolveConfig(base))),
    stableJson(first),
  );
  const other = generateSimulation({ ...base, seed: base.seed + 1 });
  assert.notEqual(first.manifest.inputSha256, other.manifest.inputSha256);
  assert.notDeepEqual(
    first.oracle.payments.map((p) => p.gross),
    other.oracle.payments.map((p) => p.gross),
  );
  assert.equal(first.manifest.inputSha256, sha256(stableJson(first.input)));
  assert.equal(
    first.manifest.configurationSha256,
    sha256(stableJson(first.oracle.replay)),
  );
  assert(Object.isFrozen(first.oracle.activities[0]));
  assert.throws(() => generateSimulation({ paymentCount: 1 } as never), /seed/);
  consistent(first);
});
test('configuration rejects unsupported version, inexact money, invalid time, overlap and impossible counts', () => {
  for (const override of [
    { version: 'future' },
    { seed: -1 },
    { seed: 1.1 },
    { seed: 2 ** 32 },
    { paymentCount: 0 },
    { startTime: '2026-01-01' },
    { startTime: '2026-02-30T00:00:00.000Z' },
    { amountMinorRange: ['1', '20'] },
    { amountMinorRange: ['1.5', '20'] },
    { amountMinorRange: [9007199254740992, 9007199254740994] },
    { feeFixedMinor: 10 },
    { amountMinorRange: ['2', '9223372036854775807'], batchSizeRange: [2, 2] },
    { feeFixedMinor: '999999999' },
    { feeBasisPoints: 300.5 },
    { fullRefundCount: 60, partialRefundCount: 1 },
    { anomalies: { invalid: { count: 1 } } },
    { anomalies: { 'duplicate-source-event': { count: 999 } } },
    { anomalies: { 'duplicate-source-event': { count: 2, placements: [0] } } },
    { anomalies: { 'duplicate-source-event': { placements: [0, 0] } } },
    {
      anomalies: {
        'duplicate-source-event': { placements: [0] },
        'missing-source-event': { placements: [0] },
      },
    },
  ])
    assert.throws(() => generateSimulation({ ...base, ...override } as never));
});
test('large exact money and signed negative/zero settlements retain fees on full refunds', () => {
  const large = generateSimulation({
    seed: 0,
    paymentCount: 2,
    batchSizeRange: [2, 2],
    amountMinorRange: ['9007199254740993', '9007199254740993'],
    partialRefundCount: 1,
  });
  consistent(large);
  assert.equal(large.oracle.payments[0]!.gross.amountMinor, '9007199254740993');
  const negative = generateSimulation({
    seed: 1,
    paymentCount: 2,
    fullRefundCount: 2,
    batchSizeRange: [2, 2],
  });
  consistent(negative);
  assert(BigInt(negative.oracle.bank[0]!.amount.amountMinor) < 0n);
  const zero = generateSimulation({
    seed: 1,
    paymentCount: 1,
    fullRefundCount: 1,
    feeBasisPoints: 0,
  });
  consistent(zero);
  assert.equal(zero.oracle.settlements[0]!.net.amountMinor, '0');
  assert.equal(zero.input.bankObservations.length, 0);
  assert.throws(() =>
    generateSimulation({
      ...zero.oracle.replay,
      anomalies: { 'missing-bank-transaction': { count: 1 } },
    }),
  );
});
for (const kind of ANOMALY_KINDS)
  test(`anomaly: ${kind} has exactly two independently inspectable faults without changing economics`, () => {
    const clean = generateSimulation(base);
    const s = generateSimulation({
      ...base,
      anomalies: { [kind]: { count: 2 } },
    });
    assert.equal(s.oracle.anomalies.length, 2);
    assert.equal(new Set(s.oracle.anomalies.map((a) => a.id)).size, 2);
    for (const key of [
      'payments',
      'activities',
      'settlements',
      'bank',
      'expectedCaptureEffects',
    ] as const)
      assert.deepEqual(s.oracle[key], clean.oracle[key]);
    assert.equal(
      stableJson(generateSimulation(s.oracle.replay)),
      stableJson(s),
    );
    consistent(s);
    for (const a of s.oracle.anomalies) {
      assert.equal(a.kind, kind);
      assert(a.expectedControl.length > 10);
      assert(a.before);
      if (kind.startsWith('missing')) {
        assert.equal(a.after, null);
        assert.deepEqual(a.observedIds, []);
      }
      if (kind.startsWith('duplicate')) {
        assert.equal((a.after as unknown[]).length, 2);
        assert.equal(a.observedIds.length, 2);
      }
      if (kind === 'incorrect-amount' || kind === 'unexpected-processor-fee') {
        const before = a.before as { payload: string };
        const after = a.after as { payload: string };
        const b = JSON.parse(before.payload) as ProcessorActivity;
        const c = JSON.parse(after.payload) as ProcessorActivity;
        assert.equal(
          BigInt(c.amount.amountMinor) - BigInt(b.amount.amountMinor),
          BigInt(a.discrepancy!.amountMinor),
        );
      }
      if (kind === 'corrupted-source-record')
        assert.throws(() =>
          JSON.parse((a.after as { payload: string }).payload),
        );
      if (kind === 'delayed-event' || kind === 'out-of-order-event') {
        const b = a.before as { occurredAt: string; deliveredAt: string };
        const c = a.after as typeof b;
        assert.equal(c.occurredAt, b.occurredAt);
        assert(c.deliveredAt > b.deliveredAt);
        if (kind === 'delayed-event')
          assert.equal(
            Date.parse(c.deliveredAt) - Date.parse(b.deliveredAt),
            s.oracle.replay.delayMilliseconds,
          );
        else
          assert(
            c.deliveredAt > clean.input.processorEvents.at(-1)!.deliveredAt,
          );
      }
      if (kind === 'wrong-reference')
        assert.notEqual(
          (a.before as { transferReference: string }).transferReference,
          (a.after as { transferReference: string }).transferReference,
        );
    }
    if (kind === 'duplicate-ledger-command') {
      const attempts = s.input.captureAttempts;
      assert.equal(
        new Set(attempts.map((a) => a.commandKey)).size,
        base.paymentCount,
      );
      assert.equal(attempts.length, base.paymentCount + 2);
    }
  });
test('explicit placements and mixed corruption preserve hidden truth and do not leak fault annotations', () => {
  const anomalies = Object.fromEntries(
    ANOMALY_KINDS.map((kind) => [kind, { count: 2 }]),
  );
  const mixed = generateSimulation({ ...base, anomalies });
  assert.equal(mixed.oracle.anomalies.length, 28);
  consistent(mixed);
  const explicit = generateSimulation({
    ...base,
    anomalies: {
      'incorrect-amount': { placements: [0, 3] },
      'duplicate-source-event': { count: 10 },
      'missing-source-event': { count: 4 },
    },
  });
  assert.equal(explicit.oracle.anomalies.length, 16);
  const targets = explicit.oracle.activities.filter(
    (a) => a.kind === 'capture',
  );
  for (const [j, a] of explicit.oracle.anomalies
    .filter((a) => a.kind === 'incorrect-amount')
    .entries())
    assert.equal(
      (
        JSON.parse(
          (a.before as { payload: string }).payload,
        ) as ProcessorActivity
      ).id,
      targets[[0, 3][j]!]!.id,
    );
  const text = stableJson({
    input: explicit.input,
    manifest: explicit.manifest,
  });
  for (const hidden of [
    'expectedControl',
    'canonicalIndex',
    'observedIds',
    'placements',
    'expectedCaptureEffects',
    'refundableRemaining',
  ])
    assert(!text.includes(`"${hidden}"`));
});
test('independent clean processes replay byte-for-byte across timezone settings and reject artifact overlap', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'flow-simulator-replay-'));
  const configPath = path.join(dir, 'config.json');
  writeFileSync(
    configPath,
    stableJson({
      ...base,
      anomalies: { 'incorrect-amount': { placements: [0, 3] } },
    }),
  );
  const run = (args: string[], tz: string) =>
    execFileSync(
      process.execPath,
      ['--import', 'tsx', 'tools/simulator.ts', ...args],
      { cwd: process.cwd(), env: { ...process.env, TZ: tz }, encoding: 'utf8' },
    );
  const first = run(
    [
      'generate',
      '--config',
      configPath,
      '--out',
      path.join(dir, 'public'),
      '--oracle-out',
      path.join(dir, 'private'),
    ],
    'Asia/Manila',
  );
  const second = run(
    [
      'replay',
      '--replay',
      path.join(dir, 'private/oracle.json'),
      '--out',
      path.join(dir, 'replayed'),
    ],
    'America/New_York',
  );
  assert.equal(first, second);
  for (const file of ['input.json', 'manifest.json'])
    assert.equal(
      readFileSync(path.join(dir, 'public', file), 'utf8'),
      readFileSync(path.join(dir, 'replayed', file), 'utf8'),
    );
  assert(!first.includes('oracle'));
  assert(!first.includes('anomalies'));
  assert.throws(
    () =>
      run(
        [
          'generate',
          '--seed',
          '1',
          '--payments',
          '2',
          '--out',
          path.join(dir, 'overlap'),
          '--oracle-out',
          path.join(dir, 'overlap/private'),
        ],
        'UTC',
      ),
    /disjoint/,
  );
  assert.throws(
    () =>
      run(
        [
          'generate',
          '--seed',
          '1',
          '--payments',
          '2',
          '--out',
          path.join(dir, 'public'),
        ],
        'UTC',
      ),
    /EEXIST/,
  );
});
test('property: exact economics, unique identities and complete batches across 500 scenarios', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: 0xffffffff }),
      fc.integer({ min: 1, max: 80 }),
      fc.integer({ min: 1, max: 15 }),
      (seed, n, batch) => {
        const s = generateSimulation({
          seed,
          paymentCount: n,
          batchSizeRange: [1, batch],
          fullRefundCount: Math.floor(n / 5),
          partialRefundCount: Math.floor(n / 4),
          chargebackCount: Math.floor(n / 6),
        });
        consistent(s);
        assert.equal(s.oracle.anomalies.length, 0);
      },
    ),
    { numRuns: 500, seed: 70201 },
  );
});
test('property: deterministic replay of valid configurations across 500 scenarios', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: 0xffffffff }),
      fc.integer({ min: 1, max: 40 }),
      (seed, n) => {
        const s = generateSimulation({
          seed,
          paymentCount: n,
          partialRefundCount: Math.floor(n / 3),
          anomalies: { 'duplicate-source-event': { count: Math.min(n, 3) } },
        });
        assert.equal(
          stableJson(s),
          stableJson(generateSimulation(s.oracle.replay)),
        );
      },
    ),
    { numRuns: 500, seed: 70202 },
  );
});
test('property: N faults mean N oracle entries and exact delivered count deltas across 500 scenarios', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: 0xffffffff }),
      fc.integer({ min: 0, max: 15 }),
      fc.constantFrom<AnomalyKind>(
        'duplicate-source-event',
        'missing-source-event',
        'duplicate-ledger-command',
        'missing-ledger-posting',
      ),
      (seed, count, kind) => {
        const s = generateSimulation({
          seed,
          paymentCount: 15,
          anomalies: { [kind]: { count } },
        });
        assert.equal(s.oracle.anomalies.length, count);
        assert.equal(new Set(s.oracle.anomalies.map((a) => a.id)).size, count);
        const initial = kind.includes('ledger') ? 15 : 30;
        const actual = kind.includes('ledger')
          ? s.input.captureAttempts.length
          : s.input.processorEvents.length;
        assert.equal(
          actual,
          initial + (kind.startsWith('duplicate') ? count : -count),
        );
      },
    ),
    { numRuns: 500, seed: 70203 },
  );
});
test('property: range bounds and distinct sparse selection across 500 trials', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: 0xffffffff }),
      fc.integer({ min: 1, max: 100 }),
      (seed, size) => {
        const rng = new Random(seed, 'test');
        const picks = rng.sample(size, size);
        assert.equal(new Set(picks).size, size);
        assert(picks.every((p) => p >= 0 && p < size));
        const amount = rng.bigint(9007199254740993n, 9223372036854775807n);
        assert(amount >= 9007199254740993n && amount <= 9223372036854775807n);
      },
    ),
    { numRuns: 500, seed: 70204 },
  );
});

test('v1 golden artifacts and PRNG vector guard historical compatibility', () => {
  const s = generateSimulation({
    seed: 828192,
    paymentCount: 12,
    batchSizeRange: [3, 5],
    fullRefundCount: 2,
    partialRefundCount: 3,
    chargebackCount: 1,
    anomalies: {
      'incorrect-amount': { placements: [0, 3] },
      'duplicate-source-event': { count: 2 },
      'missing-ledger-posting': { placements: [1] },
    },
  });
  assert.equal(
    s.manifest.inputSha256,
    'fa870c7b1d71bc13a417a1455c19b78960f6dd49b0091738ec23ed9a09f40db0',
  );
  assert.equal(
    sha256(stableJson(s.oracle)),
    '7d4aba26bb4b38129261e4f7c714124b8b8bdc3a1d232f1683a9361d6418f07e',
  );
  const rng = new Random(0, 'economics');
  assert.deepEqual(
    Array.from({ length: 6 }, () => rng.next()),
    [459643361, 2741261421, 349565881, 4277296104, 74392783, 4263518772],
  );
});
test('explicit counts inject exactly ten duplicates and four amount mismatches', () => {
  const s = generateSimulation({
    ...base,
    anomalies: {
      'duplicate-source-event': { count: 10 },
      'incorrect-amount': { count: 4 },
    },
  });
  assert.equal(
    s.oracle.anomalies.filter((a) => a.kind === 'duplicate-source-event')
      .length,
    10,
  );
  assert.equal(
    s.oracle.anomalies.filter((a) => a.kind === 'incorrect-amount').length,
    4,
  );
});
