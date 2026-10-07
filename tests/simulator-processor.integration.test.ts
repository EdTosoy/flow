import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, after, test } from 'node:test';
import { Pool } from 'pg';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { generateSimulation } from '@flow/simulator-oracle';
import { stableJson, type SystemInput } from '@flow/simulator';
import { PostgresIngestion } from '@flow/ingestion-postgres';
import { PostgresProcessor } from '@flow/processor-postgres';
import { simulatorBatch } from '../tools/ingestion-input';
import { simulatorSettlementBatch } from '../tools/processor-input';
const adminUrl = process.env['FLOW_TEST_ADMIN_URL'],
  url = process.env['FLOW_TEST_PROCESSOR_URL'],
  iu = process.env['FLOW_TEST_INGESTION_URL'];
if (!adminUrl || !url || !iu) throw new Error('Run pnpm test:integration');
const admin = new Pool({ connectionString: adminUrl }),
  pp = new Pool({ connectionString: url }),
  ip = new Pool({ connectionString: iu });
const ingestion = new PostgresIngestion(ip),
  processor = new PostgresProcessor(pp),
  bookId = randomUUID();
before(async () => {
  await admin.query(
    "INSERT INTO ledger.book(id,code,environment) VALUES($1,$2,'synthetic')",
    [bookId, 'sim-processor-' + bookId],
  );
});
after(async () => {
  await Promise.all([admin.end(), pp.end(), ip.end()]);
});
async function pipeline(input: SystemInput) {
  const aid = await ingestion.registerSource({
    bookId,
    environment: 'synthetic',
    provider: 'synthetic-simulator',
    externalAccountId: input.scope.processorAccountId + randomUUID(),
  });
  const m = await ingestion.ingest(simulatorBatch(input, aid, 'movements'));
  await ingestion.normalizeBatch(m.id);
  const activities = await processor.deriveBatch(m.id, 'synthetic-movement-v1');
  const s = await ingestion.ingest(
    simulatorSettlementBatch(input, aid, 'reports'),
  );
  await ingestion.requestNormalization(s.id, 'synthetic-settlement-v1', 'test');
  await ingestion.normalizeBatch(s.id, 'synthetic-settlement-v1');
  const batches = await processor.deriveBatch(s.id, 'synthetic-settlement-v1');
  const evaluated = [];
  for (const b of batches)
    evaluated.push({
      batch: b,
      evaluation: await processor.evaluate('settlement', b.id, 'first'),
    });
  return { aid, activities, batches, evaluated };
}
test('public simulator → ingestion → normalization → processor: full/partial refunds, chargebacks, explicit fees and N:1 settlements', async () => {
  const simulation = generateSimulation({
    seed: 70405,
    paymentCount: 30,
    fullRefundCount: 4,
    partialRefundCount: 5,
    chargebackCount: 3,
    batchSizeRange: [3, 8],
  });
  // SUT receives only public input; private oracle assertions follow the completed pipeline.
  const run = await pipeline(simulation.input);
  assert.equal(run.activities.length, simulation.oracle.activities.length);
  assert.equal(new Set(run.activities.map((a) => a.paymentId)).size, 30);
  assert.equal(run.batches.length, simulation.oracle.settlements.length);
  for (const { batch, evaluation } of run.evaluated) {
    const row = (
      await pp.query(
        'SELECT f.external_id,b.reported_net_minor::text AS net FROM processor.settlement_batch b JOIN ingestion.source_fact f ON f.id=b.fact_id WHERE b.id=$1',
        [batch.id],
      )
    ).rows[0];
    const truth = simulation.oracle.settlements.find(
      (s) => s.id === row.external_id,
    )!;
    assert.equal(evaluation.result.calculatedNetMinor, truth.net.amountMinor);
    assert.equal(row.net, truth.net.amountMinor);
    assert.deepEqual(evaluation.result.controls, []);
    const expected = simulation.oracle.activities
      .filter((a) => truth.componentIds.includes(a.id))
      .reduce((sum, a) => sum + BigInt(a.amount.amountMinor), 0n);
    assert.equal(BigInt(evaluation.result.calculatedNetMinor!), expected);
  }
  const states = [];
  for (const id of new Set(run.activities.map((a) => a.paymentId!)))
    states.push(
      (await processor.evaluate('payment', id, 'lifecycle')).result.lifecycle,
    );
  assert.equal(states.filter((s) => s === 'refunded').length, 4);
  assert.equal(states.filter((s) => s === 'partially_refunded').length, 5);
  assert.equal(states.filter((s) => s === 'charged_back').length, 3);
  assert.equal(
    (
      await admin.query(
        'SELECT count(*)::text AS n FROM ledger.ledger_transaction WHERE book_id=$1',
        [bookId],
      )
    ).rows[0].n,
    '0',
  );
});
test('public processor anomalies yield internal controls; duplicates preserve one interpretation and bank faults have no influence', async () => {
  for (const [kind, control] of [
    ['incorrect-amount', 'NET_MISMATCH'],
    ['unexpected-processor-fee', 'NET_MISMATCH'],
    ['missing-source-event', 'MISSING_ACTIVITY'],
    ['corrupted-source-record', 'PENDING_ACTIVITY'],
  ] as const) {
    const simulation = generateSimulation({
      seed: 70406,
      paymentCount: 10,
      anomalies: {
        [kind]: { count: 1 },
        'duplicate-source-event': { count: 2 },
        'duplicate-settlement': { count: 1 },
      },
    });
    const run = await pipeline(simulation.input);
    assert.ok(
      run.evaluated.some(
        (e) =>
          e.evaluation.result.controls.includes(control) ||
          e.evaluation.result.controls.includes('MISSING_ACTIVITY'),
      ),
    );
    assert.equal(
      new Set(run.activities.map((a) => a.id)).size,
      run.activities.length,
    );
    assert.equal(run.batches.length, simulation.oracle.settlements.length);
  }
  const input = generateSimulation({
    seed: 70407,
    paymentCount: 20,
    batchSizeRange: [3, 5],
    anomalies: {
      'missing-bank-transaction': { count: 1 },
      'wrong-reference': { count: 1 },
    },
  }).input;
  const run = await pipeline({
    ...input,
    bankObservations: [],
    internalExpectations: [],
    captureAttempts: [],
  });
  assert.ok(
    run.evaluated.every((e) => e.evaluation.result.controls.length === 0),
  );
});
test('generated public batch conservation property: 20 real DB trials seed 70408', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 0, max: 2147483647 }),
      fc.integer({ min: 1, max: 12 }),
      async (seed, n) => {
        const simulation = generateSimulation({
          seed,
          paymentCount: n,
          partialRefundCount: Math.floor(n / 3),
          chargebackCount: Math.floor(n / 4),
          batchSizeRange: [2, 5],
        });
        const run = await pipeline(simulation.input);
        for (const e of run.evaluated) {
          assert.deepEqual(e.evaluation.result.controls, []);
          assert.equal(
            e.evaluation.result.calculatedNetMinor,
            e.evaluation.result.reportedNetMinor,
          );
        }
      },
    ),
    { numRuns: 20, seed: 70408 },
  );
});
test('CLI prints only processor summary and unchanged keys reproduce frozen results across processes', async () => {
  const input = generateSimulation({
    seed: 70409,
    paymentCount: 8,
    partialRefundCount: 2,
  }).input;
  const dir = await mkdtemp(join(tmpdir(), 'flow-processor-cli-')),
    file = join(dir, 'input.json');
  await writeFile(file, stableJson(input) + '\n');
  const run = () =>
    promisify(execFile)(
      process.execPath,
      ['--import', 'tsx', 'tools/processor.ts', file, bookId, 'cli-run'],
      {
        env: {
          ...process.env,
          DATABASE_INGESTION_URL: iu,
          DATABASE_PROCESSOR_URL: url,
        },
      },
    );
  const first = await run(),
    second = await run();
  assert.equal(first.stdout, second.stdout);
  const summary = JSON.parse(first.stdout);
  assert.equal(summary.payments, 8);
  assert.equal(summary.processorActivities, 18);
  assert.equal(summary.settlementControlsFailed, 0);
  assert.ok(!first.stdout.includes('oracle'));
});
