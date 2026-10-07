import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import type { SystemInput } from '@flow/simulator';
import { PostgresIngestion } from '@flow/ingestion-postgres';
import { PostgresProcessor } from '@flow/processor-postgres';
import { simulatorBatch } from './ingestion-input';
import { simulatorSettlementBatch } from './processor-input';
async function main(): Promise<void> {
  const [inputPath, bookId, runKey] = process.argv.slice(2);
  if (
    !inputPath ||
    !bookId ||
    !runKey ||
    !process.env['DATABASE_INGESTION_URL'] ||
    !process.env['DATABASE_PROCESSOR_URL']
  )
    throw new Error(
      'Usage: pnpm processor <public input.json> <book UUID> <run key>; configure separate ingestion/processor runtime URLs',
    );
  const ip = new Pool({
      connectionString: process.env['DATABASE_INGESTION_URL'],
    }),
    pp = new Pool({ connectionString: process.env['DATABASE_PROCESSOR_URL'] });
  for (const p of [ip, pp])
    p.on('error', () => console.error('Processor pipeline connection error'));
  try {
    const bytes = await readFile(inputPath),
      input = JSON.parse(bytes.toString('utf8')) as SystemInput;
    const ingestion = new PostgresIngestion(ip),
      processor = new PostgresProcessor(pp);
    const account = await ingestion.registerSource({
      bookId,
      environment: 'synthetic',
      provider: 'synthetic-simulator',
      externalAccountId: input.scope.processorAccountId,
    });
    const movements = await ingestion.ingest(
      simulatorBatch(input, account, runKey + ':activities', bytes),
    );
    const movementSummary = await ingestion.normalizeBatch(movements.id);
    const activities = await processor.deriveBatch(
      movements.id,
      'synthetic-movement-v1',
    );
    const settlements = await ingestion.ingest(
      simulatorSettlementBatch(input, account, runKey + ':settlements'),
    );
    await ingestion.requestNormalization(
      settlements.id,
      'synthetic-settlement-v1',
      'synthetic-processor-cli',
    );
    const reportSummary = await ingestion.normalizeBatch(
      settlements.id,
      'synthetic-settlement-v1',
    );
    const batches = await processor.deriveBatch(
      settlements.id,
      'synthetic-settlement-v1',
    );
    if (input.settlements.some((r) => r.payoutMemberIds !== undefined)) {
      await ingestion.requestNormalization(
        settlements.id,
        'synthetic-settlement-group-v1',
        'synthetic-processor-cli',
      );
      await ingestion.normalizeBatch(
        settlements.id,
        'synthetic-settlement-group-v1',
      );
    }
    const payments = new Set(activities.map((a) => a.paymentId!));
    const paymentResults = [];
    for (const id of payments)
      paymentResults.push(await processor.evaluate('payment', id, runKey));
    const summaries = [];
    for (const b of batches)
      summaries.push(
        (await processor.evaluate('settlement', b.id, runKey)).result,
      );
    console.log(
      JSON.stringify({
        payments: payments.size,
        processorActivities: activities.length,
        settlementBatches: batches.length,
        normalization: { movements: movementSummary, reports: reportSummary },
        paymentControlsFailed: paymentResults.filter(
          (e) => e.result.controls.length,
        ).length,
        settlementControlsFailed: summaries.filter((e) => e.controls.length)
          .length,
        settlements: summaries,
      }),
    );
  } finally {
    await Promise.all([ip.end(), pp.end()]);
  }
}
main().catch(() => {
  console.error(
    'Processor pipeline failed; inspect durable evidence/controls and retry unchanged keys. Check usage and runtime capabilities.',
  );
  process.exitCode = 1;
});
