import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { PostgresWorker } from '@flow/worker-postgres';
import { PostgresIngestion } from '@flow/ingestion-postgres';
import type { SystemInput } from '@flow/simulator';
import { simulatorBatch } from './ingestion-input';
async function main(): Promise<void> {
  const [action, arg, scope, key] = process.argv.slice(2);
  if (action === 'enqueue' && arg && scope && key) {
    const pool = new Pool({
      connectionString: process.env['DATABASE_INGESTION_URL'],
    });
    if (!process.env['DATABASE_INGESTION_URL'])
      throw new Error('Missing ingestion URL');
    try {
      const bytes = await readFile(arg),
        input = JSON.parse(bytes.toString('utf8')) as SystemInput,
        api = new PostgresIngestion(pool);
      const source = await api.registerSource({
        bookId: scope,
        environment: 'synthetic',
        provider: 'synthetic-simulator',
        externalAccountId: input.scope.processorAccountId,
      });
      const batch = await api.ingest(simulatorBatch(input, source, key, bytes));
      console.log(JSON.stringify(await api.summary(batch.id)));
    } finally {
      await pool.end();
    }
    return;
  }
  const url = process.env['DATABASE_WORKER_URL'];
  if (!url) throw new Error('Missing worker URL');
  const pool = new Pool({ connectionString: url }),
    api = new PostgresWorker(pool, {
      log: (entry) => console.log(JSON.stringify(entry)),
    });
  pool.on('error', () =>
    console.error(JSON.stringify({ event: 'worker_connection_error' })),
  );
  const stop = new AbortController(),
    shutdown = () => stop.abort();
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  try {
    if (action === 'once' || action === 'batch')
      console.log(
        JSON.stringify({
          processed: await api.processBatch(
            randomUUID(),
            action === 'once' ? 1 : Number(arg ?? 100),
            (action === 'once' ? arg : scope) ?? null,
            stop.signal,
          ),
        }),
      );
    else if (action === 'status')
      console.log(
        JSON.stringify(
          await api.status(
            (arg as Parameters<PostgresWorker['status']>[0]) ?? null,
          ),
        ),
      );
    else if (action === 'metrics')
      console.log(JSON.stringify(await api.metrics()));
    else if (action === 'start') {
      const owner = randomUUID();
      while (!stop.signal.aborted) {
        try {
          if (await api.processOne(owner, arg ?? null)) continue;
        } catch {
          console.error(JSON.stringify({ event: 'worker_poll_failed', owner }));
        }
        try {
          await delay(250, undefined, { signal: stop.signal });
        } catch {
          break;
        }
      }
    } else
      throw new Error(
        'Usage: worker enqueue <public-input> <book> <key> | once [book] | batch <limit> [book] | start [book] | status [state] | metrics',
      );
  } finally {
    process.removeListener('SIGINT', shutdown);
    process.removeListener('SIGTERM', shutdown);
    await pool.end();
  }
}
main().catch(() => {
  console.error(
    'Worker command failed; inspect durable work and retry with its original identity',
  );
  process.exitCode = 1;
});
