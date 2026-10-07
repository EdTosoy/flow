import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { Pool } from 'pg';
import fc from 'fast-check';
import {
  generateSimulation,
  generateGroupedSimulation,
} from '@flow/simulator-oracle';
import type { SystemInput } from '@flow/simulator';
import { PostgresIngestion } from '@flow/ingestion-postgres';
import { PostgresProcessor } from '@flow/processor-postgres';
import { PostgresBank } from '@flow/bank-postgres';
import { PostgresReconciliation } from '@flow/reconciliation-postgres';
import { PostgresExceptions } from '@flow/exception-postgres';
import { PostgresControls } from '@flow/control-postgres';
import { importEvidence, money } from './helpers/reconciliation-fixture';
import { simulatorBatch } from '../tools/ingestion-input';
import { simulatorSettlementBatch } from '../tools/processor-input';
import { simulatorBankBatch } from '../tools/bank-input';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const admin = new Pool({
    connectionString: process.env['FLOW_TEST_ADMIN_URL'],
  }),
  rp = new Pool({
    connectionString: process.env['FLOW_TEST_RECONCILIATION_URL'],
  }),
  ip = new Pool({ connectionString: process.env['FLOW_TEST_INGESTION_URL'] }),
  pp = new Pool({ connectionString: process.env['FLOW_TEST_PROCESSOR_URL'] }),
  bp = new Pool({ connectionString: process.env['FLOW_TEST_BANK_URL'] }),
  ep = new Pool({ connectionString: process.env['FLOW_TEST_EXCEPTION_URL'] }),
  cp = new Pool({ connectionString: process.env['FLOW_TEST_CONTROL_URL'] });
if (!process.env['FLOW_TEST_CONTROL_URL'])
  throw new Error('Run pnpm test:integration');
const controls = new PostgresControls(cp),
  exceptions = new PostgresExceptions(ep);
after(async () => {
  await Promise.all([admin, rp, ip, pp, bp, ep, cp].map((p) => p.end()));
});
async function pipeline(input: SystemInput, grouped = false) {
  const book = randomUUID();
  await admin.query(
    "INSERT INTO ledger.book(id,code,environment) VALUES($1,$2,'synthetic')",
    [book, 'sim-recon-' + book],
  );
  const ingestion = new PostgresIngestion(ip),
    processor = new PostgresProcessor(pp),
    bank = new PostgresBank(bp),
    recon = new PostgresReconciliation(rp);
  const source = await ingestion.registerSource({
    bookId: book,
    environment: 'synthetic',
    provider: 'synthetic-simulator',
    externalAccountId: input.scope.processorAccountId,
  });
  const bankSource = await ingestion.registerSource({
    bookId: book,
    environment: 'synthetic',
    provider: 'synthetic-simulator-bank',
    externalAccountId: input.scope.bankAccountId,
  });
  const activities = await ingestion.ingest(
    simulatorBatch(input, source, 'activities'),
  );
  await ingestion.normalizeBatch(activities.id);
  await processor.deriveBatch(activities.id, 'synthetic-movement-v1');
  const reports = await ingestion.ingest(
    simulatorSettlementBatch(input, source, 'settlements'),
  );
  await ingestion.requestNormalization(
    reports.id,
    'synthetic-settlement-v1',
    'test',
  );
  await ingestion.normalizeBatch(reports.id, 'synthetic-settlement-v1');
  await processor.deriveBatch(reports.id, 'synthetic-settlement-v1');
  if (input.settlements.some((r) => r.payoutMemberIds)) {
    await ingestion.requestNormalization(
      reports.id,
      'synthetic-settlement-group-v1',
      'test',
    );
    await ingestion.normalizeBatch(reports.id, 'synthetic-settlement-group-v1');
  }
  const entries = await ingestion.ingest(
    simulatorBankBatch(input, bankSource, 'bank'),
  );
  await ingestion.requestNormalization(
    entries.id,
    'synthetic-bank-entry-v1',
    'test',
  );
  await ingestion.normalizeBatch(entries.id, 'synthetic-bank-entry-v1');
  await bank.deriveBatch(entries.id, 'synthetic-bank-entry-v1');
  const mappingId = (
    await admin.query(
      "INSERT INTO reconciliation.account_mapping(book_id,processor_source_account_id,bank_source_account_id,currency,reference_contract) VALUES($1,$2,$3,'PHP','synthetic-transfer-reference-v1') RETURNING id",
      [book, source, bankSource],
    )
  ).rows[0].id;
  const command = {
    mappingId,
    runKey: 'sim-group-run',
    ruleVersion: grouped
      ? ('settlement-bank-grouped-v1' as const)
      : ('settlement-bank-exact-v1' as const),
    from: '2026-01-01T00:00:00.000Z',
    to: '2026-01-10T00:00:00.000Z',
    effectiveAt: '2026-01-10T00:00:00.000Z',
    actorId: 'sim-runtime',
  };
  return {
    ingestion,
    bank,
    processor,
    book,
    source,
    bankSource,
    mappingId,
    recon,
    command,
    result: await recon.run(command),
  };
}
const evaluate = async (
  runtime: Awaited<ReturnType<typeof pipeline>>,
  key = randomUUID(),
) =>
  controls.run({
    bookId: runtime.book,
    runKey: key,
    actorId: 'public-runtime-control',
    reconciliationRunIds: [runtime.result.id],
    createCases: true,
  });
test('20 public simulator trials detect missing bank exposure; oracle is consulted only after runtime', async () => {
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 0, max: 4294967295 }), async (seed) => {
      const sim = generateSimulation({
          seed,
          paymentCount: 6,
          batchSizeRange: [1, 2],
          anomalies: { 'missing-bank-transaction': { count: 1 } },
        }),
        runtime = await pipeline(sim.input),
        s = await evaluate(runtime);
      const absent = sim.oracle.bank.find(
        (b) => !sim.input.bankObservations.some((x) => x.id === b.id),
      );
      assert(absent);
      const ex = s.results.find((r) => r.type === 'EXPOSURE')!;
      assert.equal(ex.status, 'FAIL');
      assert.equal(ex.observed, absent.amount.amountMinor);
      assert(s.cases.length > 0);
      const id = s.cases[0]!.caseId;
      let c = await exceptions.get(id);
      c = await exceptions.apply({
        caseId: id,
        expectedVersion: c.version,
        commandKey: 'review',
        action: 'START_REVIEW',
        actorId: 'operator',
        reason: 'Synthetic anomaly reviewed',
      });
      await exceptions.apply({
        caseId: id,
        expectedVersion: c.version,
        commandKey: 'risk',
        action: 'RESOLVE',
        resolution: 'ACCEPTED_RISK',
        actorId: 'operator',
        reason: 'Accepted documented risk, without financial match',
      });
      const risk = await evaluate(runtime);
      assert.equal(
        risk.exposure[0]!['acceptedRiskMinor'],
        absent.amount.amountMinor,
      );
      assert.equal(
        risk.exposure[0]!['unreconciledMinor'],
        absent.amount.amountMinor,
      );
    }),
    { numRuns: 20, seed: 70905 },
  );
});
test('public anomaly detector reports detectable processor/processing/exposure failures and no false positives on clean controls', async () => {
  const scenarios = [
    ['incorrect-amount', 'PROCESSOR'],
    ['missing-source-event', 'PROCESSOR'],
    ['missing-settlement', 'EXPOSURE'],
    ['corrupted-source-record', 'PROCESSING_COMPLETION'],
    ['duplicate-source-event', 'NONE'],
  ] as const;
  let detected = 0,
    expected = 0,
    falsePositives = 0;
  for (const [anomaly, type] of scenarios) {
    const sim = generateSimulation({
        seed: 70909,
        paymentCount: 12,
        batchSizeRange: [2, 3],
        anomalies: { [anomaly]: { count: 1 } },
      }),
      runtime = await pipeline(sim.input),
      s = await evaluate(runtime);
    if (type !== 'NONE') {
      expected++;
      const fired = s.results.some(
        (r) => r.type === type && r.status === 'FAIL',
      );
      assert(fired, anomaly);
      if (fired) detected++;
    } else
      falsePositives += s.results.filter(
        (r) =>
          [
            'SOURCE',
            'PROCESSOR',
            'PROCESSOR_TOTAL',
            'ALLOCATION',
            'EXPOSURE',
          ].includes(r.type) && r.status === 'FAIL',
      ).length;
    assert(
      s.results
        .filter((r) => r.type === 'PROCESSING_PARTITION')
        .every((r) => r.status === 'PASS'),
    );
  }
  assert.equal(detected, expected);
  assert.equal(falsePositives, 0);
  // Oracle labels exist only in this verifier's report, never in control inputs or CLI output.
  assert.deepEqual(
    {
      detectable: expected,
      fired: detected,
      missed: expected - detected,
      falsePositives,
    },
    { detectable: 4, fired: 4, missed: 0, falsePositives: 0 },
  );
});
test('dropped public source records fail independently supplied source assertion despite complete received processing', async () => {
  const sim = generateSimulation({
      seed: 70911,
      paymentCount: 10,
      batchSizeRange: [2, 3],
    }),
    runtime = await pipeline(sim.input);
  const delivered = {
    ...sim.input,
    processorEvents: sim.input.processorEvents.slice(2),
  };
  const b = await runtime.ingestion.ingest({
    ...simulatorBatch(delivered, runtime.source, 'independent-cut'),
    expectedCount: sim.input.processorEvents.length,
    manifestBytes: Buffer.from(
      'synthetic independent upstream physical-count assertion',
    ),
  });
  await runtime.ingestion.normalizeBatch(b.id);
  await runtime.processor.deriveBatch(b.id, 'synthetic-movement-v1');
  const s = await evaluate(runtime);
  assert.equal(
    s.results.find((r) => r.key === 'source:' + b.id)!.status,
    'FAIL',
  );
  assert.equal(
    s.results.find(
      (r) => r.key === 'partition:' + b.id + ':synthetic-movement-v1',
    )!.status,
    'PASS',
  );
});
test('public grouped ambiguity freezes unknown exposure; full grouped matches independently conserve allocations', async () => {
  const sim = generateGroupedSimulation(
    { seed: 70912, paymentCount: 8, batchSizeRange: [1, 1] },
    2,
  );
  const clean = await pipeline(sim.input, true),
    s = await evaluate(clean);
  assert(
    s.results
      .filter((r) => r.type === 'ALLOCATION')
      .every((r) => r.status === 'PASS'),
  );
  assert.equal(s.exposure[0]!['unreconciledMinor'], '0');
  const amb = {
    ...sim.input,
    bankObservations: [
      ...sim.input.bankObservations,
      { ...sim.input.bankObservations[0]!, id: 'other-bank' },
    ],
  };
  const runtime = await pipeline(amb, true),
    u = await evaluate(runtime);
  assert.equal(u.exposure[0]!['status'], 'UNKNOWN');
  assert(Number(u.exposure[0]!['unknownCount']) > 0);
});
test('all public individual matches survive unrelated independently inconsistent bank stock controls', async () => {
  const sim = generateSimulation({
      seed: 70913,
      paymentCount: 6,
      batchSizeRange: [2, 3],
    }),
    runtime = await pipeline(sim.input);
  await importEvidence(
    runtime.ingestion,
    runtime.bank,
    runtime.bankSource,
    'synthetic-bank-entry',
    'synthetic-bank-entry-v1',
    [
      {
        id: 'separate-stock-line',
        status: 'booked',
        bookedAt: '2026-01-03T00:00:00.000Z',
        amount: money('17'),
        transferReference: 'separate',
        statementReference: 'stock-report',
        lineIdentity: 'line',
      },
    ],
  );
  await importEvidence(
    runtime.ingestion,
    runtime.bank,
    runtime.bankSource,
    'synthetic-bank-statement',
    'synthetic-bank-statement-v1',
    [
      {
        id: 'stock-report',
        currency: 'PHP',
        reportedAt: '2026-01-04T00:00:00.000Z',
        opening: money('100'),
        closing: money('118'),
        expectedLineCount: 1,
        lineIds: ['line'],
      },
    ],
  );
  const s = await evaluate(runtime);
  assert(
    s.results.some(
      (r) =>
        r.type === 'BANK_TOTAL' && r.status === 'FAIL' && r.discrepancy === '1',
    ),
  );
  assert.equal(s.assurance, 'FAIL');
  assert.equal(
    (await runtime.recon.summary(runtime.result.id)).matchedGroups,
    runtime.result.matchedGroups,
  );
});
test('CLI public pipeline and summary remain deterministic and contain no private oracle labels', async () => {
  const sim = generateSimulation({
      seed: 70914,
      paymentCount: 6,
      batchSizeRange: [2, 3],
      anomalies: { 'missing-bank-transaction': { count: 1 } },
    }),
    runtime = await pipeline(sim.input),
    dir = await mkdtemp(join(tmpdir(), 'phase9-cli-')),
    input = join(dir, 'input.json');
  await writeFile(input, JSON.stringify(sim.input));
  const run = await promisify(execFile)(
    process.execPath,
    [
      '--import',
      'tsx',
      'tools/controls.ts',
      'pipeline',
      input,
      runtime.book,
      'cli-controls',
      runtime.mappingId,
      '2026-01-01T00:00:00.000Z',
      '2026-01-10T00:00:00.000Z',
    ],
    {
      env: {
        ...process.env,
        DATABASE_INGESTION_URL: process.env['FLOW_TEST_INGESTION_URL']!,
        DATABASE_PROCESSOR_URL: process.env['FLOW_TEST_PROCESSOR_URL']!,
        DATABASE_BANK_URL: process.env['FLOW_TEST_BANK_URL']!,
        DATABASE_RECONCILIATION_URL:
          process.env['FLOW_TEST_RECONCILIATION_URL']!,
        DATABASE_EXCEPTION_URL: process.env['FLOW_TEST_EXCEPTION_URL']!,
        DATABASE_CONTROL_URL: process.env['FLOW_TEST_CONTROL_URL']!,
      },
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  const parsed = JSON.parse(run.stdout);
  assert.equal(parsed.financialControls.state, 'COMPLETED');
  assert.equal(parsed.financialControls.assurance, 'FAIL');
  assert(
    !/oracle|groundTruth|injectedAnomalies|expectedMatches/.test(run.stdout),
  );
  const summary = await promisify(execFile)(
    process.execPath,
    [
      '--import',
      'tsx',
      'tools/controls.ts',
      'summary',
      parsed.financialControls.id,
    ],
    {
      env: {
        ...process.env,
        DATABASE_CONTROL_URL: process.env['FLOW_TEST_CONTROL_URL']!,
      },
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  assert.deepEqual(JSON.parse(summary.stdout), parsed.financialControls);
});
