import { readFile } from 'node:fs/promises';
import type { PoolClient } from 'pg';
/** Test-only, rollback-only reference implementation. Never exported into runtime packages. */
export async function previousReadDefinitions(client: PoolClient) {
  for (const [file, name, replacement] of [
    [
      '003_processor.sql',
      'processor.settlement_snapshot',
      'processor.settlement_snapshot',
    ],
    [
      '005_reconciliation.sql',
      'reconciliation.summary',
      'reconciliation.summary_v6',
    ],
    ['007_exceptions.sql', 'exceptions.cause', 'exceptions.cause'],
    ['008_financial_controls.sql', 'controls.exposure', 'controls.exposure'],
    ['008_financial_controls.sql', 'controls.snapshot', 'controls.snapshot'],
    ['011_operations_reads.sql', 'operations.read_v1', 'operations.read_v1'],
  ]) {
    const source = await readFile('database/migrations/' + file, 'utf8');
    const start = source.indexOf('CREATE FUNCTION ' + name + '(');
    const body = source.indexOf('AS $$', start) + 5;
    const end = source.indexOf('$$;', body) + 3;
    if (start < 0 || body < 5 || end < 3)
      throw new Error('Reference definition missing');
    await client.query(
      source
        .slice(start, end)
        .replace(
          'CREATE FUNCTION ' + name,
          'CREATE OR REPLACE FUNCTION ' + replacement,
        ),
    );
  }
  const source = await readFile(
    'database/migrations/002_ingestion.sql',
    'utf8',
  );
  const start = source.indexOf('CREATE VIEW ingestion.fact_status');
  const end = source.indexOf(';', start) + 1;
  await client.query(
    source.slice(start, end).replace('CREATE VIEW', 'CREATE OR REPLACE VIEW'),
  );
}
