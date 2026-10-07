import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { PostgresReconciliation } from '@flow/reconciliation-postgres';
import type { SystemInput } from '@flow/simulator';
import { PostgresIngestion } from '@flow/ingestion-postgres';
async function main(): Promise<void> {
  const [path, bookId, runKey, mappingId, from, to] = process.argv.slice(2);
  if (!path || !bookId || !runKey || !mappingId || !from || !to)
    throw new Error(
      'Usage: reconciliation <public-input> <book-id> <run-key> <provisioned-mapping-id> <from-UTC> <to-UTC>',
    );
  const url = process.env['DATABASE_RECONCILIATION_URL'],
    iu = process.env['DATABASE_INGESTION_URL'];
  if (!url || !iu) throw new Error('Missing runtime database URLs');
  const evidence = JSON.parse(await readFile(path, 'utf8')) as SystemInput;
  const domains = JSON.parse(
    (
      await promisify(execFile)(
        process.execPath,
        ['--import', 'tsx', 'tools/bank.ts', path, bookId, runKey],
        { env: process.env, maxBuffer: 16 * 1024 * 1024 },
      )
    ).stdout,
  );
  const pool = new Pool({ connectionString: url }),
    ip = new Pool({ connectionString: iu });
  try {
    const ingestion = new PostgresIngestion(ip);
    const processor = await ingestion.registerSource({
      bookId,
      environment: 'synthetic',
      provider: 'synthetic-simulator',
      externalAccountId: evidence.scope.processorAccountId,
    });
    const bank = await ingestion.registerSource({
      bookId,
      environment: 'synthetic',
      provider: 'synthetic-simulator-bank',
      externalAccountId: evidence.scope.bankAccountId,
    });
    const mapping = (
      await pool.query(
        'SELECT book_id,processor_source_account_id,bank_source_account_id FROM reconciliation.account_mapping WHERE id=$1',
        [mappingId],
      )
    ).rows[0];
    if (
      !mapping ||
      mapping.book_id !== bookId ||
      mapping.processor_source_account_id !== processor ||
      mapping.bank_source_account_id !== bank
    )
      throw new Error(
        'Provisioned mapping does not cover the supplied public scope',
      );
    const grouped = process.argv.slice(8).includes('--grouped');
    const result = await new PostgresReconciliation(pool).run({
      mappingId,
      runKey,
      from,
      to,
      effectiveAt: to,
      actorId: 'reconciliation-developer',
      ...(grouped
        ? { ruleVersion: 'settlement-bank-grouped-v1' as const }
        : {}),
    });
    console.log(JSON.stringify({ ...domains, reconciliation: result }));
  } finally {
    await Promise.all([pool.end(), ip.end()]);
  }
}
main().catch(() => {
  console.error(
    'Reconciliation workflow failed; inspect durable run identity and safe database error codes',
  );
  process.exitCode = 1;
});
