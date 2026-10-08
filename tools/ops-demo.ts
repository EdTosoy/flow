/** Offline synthetic provisioner: consumes ONLY public simulator inputs. Never imported by runtime apps. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import type { SystemInput } from '@flow/simulator';
import { PostgresIngestion } from '@flow/ingestion-postgres';
import { PostgresProcessor } from '@flow/processor-postgres';
import { PostgresBank } from '@flow/bank-postgres';
import { PostgresReconciliation } from '@flow/reconciliation-postgres';
import { PostgresExceptions } from '@flow/exception-postgres';
import { PostgresControls } from '@flow/control-postgres';
import { PostgresWorker } from '@flow/worker-postgres';
import { PostgresIntegrity } from '@flow/integrity-postgres';
import { simulatorBatch } from './ingestion-input';
import { simulatorSettlementBatch } from './processor-input';
import { simulatorBankBatch } from './bank-input';
export interface DemoPools {
  admin: Pool;
  ingestion: Pool;
  processor: Pool;
  bank: Pool;
  reconciliation: Pool;
  exceptions: Pool;
  controls: Pool;
  worker: Pool;
  integrity: Pool;
}
export async function seedDemo(
  p: DemoPools,
  inputs: readonly SystemInput[],
  label = 'phase12-public-demo',
  deliveryReplays = 0,
) {
  if (
    !Number.isInteger(deliveryReplays) ||
    deliveryReplays < 0 ||
    deliveryReplays > 20
  )
    throw new Error('Invalid delivery replay bound');
  if (
    !inputs.length ||
    inputs.length > 10 ||
    inputs.some(
      (i) =>
        i.scope?.environment !== 'synthetic' ||
        i.processorEvents.length > 10000,
    )
  )
    throw new Error('Bounded synthetic public inputs required');
  const identity = createHash('sha256')
    .update(JSON.stringify({ label, inputs, deliveryReplays }))
    .digest('hex');
  const book = [
    identity.slice(0, 8),
    identity.slice(8, 12),
    identity.slice(12, 16),
    identity.slice(16, 20),
    identity.slice(20, 32),
  ].join('-');
  await p.admin.query(
    "INSERT INTO ledger.book(id,code,environment) VALUES($1,$2,'synthetic') ON CONFLICT(id) DO NOTHING",
    [book, 'ops-demo-' + identity.slice(0, 12)],
  );
  const ingestion = new PostgresIngestion(p.ingestion),
    processor = new PostgresProcessor(p.processor),
    bank = new PostgresBank(p.bank),
    recon = new PostgresReconciliation(p.reconciliation),
    exceptions = new PostgresExceptions(p.exceptions),
    controls = new PostgresControls(p.controls),
    worker = new PostgresWorker(p.worker);
  const runs: string[] = [];
  for (const [index, input] of inputs.entries()) {
    const source = await ingestion.registerSource({
        bookId: book,
        environment: 'synthetic',
        provider: 'synthetic-demo-' + index,
        externalAccountId: input.scope.processorAccountId,
      }),
      bankSource = await ingestion.registerSource({
        bookId: book,
        environment: 'synthetic',
        provider: 'synthetic-demo-bank-' + index,
        externalAccountId: input.scope.bankAccountId,
      });
    const acts = await ingestion.ingest(
      simulatorBatch(input, source, 'demo-activities'),
    );
    const reports = await ingestion.ingest(
      simulatorSettlementBatch(input, source, 'demo-settlements'),
    );
    await ingestion.requestNormalization(
      reports.id,
      'synthetic-settlement-v1',
      'ops-demo',
    );
    const entries = await ingestion.ingest(
      simulatorBankBatch(input, bankSource, 'demo-bank'),
    );
    await ingestion.requestNormalization(
      entries.id,
      'synthetic-bank-entry-v1',
      'ops-demo',
    );
    const grouped = input.settlements.some((s) => s.payoutMemberIds);
    if (grouped)
      await ingestion.requestNormalization(
        reports.id,
        'synthetic-settlement-group-v1',
        'ops-demo',
      );
    await worker.processBatch('public-demo', 10000, book);
    await processor.deriveBatch(acts.id, 'synthetic-movement-v1');
    await processor.deriveBatch(reports.id, 'synthetic-settlement-v1');
    await bank.deriveBatch(entries.id, 'synthetic-bank-entry-v1');
    // Deterministic at-least-once public deliveries: distinct receipts, unchanged semantic facts.
    if (index === 0)
      for (let delivery = 0; delivery < deliveryReplays; delivery++) {
        await ingestion.ingest(
          simulatorBatch(input, source, 'demo-public-delivery-' + delivery),
        );
        await worker.processBatch('public-delivery-replay', 10000, book);
      }
    const currencies = [
      ...new Set(input.settlements.map((s) => s.net.currency)),
    ];
    for (const currency of currencies) {
      const mapping =
        (
          await p.admin.query<{ id: string }>(
            "INSERT INTO reconciliation.account_mapping(book_id,processor_source_account_id,bank_source_account_id,currency,reference_contract) VALUES($1,$2,$3,$4,'synthetic-transfer-reference-v1') ON CONFLICT(processor_source_account_id,currency) DO NOTHING RETURNING id",
            [book, source, bankSource, currency],
          )
        ).rows[0]?.id ??
        (
          await p.admin.query<{ id: string }>(
            'SELECT id FROM reconciliation.account_mapping WHERE book_id=$1 AND processor_source_account_id=$2 AND currency=$3',
            [book, source, currency],
          )
        ).rows[0]!.id;
      const run = await recon.run({
        mappingId: mapping,
        runKey: 'demo-reconciliation',
        ruleVersion: grouped
          ? 'settlement-bank-grouped-v1'
          : 'settlement-bank-exact-v1',
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-01-15T00:00:00.000Z',
        effectiveAt: '2026-01-15T00:00:00.000Z',
        actorId: 'ops-demo',
      });
      runs.push(run.id);
      const cases = await exceptions.generate(run.id, 'ops-demo');
      // One explicit, audited example disposition; never a UI action or allocation.
      // Select the demonstration by stable public source identity, never random physical UUID order.
      const selectedCase = (
        await p.admin.query<{ id: string }>(
          `SELECT c.id FROM exceptions.case_record c JOIN reconciliation.item i ON i.id=c.item_id LEFT JOIN ingestion.revision rev ON rev.id=i.observation_revision_id LEFT JOIN ingestion.source_fact f ON f.id=coalesce(i.source_fact_id,rev.fact_id) WHERE c.id=ANY($1::uuid[]) ORDER BY ((exceptions.case_view(c.id)->>'exposure') IS NULL),i.side,f.external_id NULLS LAST LIMIT 1`,
          [cases],
        )
      ).rows[0]?.id;
      for (const cid of selectedCase ? [selectedCase] : []) {
        const c = await exceptions.get(cid);
        if (c.state === 'OPEN') {
          await exceptions.apply({
            caseId: cid,
            commandKey: 'demo-review',
            expectedVersion: c.version,
            actorId: 'synthetic-reviewer',
            reason: 'Demonstrate read-only operator investigation',
            action: 'START_REVIEW',
          });
          const reviewed = await exceptions.get(cid);
          await exceptions.apply({
            caseId: cid,
            commandKey: 'demo-note',
            expectedVersion: reviewed.version,
            actorId: 'synthetic-reviewer',
            reason: 'Preserve investigation history',
            action: 'NOTE',
            note: 'Synthetic evidence only. No external money movement or production approval.',
          });
          const noted = await exceptions.get(cid);
          await exceptions.apply({
            caseId: cid,
            commandKey: 'demo-risk',
            expectedVersion: noted.version,
            actorId: 'synthetic-reviewer',
            reason:
              'Synthetic accepted-risk presentation; money stays unreconciled',
            action: 'RESOLVE',
            resolution: 'ACCEPTED_RISK',
          });
        }
      }
    }
  }
  // Demonstrate persisted operational failures only on first provisioning. The web remains read-only.
  const demoInput = inputs[0]!;
  const demoSource = await ingestion.registerSource({
    bookId: book,
    environment: 'synthetic',
    provider: 'synthetic-demo-0',
    externalAccountId: demoInput.scope.processorAccountId,
  });
  const existed = (
    await p.admin.query(
      'SELECT id FROM ingestion.batch WHERE source_account_id=$1 AND batch_key=$2',
      [demoSource, 'demo-operational-retry'],
    )
  ).rowCount;
  if (!existed) {
    const single = {
      ...demoInput,
      processorEvents: demoInput.processorEvents.slice(0, 1),
    };
    await ingestion.ingest(
      simulatorBatch(single, demoSource, 'demo-operational-retry'),
    );
    await ingestion.ingest(
      simulatorBatch(single, demoSource, 'demo-operational-terminal'),
    );
    const retry = await worker.claim('synthetic-demo-fault', book);
    if (!retry) throw new Error('Missing demonstration intent');
    await worker.finish(retry, {
      classification: 'TRANSIENT',
      code: 'DEMO_TRANSIENT',
    });
    const terminal = await worker.claim('synthetic-demo-fault', book);
    if (!terminal) throw new Error('Missing demonstration intent');
    await worker.finish(terminal, {
      classification: 'POISON',
      code: 'DEMO_POISON',
    });
  }
  const evaluation = await controls.run({
    bookId: book,
    runKey: 'demo-financial-controls',
    actorId: 'ops-demo',
    reconciliationRunIds: runs,
    createCases: true,
    maxAgeSeconds: 31536000,
  });
  const integrity = await new PostgresIntegrity(p.integrity).sweep(book, runs);
  if (integrity.integrity !== 'PASS')
    throw new Error('Public demo left structural violations');
  return {
    bookId: book,
    evaluationId: evaluation.id,
    reconciliationRunIds: runs,
    assurance: evaluation.assurance,
    inputIdentity: identity,
  };
}
async function main() {
  const paths = process.argv.slice(2);
  let deliveryReplays = 0;
  if (paths[0] === '--delivery-replays') {
    paths.shift();
    const value = paths.shift();
    if (!value || !/^([0-9]|1[0-9]|20)$/.test(value))
      throw new Error('Invalid delivery replay bound');
    deliveryReplays = Number(value);
  }
  if (!paths.length)
    throw new Error('Use pnpm ops:demo <public input.json> [...]');
  const keys: Record<keyof DemoPools, string> = {
    admin: 'ADMIN',
    ingestion: 'INGESTION',
    processor: 'PROCESSOR',
    bank: 'BANK',
    reconciliation: 'RECONCILIATION',
    exceptions: 'EXCEPTION',
    controls: 'CONTROL',
    worker: 'WORKER',
    integrity: 'INTEGRITY',
  };
  const entries = Object.entries(keys).map(([key, suffix]) => {
    const value = process.env['DATABASE_' + suffix + '_URL'];
    if (!value) throw new Error('Missing scoped demo connection');
    return [key, new Pool({ connectionString: value })] as const;
  });
  const pools = Object.fromEntries(entries) as unknown as DemoPools;
  try {
    const inputs: SystemInput[] = [];
    for (const path of paths) {
      const bytes = await readFile(path);
      if (bytes.length > 16000000)
        throw new Error('Public demo input exceeds bound');
      inputs.push(JSON.parse(bytes.toString()) as SystemInput);
    }
    console.log(
      JSON.stringify(
        await seedDemo(pools, inputs, 'phase12-public-demo', deliveryReplays),
      ),
    );
  } finally {
    await Promise.all(entries.map(([, p]) => p.end()));
  }
}
if (require.main === module)
  main().catch(() => {
    console.error(JSON.stringify({ event: 'operations_demo_failed' }));
    process.exitCode = 1;
  });
