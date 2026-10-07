import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { PostgresIngestion } from '@flow/ingestion-postgres';
import { normalizerVersion } from '@flow/ingestion-domain';
import type { SystemInput } from '@flow/simulator';
import { simulatorBatch } from './ingestion-input';
async function main(): Promise<void> {
  const [action, inputPath, bookId, batchKey, versionArg] =
    process.argv.slice(2);
  if (
    action !== 'simulator' ||
    !inputPath ||
    !bookId ||
    !batchKey ||
    !process.env['DATABASE_INGESTION_URL']
  )
    throw new Error(
      'Usage: DATABASE_INGESTION_URL=<runtime URL> pnpm ingestion simulator <public input.json> <book UUID> <batch key> [normalizer version]',
    );
  const version = normalizerVersion(versionArg ?? 'synthetic-movement-v1');
  const pool = new Pool({
    connectionString: process.env['DATABASE_INGESTION_URL'],
  });
  pool.on('error', () => {
    console.error('Ingestion database connection error');
  });
  try {
    const bytes = await readFile(inputPath);
    const input = JSON.parse(bytes.toString('utf8')) as SystemInput;
    const ingestion = new PostgresIngestion(pool);
    const sourceAccountId = await ingestion.registerSource({
      bookId,
      environment: 'synthetic',
      provider: 'synthetic-simulator',
      externalAccountId: input.scope.processorAccountId,
    });
    const batch = await ingestion.ingest(
      simulatorBatch(input, sourceAccountId, batchKey, bytes),
    );
    if (version !== 'synthetic-movement-v1')
      await ingestion.requestNormalization(
        batch.id,
        version,
        'synthetic-ingestion-cli',
      );
    console.log(
      JSON.stringify(await ingestion.normalizeBatch(batch.id, version)),
    );
  } finally {
    await pool.end();
  }
}
main().catch(() => {
  console.error(
    'Ingestion failed; inspect preserved dispositions or retry the unchanged command. Check CLI usage and runtime connection.',
  );
  process.exitCode = 1;
});
