import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import type { SystemInput } from '@flow/simulator';
import { PostgresIngestion } from '@flow/ingestion-postgres';
import { PostgresBank } from '@flow/bank-postgres';
import { simulatorBankBatch } from './bank-input';
async function main(): Promise<void> {
  const [inputPath, bookId, runKey] = process.argv.slice(2);
  if (
    !inputPath ||
    !bookId ||
    !runKey ||
    !process.env['DATABASE_INGESTION_URL'] ||
    !process.env['DATABASE_BANK_URL'] ||
    !process.env['DATABASE_PROCESSOR_URL']
  )
    throw new Error(
      'Usage: pnpm bank <public input.json> <book UUID> <run key>; configure separate ingestion/processor/bank runtime URLs',
    );
  // Invoke the established public processor workflow. Its output remains a separate summary.
  const processor = JSON.parse(
    (
      await promisify(execFile)(
        process.execPath,
        ['--import', 'tsx', 'tools/processor.ts', inputPath, bookId, runKey],
        { maxBuffer: 16 * 1024 * 1024 },
      )
    ).stdout,
  );
  const ip = new Pool({
      connectionString: process.env['DATABASE_INGESTION_URL'],
    }),
    bp = new Pool({ connectionString: process.env['DATABASE_BANK_URL'] });
  for (const p of [ip, bp])
    p.on('error', () => console.error('Bank pipeline connection error'));
  try {
    const bytes = await readFile(inputPath),
      input = JSON.parse(bytes.toString('utf8')) as SystemInput;
    const ingestion = new PostgresIngestion(ip),
      bank = new PostgresBank(bp);
    const account = await ingestion.registerSource({
      bookId,
      environment: 'synthetic',
      provider: 'synthetic-simulator-bank',
      externalAccountId: input.scope.bankAccountId,
    });
    const batch = await ingestion.ingest(
      simulatorBankBatch(input, account, runKey + ':bank', bytes),
    );
    await ingestion.requestNormalization(
      batch.id,
      'synthetic-bank-entry-v1',
      'synthetic-bank-cli',
    );
    const normalization = await ingestion.normalizeBatch(
      batch.id,
      'synthetic-bank-entry-v1',
    );
    await bank.deriveBatch(batch.id, 'synthetic-bank-entry-v1');
    console.log(
      JSON.stringify({
        processor,
        bank: {
          ...(await bank.summary(account)),
          normalization,
          statementBatches: 0,
          internalControlFailures: 0,
          statementCompleteness: 'UNKNOWN',
        },
      }),
    );
  } finally {
    await Promise.all([ip.end(), bp.end()]);
  }
}
main().catch(() => {
  console.error(
    'Bank pipeline failed; inspect durable evidence/controls and retry unchanged keys. Check usage and runtime capabilities.',
  );
  process.exitCode = 1;
});
