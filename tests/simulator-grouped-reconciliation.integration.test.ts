import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { Pool } from 'pg';
import fc from 'fast-check';
import { generateGroupedSimulation } from '@flow/simulator-oracle';
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
    ruleVersion: 'settlement-bank-grouped-v1' as const,
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
test('20 generated public grouped pipelines preserve exact oracle isolation, zero false positives, determinism and replay', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 0, max: 4294967295 }),
      fc.integer({ min: 2, max: 5 }),
      async (seed, groupSize) => {
        const config = {
          seed,
          paymentCount: 12,
          batchSizeRange: [1, 2] as const,
        };
        const simulation = generateGroupedSimulation(config, groupSize);
        assert.deepEqual(
          generateGroupedSimulation(config, groupSize),
          simulation,
        );
        // Only public input crosses runtime boundary. Independent evaluator sees truth afterwards.
        const runtime = await pipeline(simulation.input);
        assert.equal(
          runtime.result.matchedGroups,
          simulation.oracle.groups.filter((g) => g.bankId !== null).length,
        );
        const groups = (
          await rp.query(
            'SELECT * FROM reconciliation.match_group WHERE run_id=$1',
            [runtime.result.id],
          )
        ).rows;
        let falsePositives = 0;
        for (const g of groups) {
          const truth = simulation.oracle.groups.find(
            (t) => t.reference === g.evidence.reference,
          );
          if (!truth || truth.amountMinor !== g.signed_amount_minor)
            falsePositives++;
          else if (g.shape === 'N:1')
            assert.deepEqual(
              g.evidence.processorSnapshots
                .map((p: { externalId: string }) => p.externalId)
                .sort(),
              [...truth.settlementIds].sort(),
            );
        }
        assert.equal(falsePositives, 0);
        assert.deepEqual(
          await runtime.recon.run(runtime.command),
          runtime.result,
        );
      },
    ),
    { numRuns: 20, seed: 70704 },
  );
});
test('grouped CLI consumes public artifacts through normalization, prints separate summaries and deterministic replay without labels', async () => {
  const simulation = generateGroupedSimulation(
      { seed: 70705, paymentCount: 10, batchSizeRange: [1, 1] },
      3,
    ),
    f = await pipeline(simulation.input);
  const dir = await mkdtemp(join(tmpdir(), 'flow-grouped-cli-')),
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
            '--grouped',
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
  const first = await invoke();
  assert.deepEqual(first, await invoke());
  assert.equal(first.reconciliation.grouped.matchedGroups, 3);
  for (const label of ['oracle', 'falsePositives', 'expectedMatch', 'anomaly'])
    assert.ok(!JSON.stringify(first).includes(label));
  // Independent processes reproduce the versioned generation including its grouping declarations.
  const pub = join(dir, 'public'),
    priv = join(dir, 'private'),
    replay = join(dir, 'replay');
  await promisify(execFile)(process.execPath, [
    '--import',
    'tsx',
    'tools/simulator.ts',
    'generate',
    '--seed',
    '70706',
    '--payments',
    '40',
    '--group-size',
    '3',
    '--out',
    pub,
    '--oracle-out',
    priv,
  ]);
  await promisify(execFile)(process.execPath, [
    '--import',
    'tsx',
    'tools/simulator.ts',
    'replay',
    '--replay',
    join(priv, 'oracle.json'),
    '--out',
    replay,
  ]);
  const { readFile } = await import('node:fs/promises');
  assert.equal(
    await readFile(join(pub, 'input.json'), 'utf8'),
    await readFile(join(replay, 'input.json'), 'utf8'),
  );
});
test('public grouped wrong references, one-unit mismatch and undeclared lookalike sums never become false positives', async () => {
  const simulation = generateGroupedSimulation(
    { seed: 70706, paymentCount: 6, batchSizeRange: [1, 1] },
    3,
  );
  for (const input of [
    {
      ...simulation.input,
      bankObservations: simulation.input.bankObservations.map((b) => ({
        ...b,
        transferReference: 'unrelated-' + b.id,
      })),
    },
    {
      ...simulation.input,
      bankObservations: simulation.input.bankObservations.map((b) => ({
        ...b,
        amount: {
          ...b.amount,
          amountMinor: (BigInt(b.amount.amountMinor) - 1n).toString(),
        },
      })),
    },
    {
      ...simulation.input,
      settlements: simulation.input.settlements.map((r) => {
        const { payoutMemberIds: omitted, ...source } = r;
        void omitted;
        return source;
      }),
    },
  ]) {
    const runtime = await pipeline(input);
    assert.equal(runtime.result.matchedGroups, 0);
    assert.ok(
      runtime.result.outcomes.some(
        (x) => x.outcome === 'UNMATCHED' || x.outcome === 'AMBIGUOUS',
      ),
    );
  }
});
