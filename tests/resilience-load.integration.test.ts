import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { PostgresIngestion } from '@flow/ingestion-postgres';
import { PostgresWorker } from '@flow/worker-postgres';
import { clean, waitDue, witness } from './helpers/resilience';

test('1,002 work items / 16 workers: retry storm, expired leases, poison isolation, recovery and invariant-clean load', async () => {
  const admin = new Pool({
      connectionString: process.env['FLOW_TEST_ADMIN_URL'],
    }),
    ip = new Pool({ connectionString: process.env['FLOW_TEST_INGESTION_URL'] }),
    wp = new Pool({
      connectionString: process.env['FLOW_TEST_WORKER_URL'],
      max: 20,
    });
  const book = randomUUID(),
    durations: number[] = [],
    claims: number[] = [],
    ingestion = new PostgresIngestion(ip),
    worker = new PostgresWorker(wp, {
      timing: (metric, ms) =>
        (metric === 'claim_latency' ? claims : durations).push(ms),
    });
  try {
    await admin.query(
      "INSERT INTO ledger.book(id,code,environment) VALUES($1,$2,'synthetic')",
      [book, 'failure-load-' + book],
    );
    const source = await ingestion.registerSource({
      bookId: book,
      environment: 'synthetic',
      provider: 'resilience-load',
      externalAccountId: book,
    });
    await admin.query(
      'UPDATE worker.policy SET max_attempts=8,base_delay_ms=5,max_delay_ms=20,lease_ms=3000,timeout_ms=2000 WHERE id=1',
    );
    const enqueue = async (i: number) => {
      const id = 'movement-' + i;
      await ingestion.ingest({
        sourceAccountId: source,
        batchKey: 'failure-load-' + i,
        actorId: 'resilience-benchmark',
        provenance: { adapterVersion: 'failure-load-v1' },
        records: [
          {
            locator: '0',
            objectKind: 'movement',
            externalId: id,
            sourceRevision: null,
            sequence: null,
            sourceObservedAt: null,
            bytes: Buffer.from(
              JSON.stringify({
                id,
                kind: 'capture',
                paymentReference: id,
                parentCaptureId: null,
                amount: { amountMinor: '100', currency: 'PHP' },
                occurredAt: '2026-01-01T00:00:00.000Z',
              }),
            ),
          },
        ],
      });
    };
    for (let i = 0; i < 1000; i++) await enqueue(i);
    // Malformed committed intent is deliberately manufactured only by a disposable test trigger.
    await admin.query(
      "CREATE FUNCTION public.resilience_poison() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='ingestion.normalization_requested' THEN NEW.payload:=NEW.payload||'{\"unexpected\":true}'::jsonb; END IF; RETURN NEW; END $$; CREATE TRIGGER resilience_poison BEFORE INSERT ON outbox.outbox_event FOR EACH ROW EXECUTE FUNCTION public.resilience_poison()",
    );
    try {
      await enqueue(1000);
      await enqueue(1001);
    } finally {
      await admin.query(
        'DROP TRIGGER resilience_poison ON outbox.outbox_event; DROP FUNCTION public.resilience_poison()',
      );
    }
    const preserve = await witness(admin),
      stale = [];
    for (let i = 0; i < 250; i++) {
      const c = await worker.claim('storm', book);
      assert(c);
      await worker.finish(c, { classification: 'TRANSIENT', code: '08006' });
    }
    for (let i = 0; i < 25; i++) {
      const c = await worker.claim('crashed-owner', book);
      assert(c);
      stale.push(c);
    }
    const leaseRows = (
      await admin.query<{ id: string; expires: string }>(
        "SELECT id,lease_expires_at::text expires FROM worker.status WHERE book_id=$1 AND state='PROCESSING'",
        [book],
      )
    ).rows;
    const untilExpiry = performance.now();
    await waitDue(admin, book);
    // Retryable rows may be due sooner; wait for the last intentionally abandoned lease by database time.
    await admin.query(
      "SELECT pg_sleep(greatest(0,extract(epoch FROM max(lease_expires_at)-clock_timestamp()))+0.002) FROM worker.status WHERE book_id=$1 AND state='PROCESSING'",
      [book],
    );
    const leaseWaitMs = performance.now() - untilExpiry;
    const before = await clean(admin, book);
    assert.equal(before.work.expiredRecoverable, 25);
    const dbBefore = (
      await admin.query(
        'SELECT xact_commit,blks_read,blks_hit,deadlocks FROM pg_stat_database WHERE datname=current_database()',
      )
    ).rows[0];
    const start = performance.now();
    await Promise.all(
      Array.from({ length: 16 }, (_, i) =>
        worker.processBatch('failure-load-' + i, 10000, book),
      ),
    );
    const elapsedMs = performance.now() - start;
    for (const c of stale) assert.equal(await worker.finish(c), false);
    const health = await clean(admin, book);
    assert.deepEqual(health.work, {
      pending: 0,
      processing: 0,
      retryable: 0,
      terminal: 2,
      succeeded: 1000,
      expiredRecoverable: 0,
    });
    assert.equal(
      (
        await admin.query(
          'SELECT count(*)::int n FROM ingestion.interpretation i JOIN ingestion.revision r ON r.id=i.revision_id WHERE r.source_account_id=$1',
          [source],
        )
      ).rows[0].n,
      1000,
    );
    assert.equal(
      (
        await admin.query(
          'SELECT count(*)::int n FROM ledger.ledger_transaction WHERE book_id=$1',
          [book],
        )
      ).rows[0].n,
      0,
    );
    await preserve();
    const history = (
      await admin.query(
        "SELECT count(*) FILTER(WHERE a.kind='FAILED' AND a.failure_class='TRANSIENT')::int retryFailures,count(*) FILTER(WHERE a.kind='EXPIRED')::int expirations,count(*) FILTER(WHERE a.kind='FENCED')::int fences FROM worker.attempt_event a JOIN worker.status w ON w.id=a.work_id WHERE w.book_id=$1",
        [book],
      )
    ).rows[0];
    assert.equal(history.retryfailures, 250);
    assert.equal(history.expirations, 25);
    assert.equal(history.fences, 25);
    const completion = (
      await admin.query(
        "SELECT extract(epoch FROM completed_at-created_at)*1000 ms FROM worker.status WHERE book_id=$1 AND state='SUCCEEDED' ORDER BY ms",
        [book],
      )
    ).rows.map((r) => Number(r.ms));
    durations.sort((a, b) => a - b);
    claims.sort((a, b) => a - b);
    const recovery = (
      await admin.query<{ ms: string }>(
        "SELECT extract(epoch FROM (a.recorded_at-t.expiry))*1000 ms FROM unnest($1::uuid[],$2::timestamptz[]) AS t(work_id,expiry) JOIN worker.attempt_event a ON a.work_id=t.work_id AND a.kind='STARTED' AND a.attempt=2 ORDER BY ms",
        [leaseRows.map((r) => r.id), leaseRows.map((r) => r.expires)],
      )
    ).rows.map((r) => Number(r.ms));
    assert.equal(recovery.length, 25);
    const dbAfter = (
      await admin.query(
        'SELECT xact_commit,blks_read,blks_hit,deadlocks FROM pg_stat_database WHERE datname=current_database()',
      )
    ).rows[0];
    console.log(
      'PHASE11_FAILURE_LOAD ' +
        JSON.stringify({
          workItems: 1002,
          healthy: 1000,
          concurrency: 16,
          elapsedMs,
          jobsPerSecond: (1002 * 1000) / elapsedMs,
          handlerP50Ms: durations[Math.floor(durations.length * 0.5)],
          handlerP95Ms: durations[Math.floor(durations.length * 0.95)],
          claimP95Ms: claims[Math.floor(claims.length * 0.95)],
          completionP50Ms: completion[500],
          completionP95Ms: completion[950],
          retryFailures: 250,
          expiredAttempts: 25,
          terminalFailures: 2,
          leaseWaitMs,
          reclaimDelayP50Ms: recovery[12],
          reclaimDelayP95Ms: recovery[23],
          backlogRecoveryMs: elapsedMs,
          invariantViolations: 0,
          duplicateDomainEffects: 0,
          unrecoveredWork: 0,
          financialAssurance: health.financialAssurance,
          dbBefore,
          dbAfter,
          peakRssKiB: process.resourceUsage().maxRSS,
          dbCpuUtilization: 'unavailable',
        }),
    );
  } finally {
    await admin
      .query(
        'DROP TRIGGER IF EXISTS resilience_poison ON outbox.outbox_event; DROP FUNCTION IF EXISTS public.resilience_poison(); UPDATE worker.policy SET max_attempts=5,base_delay_ms=100,max_delay_ms=30000,lease_ms=30000,timeout_ms=10000 WHERE id=1',
      )
      .catch(() => {});
    await Promise.all([admin, ip, wp].map((p) => p.end()));
  }
});
