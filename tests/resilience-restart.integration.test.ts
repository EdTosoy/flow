import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool, type PoolClient } from 'pg';
import { PostgresIngestion } from '@flow/ingestion-postgres';
import { PostgresWorker } from '@flow/worker-postgres';
import { clean, witness } from './helpers/resilience';
const exec = promisify(execFile);
test('local single-node PostgreSQL restart drops outstanding transaction, retains committed handler and resumes from a separate worker process', async () => {
  const container = process.env['FLOW_TEST_CONTAINER']!;
  assert.match(container, /^flow-phase1-[0-9a-f-]{36}$/);
  const admin = new Pool({
      connectionString: process.env['FLOW_TEST_ADMIN_URL'],
      connectionTimeoutMillis: 2000,
      query_timeout: 10000,
    }),
    ip = new Pool({ connectionString: process.env['FLOW_TEST_INGESTION_URL'] }),
    wp = new Pool({ connectionString: process.env['FLOW_TEST_WORKER_URL'] });
  for (const p of [admin, ip, wp]) p.on('error', () => {}); // Idle sockets are expected to be discarded on this owned local restart.
  const book = randomUUID();
  let outstanding: PoolClient | undefined;
  try {
    await admin.query(
      "INSERT INTO ledger.book(id,code,environment) VALUES($1,$2,'synthetic')",
      [book, 'restart-' + book],
    );
    const ingestion = new PostgresIngestion(ip),
      source = await ingestion.registerSource({
        bookId: book,
        environment: 'synthetic',
        provider: 'restart',
        externalAccountId: book,
      });
    await admin.query(
      'UPDATE worker.policy SET lease_ms=300,timeout_ms=200,base_delay_ms=5,max_delay_ms=20 WHERE id=1',
    );
    const batches = [];
    for (let i = 0; i < 4; i++) {
      const id = 'restart-' + i;
      batches.push(
        await ingestion.ingest({
          sourceAccountId: source,
          batchKey: id,
          actorId: 'resilience',
          provenance: { adapterVersion: 'restart-v1' },
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
        }),
      );
    }
    const worker = new PostgresWorker(wp),
      done = await worker.claim('already-successful', book);
    assert(done);
    await worker.handle(done);
    await worker.finish(done);
    const committed = await worker.claim('committed-handler-no-ack', book);
    assert(committed);
    await worker.handle(committed);
    const retry = await worker.claim('retry-before-restart', book);
    assert(retry);
    await worker.finish(retry, { classification: 'TRANSIENT', code: '08006' });
    outstanding = await wp.connect();
    outstanding.on('error', () => {});
    await outstanding.query('BEGIN');
    const rollbackClaim = (
      await outstanding.query('SELECT worker.claim($1,$2::uuid) c', [
        'uncommitted-claim',
        book,
      ])
    ).rows[0].c;
    assert(rollbackClaim);
    const preserved = await witness(admin),
      started = performance.now();
    await exec('docker', ['restart', '--time', '1', container], {
      timeout: 30000,
    });
    await assert.rejects(outstanding.query('COMMIT'));
    outstanding.release(true);
    outstanding = undefined;
    const deadline = performance.now() + 10000;
    let connected = false;
    while (performance.now() < deadline) {
      try {
        await admin.query('SELECT 1');
        connected = true;
        break;
      } catch {
        /* Poll readiness; do not infer a command failed from connection loss. */
      }
    }
    assert(connected);
    await clean(admin, book);
    const resumed = await exec(
      process.execPath,
      ['--import', 'tsx', 'tools/worker.ts', 'batch', '100', book],
      {
        env: {
          ...process.env,
          DATABASE_WORKER_URL: process.env['FLOW_TEST_WORKER_URL']!,
        },
        timeout: 30000,
      },
    );
    assert.match(resumed.stdout, /processed/);
    const health = await clean(admin, book);
    assert.equal(health.work.succeeded, 4);
    assert.equal(
      health.work.pending + health.work.processing + health.work.retryable,
      0,
    );
    assert.equal(
      (
        await admin.query(
          'SELECT count(*)::int n FROM ingestion.interpretation i JOIN ingestion.revision r ON r.id=i.revision_id WHERE r.source_account_id=$1',
          [source],
        )
      ).rows[0].n,
      4,
    );
    assert.equal(
      (
        await admin.query(
          'SELECT attempt_count FROM worker.work_item WHERE id=$1',
          [done.id],
        )
      ).rows[0].attempt_count,
      1,
    );
    assert.equal(
      (
        await admin.query(
          "SELECT count(*)::int n FROM worker.attempt_event WHERE work_id=$1 AND kind='EXPIRED'",
          [committed.id],
        )
      ).rows[0].n,
      1,
    );
    await preserved();
    const inspected = await exec(
      process.execPath,
      ['--import', 'tsx', 'tools/integrity.ts', book],
      {
        env: {
          ...process.env,
          DATABASE_INTEGRITY_URL: process.env['FLOW_TEST_INTEGRITY_URL']!,
        },
        timeout: 30000,
      },
    );
    assert.equal(JSON.parse(inspected.stdout).integrity, 'PASS');
    console.log(
      'PHASE11_LOCAL_RESTART ' +
        JSON.stringify({
          recoveryMs: performance.now() - started,
          workItems: 4,
          duplicateDomainEffects: 0,
          unrecoveredWork: 0,
          scope: 'local-single-node-clean-shutdown-restart',
        }),
    );
  } finally {
    if (outstanding) {
      await outstanding.query('ROLLBACK').catch(() => {});
      outstanding.release(true);
    }
    await admin
      .query(
        'UPDATE worker.policy SET lease_ms=30000,timeout_ms=10000,base_delay_ms=100,max_delay_ms=30000 WHERE id=1',
      )
      .catch(() => {});
    await Promise.all([admin, ip, wp].map((p) => p.end()));
  }
});
