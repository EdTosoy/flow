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
import { importEvidence, entry } from './helpers/reconciliation-fixture';
import { simulatorBatch } from '../tools/ingestion-input';
import { simulatorSettlementBatch } from '../tools/processor-input';
import { simulatorBankBatch } from '../tools/bank-input';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const au = process.env['FLOW_TEST_ADMIN_URL'],
  ru = process.env['FLOW_TEST_RECONCILIATION_URL'],
  iu = process.env['FLOW_TEST_INGESTION_URL'],
  pu = process.env['FLOW_TEST_PROCESSOR_URL'],
  bu = process.env['FLOW_TEST_BANK_URL'];
if (!au || !ru || !iu || !pu || !bu)
  throw new Error('Run pnpm test:integration');
const admin = new Pool({ connectionString: au }),
  rp = new Pool({ connectionString: ru }),
  ip = new Pool({ connectionString: iu }),
  pp = new Pool({ connectionString: pu }),
  bp = new Pool({ connectionString: bu }),
  ep = new Pool({ connectionString: process.env['FLOW_TEST_EXCEPTION_URL'] });
const exceptions = new PostgresExceptions(ep);
after(async () => {
  await Promise.all([
    admin.end(),
    rp.end(),
    ip.end(),
    pp.end(),
    bp.end(),
    ep.end(),
  ]);
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
async function cases(input: SystemInput, grouped = false) {
  const runtime = await pipeline(input, grouped),
    ids = await exceptions.generate(runtime.result.id, 'exception-runtime');
  return {
    ...runtime,
    ids,
    views: await Promise.all(ids.map((id) => exceptions.get(id))),
  };
}
test('20 generated public-pipeline trials: injected missing movement creates one exact case, risk never reconciles, oracle stays test-only', async () => {
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 0, max: 4294967295 }), async (seed) => {
      const simulation = generateSimulation({
        seed,
        paymentCount: 6,
        batchSizeRange: [1, 2],
        anomalies: { 'missing-bank-transaction': { count: 1 } },
      });
      const runtime = await cases(simulation.input);
      assert.equal(runtime.ids.length, 1);
      const c = runtime.views[0]!;
      assert.equal(c.classification, 'MISSING_BANK_MOVEMENT');
      // Only the evaluator consults canonical hidden truth, after runtime completed.
      const missing = simulation.oracle.bank.find(
        (b) => !simulation.input.bankObservations.some((x) => x.id === b.id),
      );
      assert(missing);
      assert.equal(c.exposure?.amountMinor, missing.amount.amountMinor);
      const review = await exceptions.apply({
        caseId: c.id,
        expectedVersion: c.version,
        commandKey: 'review',
        actorId: 'synthetic-reviewer',
        reason: 'Synthetic public evidence inspected',
        action: 'START_REVIEW',
      });
      const resolve = {
        caseId: c.id,
        expectedVersion: review.version,
        commandKey: 'risk',
        actorId: 'synthetic-reviewer',
        reason: 'Synthetic business risk accepted',
        action: 'RESOLVE' as const,
        resolution: 'ACCEPTED_RISK' as const,
      };
      const resolved = await exceptions.apply(resolve);
      assert.equal(resolved.currentlyReconciled, false);
      assert.deepEqual(await exceptions.apply(resolve), resolved);
      assert.equal(
        (await runtime.recon.summary(runtime.result.id)).matchedGroups,
        simulation.oracle.bank.length - 1,
      );
      assert.equal(
        (await exceptions.summary(runtime.mappingId)).exposure.find(
          (x) => x.side === 'PROCESSOR',
        )!.acceptedRiskMinor,
        missing.amount.amountMinor,
      );
    }),
    { seed: 70804, numRuns: 20 },
  );
});
test('public missing/extra/mismatch/ambiguous/control-failed and grouped-ambiguous observations create explicit runtime cases', async () => {
  const sim = generateSimulation({
      seed: 70805,
      paymentCount: 3,
      batchSizeRange: [1, 1],
    }),
    base = sim.input,
    b = base.bankObservations[0]!;
  const scenarios: [SystemInput, string][] = [
    [
      { ...base, bankObservations: base.bankObservations.slice(1) },
      'MISSING_BANK_MOVEMENT',
    ],
    [
      {
        ...base,
        bankObservations: [
          ...base.bankObservations,
          { ...b, id: 'extra-bank', transferReference: 'unknown-transfer' },
        ],
      },
      'EXTRA_BANK_MOVEMENT',
    ],
    [
      {
        ...base,
        bankObservations: [
          {
            ...b,
            amount: {
              ...b.amount,
              amountMinor: (BigInt(b.amount.amountMinor) + 1n).toString(),
            },
          },
          ...base.bankObservations.slice(1),
        ],
      },
      'AMOUNT_MISMATCH',
    ],
    [
      {
        ...base,
        bankObservations: [
          ...base.bankObservations,
          { ...b, id: 'competing-bank' },
        ],
      },
      'AMBIGUOUS_MATCH',
    ],
    [
      {
        ...base,
        bankObservations: [{ ...b, id: 'observation-only' }],
        settlements: base.settlements.map((s) => ({
          ...s,
          componentIds: [...s.componentIds, 'missing-source-activity'],
        })),
      },
      'PROCESSOR_INCONSISTENCY',
    ],
  ];
  for (const [input, classification] of scenarios) {
    const runtime = await cases(input);
    assert(
      runtime.views.some((c) => c.classification === classification),
      classification,
    );
  }
  const g = generateGroupedSimulation(
      { seed: 70806, paymentCount: 6, batchSizeRange: [1, 1] },
      3,
    ),
    gb = g.input.bankObservations[0]!;
  const grouped = await cases(
    {
      ...g.input,
      bankObservations: [
        ...g.input.bankObservations,
        { ...gb, id: 'grouped-competing-bank' },
      ],
    },
    true,
  );
  assert(grouped.views.some((c) => c.classification === 'AMBIGUOUS_MATCH'));
  assert(
    grouped.views
      .filter((c) => c.classification === 'AMBIGUOUS_MATCH')
      .every((c) => c.exposure === null),
  );
  const ineligible = await cases(base);
  await importEvidence(
    ineligible.ingestion,
    ineligible.bank,
    ineligible.bankSource,
    'synthetic-bank-entry',
    'synthetic-bank-entry-v1',
    [
      {
        ...entry(null, b.amount.amountMinor, 'observation-only'),
        bookedAt: b.bookedAt,
      },
    ],
  );
  const run = await ineligible.recon.run({
    ...ineligible.command,
    runKey: 'unidentified',
  });
  const ids = await exceptions.generate(run.id, 'runtime');
  assert(
    (await Promise.all(ids.map((id) => exceptions.get(id)))).some(
      (c) => c.classification === 'UNSUPPORTED_CASE',
    ),
  );
});
test('public late arrival and bank-internal control failure retain case history and later evidence', async () => {
  const simulation = generateSimulation({
      seed: 70807,
      paymentCount: 3,
      batchSizeRange: [1, 1],
    }),
    input = simulation.input,
    b = input.bankObservations[0]!;
  const runtime = await cases({
      ...input,
      bankObservations: input.bankObservations.slice(1),
    }),
    c = runtime.views[0]!;
  const original = (
    await admin.query(
      'SELECT condition FROM exceptions.occurrence WHERE case_id=$1',
      [c.id],
    )
  ).rows;
  await importEvidence(
    runtime.ingestion,
    runtime.bank,
    runtime.bankSource,
    'synthetic-bank-entry',
    'synthetic-bank-entry-v1',
    [{ ...b }],
  );
  const later = await runtime.recon.run({
    ...runtime.command,
    runKey: 'late-arrival',
  });
  assert.equal(later.matchedGroups, simulation.oracle.bank.length);
  assert.equal((await exceptions.get(c.id)).state, 'OPEN');
  assert.equal((await exceptions.get(c.id)).currentlyReconciled, true);
  assert.deepEqual(
    (
      await admin.query(
        'SELECT condition FROM exceptions.occurrence WHERE case_id=$1',
        [c.id],
      )
    ).rows,
    original,
  );
  await importEvidence(
    runtime.ingestion,
    runtime.bank,
    runtime.bankSource,
    'synthetic-bank-entry',
    'synthetic-bank-entry-v1',
    [{ ...b, statementReference: 'statement', lineIdentity: 'line' }],
  );
  await importEvidence(
    runtime.ingestion,
    runtime.bank,
    runtime.bankSource,
    'synthetic-bank-statement',
    'synthetic-bank-statement-v1',
    [
      {
        id: 'statement',
        currency: 'PHP',
        reportedAt: '2026-01-05T00:00:00.000Z',
        opening: { amountMinor: '0', currency: 'PHP' },
        closing: { amountMinor: '1', currency: 'PHP' },
        expectedLineCount: 0,
      },
    ],
  );
  const failed = await runtime.recon.run({
    ...runtime.command,
    runKey: 'bank-control-failure',
  });
  const ids = await exceptions.generate(failed.id, 'runtime');
  assert(
    (await Promise.all(ids.map((id) => exceptions.get(id)))).some(
      (c) =>
        c.classification === 'SOURCE_REVISION_AMBIGUITY' ||
        c.classification === 'BANK_INCONSISTENCY',
    ),
  );
});
test('independent bank statement failure on generated public entries creates bank inconsistency cases', async () => {
  const simulation = generateSimulation({
    seed: 70809,
    paymentCount: 2,
    batchSizeRange: [1, 1],
  });
  const entries = simulation.input.bankObservations.map((b, i) => ({
    ...b,
    statementReference: 'bad-statement',
    lineIdentity: 'line-' + i,
  }));
  const runtime = await pipeline({
    ...simulation.input,
    bankObservations: entries,
  });
  const statement = (
    await importEvidence(
      runtime.ingestion,
      runtime.bank,
      runtime.bankSource,
      'synthetic-bank-statement',
      'synthetic-bank-statement-v1',
      [
        {
          id: 'bad-statement',
          currency: 'PHP',
          reportedAt: '2026-01-05T00:00:00.000Z',
          opening: { amountMinor: '0', currency: 'PHP' },
          closing: { amountMinor: '1', currency: 'PHP' },
          expectedLineCount: entries.length,
          lineIds: entries.map((_, i) => 'line-' + i),
        },
      ],
    )
  )[0]!;
  const evaluation = await runtime.bank.evaluate(statement.id, 'bad-statement');
  assert(evaluation.result.controls.includes('CLOSING_BALANCE_MISMATCH'));
  const run = await runtime.recon.run({
      ...runtime.command,
      runKey: 'bank-control-failure',
    }),
    ids = await exceptions.generate(run.id, 'runtime');
  const views = await Promise.all(ids.map((id) => exceptions.get(id)));
  assert(views.some((c) => c.classification === 'BANK_INCONSISTENCY'));
  assert(
    views
      .filter((c) => c.classification === 'BANK_INCONSISTENCY')
      .every((c) => c.exposure === null),
  );
});
test('developer exception CLI composes public pipeline, supports review/risk resolution and never prints private truth', async () => {
  const simulation = generateSimulation({
      seed: 70808,
      paymentCount: 3,
      batchSizeRange: [1, 1],
      anomalies: { 'missing-bank-transaction': { count: 1 } },
    }),
    runtime = await pipeline(simulation.input);
  const dir = await mkdtemp(join(tmpdir(), 'flow-exception-cli-')),
    path = join(dir, 'input.json');
  await writeFile(path, JSON.stringify(simulation.input));
  const env = {
    ...process.env,
    DATABASE_INGESTION_URL: iu,
    DATABASE_PROCESSOR_URL: pu,
    DATABASE_BANK_URL: bu,
    DATABASE_RECONCILIATION_URL: ru,
    DATABASE_EXCEPTION_URL: process.env['FLOW_TEST_EXCEPTION_URL'],
  };
  const args = [
    '--import',
    'tsx',
    'tools/exceptions.ts',
    'pipeline',
    path,
    runtime.book,
    'cli',
    runtime.mappingId,
    runtime.command.from,
    runtime.command.to,
  ];
  const output = (
    await promisify(execFile)(process.execPath, args, {
      env,
      maxBuffer: 16 * 1024 * 1024,
    })
  ).stdout;
  const result = JSON.parse(output);
  assert.equal(result.exceptionCaseIds.length, 1);
  assert(
    result.exceptions.states.some((x: { state: string }) => x.state === 'OPEN'),
  );
  for (const label of ['oracle', 'expectedMatch', 'falsePositives', 'anomaly'])
    assert(!output.includes(label));
  let view = await exceptions.get(result.exceptionCaseIds[0]);
  for (const command of [
    { action: 'START_REVIEW' as const },
    { action: 'RESOLVE' as const, resolution: 'ACCEPTED_RISK' as const },
  ]) {
    const file = join(dir, 'command.json');
    await writeFile(
      file,
      JSON.stringify({
        ...command,
        caseId: view.id,
        expectedVersion: view.version,
        commandKey: randomUUID(),
        actorId: 'cli-reviewer',
        reason: 'Synthetic public evidence review',
      }),
    );
    view = JSON.parse(
      (
        await promisify(execFile)(
          process.execPath,
          ['--import', 'tsx', 'tools/exceptions.ts', 'apply', file],
          { env },
        )
      ).stdout,
    );
  }
  assert.equal(view.state, 'RESOLVED');
  assert.equal(view.currentlyReconciled, false);
});
