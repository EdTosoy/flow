import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { Pool } from 'pg';
import fc from 'fast-check';
import { generateSimulation } from '@flow/simulator-oracle';
import type { SystemInput } from '@flow/simulator';
import { PostgresIngestion } from '@flow/ingestion-postgres';
import { PostgresProcessor } from '@flow/processor-postgres';
import { PostgresBank } from '@flow/bank-postgres';
import { PostgresReconciliation } from '@flow/reconciliation-postgres';
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
  bp = new Pool({ connectionString: bu });
after(async () => {
  await Promise.all([admin.end(), rp.end(), ip.end(), pp.end(), bp.end()]);
});
async function pipeline(input: SystemInput) {
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
    runKey: 'sim-run',
    from: '2026-01-01T00:00:00.000Z',
    to: '2026-01-10T00:00:00.000Z',
    effectiveAt: '2026-01-10T00:00:00.000Z',
    actorId: 'sim-runtime',
  };
  return {
    book,
    source,
    bankSource,
    mappingId,
    recon,
    command,
    result: await recon.run(command),
  };
}
test('20 public simulator -> ingestion -> processor/bank -> exact reconciliation trials; independent oracle evaluator measures truth afterward', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 0, max: 4294967295 }),
      fc.integer({ min: 6, max: 18 }),
      async (seed, paymentCount) => {
        const simulation = generateSimulation({
          seed,
          paymentCount,
          fullRefundCount: 2,
          partialRefundCount: 1,
          chargebackCount: 1,
          batchSizeRange: [1, 3],
        });
        // Runtime pipeline is given public artifacts only. Truth remains in this verifier.
        const runtime = await pipeline(simulation.input);
        assert.equal(
          runtime.result.matchedGroups,
          simulation.oracle.bank.length,
        );
        const pairs = (
          await rp.query(
            'SELECT evidence FROM reconciliation.match_group WHERE run_id=$1',
            [runtime.result.id],
          )
        ).rows;
        let truePositives = 0,
          falsePositives = 0;
        for (const pair of pairs) {
          const e = pair.evidence;
          const settlement = simulation.oracle.settlements.find(
            (x) => x.transferReference === e.reference,
          );
          const bank = simulation.oracle.bank.find(
            (x) => x.transferReference === e.reference,
          );
          if (
            settlement &&
            bank &&
            settlement.net.amountMinor === e.signedAmountMinor &&
            bank.amount.amountMinor === e.signedAmountMinor
          )
            truePositives++;
          else falsePositives++;
        }
        assert.equal(falsePositives, 0);
        assert.equal(truePositives, simulation.oracle.bank.length);
        assert.deepEqual(
          await runtime.recon.run(runtime.command),
          runtime.result,
        );
        assert.equal(
          (
            await admin.query(
              'SELECT count(*)::integer n FROM ledger.ledger_transaction WHERE book_id=$1',
              [runtime.book],
            )
          ).rows[0].n,
          0,
        );
      },
    ),
    { numRuns: 20, seed: 70605 },
  );
});
test('public missing/wrong-reference/incorrect component/duplicate artifacts produce conservative results without runtime labels', async () => {
  const simulation = generateSimulation({
    seed: 70606,
    paymentCount: 30,
    batchSizeRange: [2, 3],
    anomalies: {
      'missing-bank-transaction': { count: 1 },
      'wrong-reference': { count: 1 },
      'incorrect-amount': { count: 1 },
      'duplicate-bank-observation': { count: 1 },
    },
  });
  const runtime = await pipeline(simulation.input);
  assert.ok(runtime.result.matchedGroups < simulation.oracle.bank.length);
  assert.equal(
    runtime.result.bankPopulation,
    new Set(simulation.input.bankObservations.map((x) => x.id)).size,
  );
  assert.equal(runtime.result.sourceCoverage, 'UNKNOWN');
  const outputs = (
    await rp.query(
      'SELECT evidence FROM reconciliation.match_group WHERE run_id=$1',
      [runtime.result.id],
    )
  ).rows;
  for (const { evidence: e } of outputs) {
    const truth = simulation.oracle.bank.find(
      (x) => x.transferReference === e.reference,
    );
    assert.ok(truth);
    assert.equal(truth.amount.amountMinor, e.signedAmountMinor);
  }
  assert.ok(runtime.result.outcomes.some((x) => x.outcome === 'UNMATCHED'));
  assert.ok(runtime.result.outcomes.some((x) => x.outcome === 'INELIGIBLE'));
});
test('CLI runs the public pipeline with provisioned account mapping and replayable separate domain/reconciliation summaries', async () => {
  const simulation = generateSimulation({
    seed: 70607,
    paymentCount: 8,
    batchSizeRange: [2, 3],
  });
  const f = await pipeline(simulation.input);
  const dir = await mkdtemp(join(tmpdir(), 'flow-recon-cli-')),
    path = join(dir, 'input.json');
  await writeFile(path, JSON.stringify(simulation.input));
  const invoke = async () =>
    JSON.parse(
      (
        await promisify(execFile)(
          process.execPath,
          [
            '--import',
            'tsx',
            'tools/reconciliation.ts',
            path,
            f.book,
            'cli',
            f.mappingId,
            f.command.from,
            f.command.to,
          ],
          {
            env: {
              ...process.env,
              DATABASE_INGESTION_URL: iu!,
              DATABASE_PROCESSOR_URL: pu!,
              DATABASE_BANK_URL: bu!,
              DATABASE_RECONCILIATION_URL: ru!,
            },
            maxBuffer: 16 * 1024 * 1024,
          },
        )
      ).stdout,
    );
  const first = await invoke(),
    second = await invoke();
  assert.deepEqual(first, second);
  assert.equal(
    first.reconciliation.matchedGroups,
    simulation.oracle.bank.length,
  );
  assert.deepEqual(Object.keys(first).sort(), [
    'bank',
    'processor',
    'reconciliation',
  ]);
  for (const label of [
    'oracle',
    'truePositives',
    'falsePositives',
    'expectedMatch',
    'anomaly',
  ])
    assert.ok(!JSON.stringify(first).includes(label));
});
