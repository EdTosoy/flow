import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { PostgresIngestion } from '@flow/ingestion-postgres';
import { PostgresWorker } from '@flow/worker-postgres';
test('1,000 durable requests / 16 workers: throughput, latency, retry drainage, database counters and peak memory', async () => {
  const admin = new Pool({
      connectionString: process.env['FLOW_TEST_ADMIN_URL'],
    }),
    ip = new Pool({ connectionString: process.env['FLOW_TEST_INGESTION_URL'] }),
    wp = new Pool({
      connectionString: process.env['FLOW_TEST_WORKER_URL'],
      max: 20,
    });
  try {
    const book = randomUUID();
    await admin.query(
      "INSERT INTO ledger.book(id,code,environment) VALUES($1,$2,'synthetic')",
      [book, 'load-worker-' + book],
    );
    const ingestion = new PostgresIngestion(ip),
      source = await ingestion.registerSource({
        bookId: book,
        environment: 'synthetic',
        provider: 'load',
        externalAccountId: book,
      });
    const count = 1000,
      concurrency = 16;
    // Every request contains a real source movement and exercises the existing normalization command.
    for (let i = 0; i < count; i++) {
      const id = 'movement-' + i;
      await ingestion.ingest({
        sourceAccountId: source,
        batchKey: 'load-' + i,
        actorId: 'benchmark',
        provenance: { adapterVersion: 'load-v1' },
        records: [
          {
            locator: '0',
            objectKind: 'movement',
            externalId: id,
            sourceRevision: null,
            sourceObservedAt: null,
            sequence: null,
            bytes: Buffer.from(
              JSON.stringify({
                id,
                kind: 'capture',
                amount: { amountMinor: '970000', currency: 'PHP' },
                occurredAt: '2026-01-01T00:00:00.000Z',
                paymentReference: 'p-' + i,
                parentCaptureId: null,
              }),
            ),
          },
        ],
      });
    }
    const durations: number[] = [],
      claims: number[] = [],
      worker = new PostgresWorker(wp, {
        timing: (metric, ms) =>
          (metric === 'claim_latency' ? claims : durations).push(ms),
      });
    // Fifty durable infrastructure failures must rejoin the queue with preserved history.
    for (let i = 0; i < 50; i++) {
      const c = await worker.claim('inject-retry', book);
      assert(c);
      await worker.finish(c, { classification: 'TRANSIENT', code: '08006' });
    }
    const before = (
      await admin.query(
        'SELECT xact_commit,blks_read,blks_hit,deadlocks FROM pg_stat_database WHERE datname=current_database()',
      )
    ).rows[0];
    const start = performance.now();
    await Promise.all(
      Array.from({ length: concurrency }, (_, i) =>
        worker.processBatch('load-' + i, 10000, book),
      ),
    );
    const elapsedMs = performance.now() - start,
      r = (
        await admin.query(
          "SELECT count(*)::int n,sum(attempt_count-1)::int retries FROM worker.status WHERE book_id=$1 AND state='SUCCEEDED'",
          [book],
        )
      ).rows[0];
    assert.deepEqual(r, { n: count, retries: 50 });
    assert.equal(
      (
        await admin.query(
          "SELECT count(*)::int n FROM ingestion.processing p JOIN ingestion.raw_record r ON r.id=p.raw_id JOIN ingestion.batch b ON b.id=r.batch_id WHERE b.source_account_id=$1 AND p.state='PENDING'",
          [source],
        )
      ).rows[0].n,
      0,
    );
    const after = (
      await admin.query(
        'SELECT xact_commit,blks_read,blks_hit,deadlocks FROM pg_stat_database WHERE datname=current_database()',
      )
    ).rows[0];
    const latencies = (
      await admin.query(
        'SELECT extract(epoch FROM (completed_at-created_at))*1000 AS ms FROM worker.status WHERE book_id=$1 ORDER BY ms',
        [book],
      )
    ).rows.map((x) => Number(x.ms));
    durations.sort((a, b) => a - b);
    claims.sort((a, b) => a - b);
    console.log(
      'PHASE10_LOAD ' +
        JSON.stringify({
          workItems: count,
          concurrency,
          elapsedMs,
          jobsPerSecond: (count * 1000) / elapsedMs,
          handlerP50Ms: durations[Math.floor(durations.length * 0.5)],
          handlerP95Ms: durations[Math.floor(durations.length * 0.95)],
          claimP95Ms: claims[Math.floor(claims.length * 0.95)],
          completionP50Ms: latencies[500],
          completionP95Ms: latencies[950],
          retries: r.retries,
          dbBefore: before,
          dbAfter: after,
          peakRssKiB: process.resourceUsage().maxRSS,
          dbCpuUtilization: 'unavailable',
        }),
    );
  } finally {
    await Promise.all([admin.end(), ip.end(), wp.end()]);
  }
});
