import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Pool } from 'pg';
import { generateSimulation } from '@flow/simulator-oracle';
import { PostgresIngestion } from '@flow/ingestion-postgres';
import { PostgresWorker } from '@flow/worker-postgres';
import { simulatorBatch } from '../tools/ingestion-input';
const exec = promisify(execFile);
test('public simulator → atomic ingestion intent → async normalization, crash/replay and untouched oracle/ledger boundaries', async () => {
  const admin = new Pool({
      connectionString: process.env['FLOW_TEST_ADMIN_URL'],
    }),
    ip = new Pool({ connectionString: process.env['FLOW_TEST_INGESTION_URL'] }),
    wp = new Pool({ connectionString: process.env['FLOW_TEST_WORKER_URL'] });
  try {
    const book = randomUUID();
    await admin.query(
      "INSERT INTO ledger.book(id,code,environment) VALUES($1,$2,'synthetic')",
      [book, 'sim-worker-' + book],
    );
    const sim = generateSimulation({
      seed: 71004,
      paymentCount: 100,
      anomalies: {
        'duplicate-source-event': { count: 10 },
        'corrupted-source-record': { count: 2 },
      },
    });
    const api = new PostgresIngestion(ip),
      worker = new PostgresWorker(wp),
      source = await api.registerSource({
        bookId: book,
        environment: 'synthetic',
        provider: 'synthetic-simulator',
        externalAccountId: sim.input.scope.processorAccountId,
      });
    const cmd = simulatorBatch(sim.input, source, 'public-async'),
      batch = await api.ingest(cmd);
    assert.equal(
      (await api.summary(batch.id)).pending,
      sim.input.processorEvents.length,
    );
    assert(await worker.processOne('simulation', book));
    const summary = await api.summary(batch.id);
    assert.equal(summary.pending, 0);
    assert.equal(summary.failed, 2);
    assert.equal(summary.normalized, summary.received - 2);
    assert.equal(summary.completeness, 'UNKNOWN');
    assert.equal(summary.distinctRevisions, summary.received - 10);
    assert.equal((await api.ingest(cmd)).id, batch.id);
    assert.equal(await worker.processOne('replay', book), false);
    assert.equal(
      (
        await admin.query(
          'SELECT count(*)::int n FROM ledger.ledger_transaction WHERE book_id=$1',
          [book],
        )
      ).rows[0].n,
      0,
    );
    // Private truth is read only here, after the runtime has independently produced its dispositions.
    assert.equal(
      sim.oracle.anomalies.filter((a) => a.kind === 'corrupted-source-record')
        .length,
      2,
    );
  } finally {
    await Promise.all([admin.end(), ip.end(), wp.end()]);
  }
});
test('separate CLI processes enqueue, process, restart and inspect retained state; graceful shutdown stops polling', async () => {
  const admin = new Pool({
      connectionString: process.env['FLOW_TEST_ADMIN_URL'],
    }),
    ip = new Pool({ connectionString: process.env['FLOW_TEST_INGESTION_URL'] });
  try {
    const book = randomUUID();
    await admin.query(
      "INSERT INTO ledger.book(id,code,environment) VALUES($1,$2,'synthetic')",
      [book, 'cli-worker-' + book],
    );
    const sim = generateSimulation({ seed: 71005, paymentCount: 5 }),
      dir = await mkdtemp(join(tmpdir(), 'flow-workers-cli-')),
      file = join(dir, 'public.json');
    await writeFile(file, JSON.stringify(sim.input));
    const env = {
      ...process.env,
      DATABASE_WORKER_URL: process.env['FLOW_TEST_WORKER_URL'],
      DATABASE_INGESTION_URL: process.env['FLOW_TEST_INGESTION_URL'],
    };
    const call = (args: string[]) =>
      exec(process.execPath, ['--import', 'tsx', 'tools/worker.ts', ...args], {
        env,
      });
    const initial = JSON.parse(
      (await call(['enqueue', file, book, 'cli-work'])).stdout,
    );
    assert(initial.pending > 0);
    const processed = await call(['once', book]);
    assert(processed.stdout.includes('SUCCEEDED'));
    const replay = await call(['batch', '10', book]);
    assert.equal(JSON.parse(replay.stdout).processed, 0);
    const api = new PostgresIngestion(ip);
    assert.equal((await api.summary(initial.batchId)).pending, 0);
    assert((await call(['status', 'SUCCEEDED'])).stdout.includes('event_id'));
    const running = execFile(
      process.execPath,
      ['--import', 'tsx', 'tools/worker.ts', 'start', book],
      { env },
    );
    await new Promise<void>((resolve, reject) => {
      running.on('error', reject);
      setTimeout(() => running.kill('SIGTERM'), 500);
      running.on('exit', (code, signal) =>
        code === 0 && signal === null
          ? resolve()
          : reject(new Error('Graceful worker failed')),
      );
    });
  } finally {
    await Promise.all([admin.end(), ip.end()]);
  }
});

test('full process restart recovers pending, due retry and abandoned lease; retains succeeded and terminal items', async () => {
  const admin = new Pool({
      connectionString: process.env['FLOW_TEST_ADMIN_URL'],
    }),
    ip = new Pool({ connectionString: process.env['FLOW_TEST_INGESTION_URL'] }),
    wp = new Pool({ connectionString: process.env['FLOW_TEST_WORKER_URL'] });
  try {
    const book = randomUUID();
    await admin.query(
      "INSERT INTO ledger.book(id,code,environment) VALUES($1,$2,'synthetic')",
      [book, 'restart-' + book],
    );
    const input = generateSimulation({ seed: 71006, paymentCount: 1 }).input,
      api = new PostgresIngestion(ip),
      worker = new PostgresWorker(wp),
      source = await api.registerSource({
        bookId: book,
        environment: 'synthetic',
        provider: 'restart',
        externalAccountId: book,
      });
    await admin.query(
      'UPDATE worker.policy SET lease_ms=200,timeout_ms=100 WHERE id=1',
    );
    try {
      for (let i = 0; i < 5; i++)
        await api.ingest(simulatorBatch(input, source, 'restart-' + i));
    } finally {
      await admin.query(
        'UPDATE worker.policy SET lease_ms=30000,timeout_ms=10000 WHERE id=1',
      );
    }
    const success = await worker.claim('prior-success', book);
    assert(success);
    await worker.handle(success);
    assert(await worker.finish(success));
    const retry = await worker.claim('prior-retry', book);
    assert(retry);
    assert(
      await worker.finish(retry, {
        classification: 'TRANSIENT',
        code: '08006',
      }),
    );
    const terminal = await worker.claim('prior-terminal', book);
    assert(terminal);
    assert(
      await worker.finish(terminal, {
        classification: 'POISON',
        code: 'INVALID_PAYLOAD',
      }),
    );
    // A separate worker process commits a claim and exits before running its handler.
    const env = {
      ...process.env,
      DATABASE_WORKER_URL: process.env['FLOW_TEST_WORKER_URL'],
      FLOW_RESTART_BOOK: book,
    };
    await exec(
      process.execPath,
      [
        '--import',
        'tsx',
        '--eval',
        "const {Pool}=require('pg'); const {PostgresWorker}=require('./libs/worker-postgres/src/index.ts'); (async()=>{const p=new Pool({connectionString:process.env.DATABASE_WORKER_URL});await new PostgresWorker(p).claim('crashed-process',process.env.FLOW_RESTART_BOOK);await p.end();})().catch(()=>process.exitCode=1);",
      ],
      { env },
    );
    await admin.query(
      'SELECT pg_sleep(greatest(0,extract(epoch FROM max(lease_expires_at)-clock_timestamp()))+0.005) FROM worker.status WHERE book_id=$1',
      [book],
    );
    await exec(
      process.execPath,
      ['--import', 'tsx', 'tools/worker.ts', 'batch', '10', book],
      { env },
    );
    const rows = (
      await admin.query(
        'SELECT id,state,attempt_count FROM worker.status WHERE book_id=$1',
        [book],
      )
    ).rows;
    assert.equal(rows.filter((r) => r.state === 'SUCCEEDED').length, 4);
    assert.equal(rows.filter((r) => r.state === 'FAILED_TERMINAL').length, 1);
    assert.equal(rows.find((r) => r.id === success.id).attempt_count, 1);
    assert.equal(rows.find((r) => r.id === terminal.id).attempt_count, 1);
    assert.equal(rows.find((r) => r.id === retry.id).attempt_count, 2);
  } finally {
    await Promise.all([admin.end(), ip.end(), wp.end()]);
  }
});

test('SIGTERM during an active handler drains its attempt and leaves the next item pending', async () => {
  const admin = new Pool({
      connectionString: process.env['FLOW_TEST_ADMIN_URL'],
    }),
    ip = new Pool({ connectionString: process.env['FLOW_TEST_INGESTION_URL'] });
  const lock = await admin.connect();
  let child: ReturnType<typeof execFile> | undefined;
  try {
    const book = randomUUID();
    await admin.query(
      "INSERT INTO ledger.book(id,code,environment) VALUES($1,$2,'synthetic')",
      [book, 'shutdown-' + book],
    );
    const input = generateSimulation({ seed: 71007, paymentCount: 1 }).input,
      api = new PostgresIngestion(ip),
      source = await api.registerSource({
        bookId: book,
        environment: 'synthetic',
        provider: 'shutdown',
        externalAccountId: book,
      });
    const first = await api.ingest(simulatorBatch(input, source, 'shutdown-1'));
    await api.ingest(simulatorBatch(input, source, 'shutdown-2'));
    const raw = (
      await admin.query(
        'SELECT revision_id FROM ingestion.raw_record WHERE batch_id=$1 ORDER BY receipt_order LIMIT 1',
        [first.id],
      )
    ).rows[0];
    await lock.query('BEGIN');
    await lock.query(
      'SELECT 1 FROM ingestion.revision WHERE id=$1 FOR UPDATE',
      [raw.revision_id],
    );
    child = execFile(
      process.execPath,
      ['--import', 'tsx', 'tools/worker.ts', 'start', book],
      {
        env: {
          ...process.env,
          DATABASE_WORKER_URL: process.env['FLOW_TEST_WORKER_URL'],
        },
      },
    );
    const finished = new Promise<void>((resolve, reject) => {
      child!.on('error', reject);
      child!.on('exit', (code, signal) =>
        code === 0 && signal === null
          ? resolve()
          : reject(new Error('Active shutdown did not drain')),
      );
    });
    let waiting = false;
    for (let i = 0; i < 300; i++) {
      if (
        Number(
          (
            await admin.query(
              "SELECT count(*) n FROM pg_stat_activity WHERE usename='flow_test_worker' AND wait_event_type='Lock'",
            )
          ).rows[0].n,
        ) > 0
      ) {
        waiting = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    assert(waiting, 'Handler contention not established');
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 20));
    await lock.query('ROLLBACK');
    await finished;
    const rows = (
      await admin.query('SELECT state FROM worker.status WHERE book_id=$1', [
        book,
      ])
    ).rows;
    assert.equal(rows.filter((r) => r.state === 'SUCCEEDED').length, 1);
    assert.equal(rows.filter((r) => r.state === 'PENDING').length, 1);
  } finally {
    child?.kill('SIGTERM');
    await lock.query('ROLLBACK');
    lock.release();
    await Promise.all([admin.end(), ip.end()]);
  }
});

test('three concurrent CLI worker processes drain one shared queue without missing or duplicated effects', async () => {
  const admin = new Pool({
      connectionString: process.env['FLOW_TEST_ADMIN_URL'],
    }),
    ip = new Pool({ connectionString: process.env['FLOW_TEST_INGESTION_URL'] });
  try {
    const book = randomUUID();
    await admin.query(
      "INSERT INTO ledger.book(id,code,environment) VALUES($1,$2,'synthetic')",
      [book, 'processes-' + book],
    );
    const input = generateSimulation({ seed: 71008, paymentCount: 1 }).input,
      api = new PostgresIngestion(ip),
      source = await api.registerSource({
        bookId: book,
        environment: 'synthetic',
        provider: 'processes',
        externalAccountId: book,
      });
    const batches: string[] = [];
    for (let i = 0; i < 30; i++)
      batches.push(
        (await api.ingest(simulatorBatch(input, source, 'process-' + i))).id,
      );
    const env = {
      ...process.env,
      DATABASE_WORKER_URL: process.env['FLOW_TEST_WORKER_URL'],
    };
    const results = await Promise.all(
      Array.from({ length: 3 }, () =>
        exec(
          process.execPath,
          ['--import', 'tsx', 'tools/worker.ts', 'batch', '100', book],
          { env },
        ),
      ),
    );
    assert.equal(
      results
        .map(
          (r) =>
            JSON.parse(r.stdout.trim().split('\n').at(-1)!).processed as number,
        )
        .reduce((a, b) => a + b, 0),
      30,
    );
    const rows = (
      await admin.query(
        "SELECT count(*)::int n,min(attempt_count)::int min,max(attempt_count)::int max FROM worker.status WHERE book_id=$1 AND state='SUCCEEDED'",
        [book],
      )
    ).rows[0];
    assert.deepEqual(rows, { n: 30, min: 1, max: 1 });
    for (const batch of batches)
      assert.equal((await api.summary(batch)).pending, 0);
    const unique = (
      await admin.query(
        'SELECT count(DISTINCT p.revision_id)::int n FROM ingestion.processing p JOIN ingestion.raw_record r ON r.id=p.raw_id JOIN ingestion.batch b ON b.id=r.batch_id WHERE b.source_account_id=$1',
        [source],
      )
    ).rows[0].n;
    assert.equal(unique, input.processorEvents.length);
    // Each process reports its distinct persisted lease-owner identity through started history.
    assert(
      (
        await admin.query(
          "SELECT count(DISTINCT e.owner)::int n FROM worker.attempt_event e JOIN worker.status w ON w.id=e.work_id WHERE w.book_id=$1 AND e.kind='STARTED'",
          [book],
        )
      ).rows[0].n >= 2,
    );
    const overlaps = await admin.query(
      "SELECT count(*)::int n FROM worker.attempt_event a JOIN worker.attempt_event ae ON ae.work_id=a.work_id AND ae.attempt=a.attempt AND ae.kind='SUCCEEDED' JOIN worker.attempt_event b ON b.owner<>a.owner AND b.kind='STARTED' JOIN worker.attempt_event be ON be.work_id=b.work_id AND be.attempt=b.attempt AND be.kind='SUCCEEDED' JOIN worker.status w ON w.id=a.work_id JOIN worker.status wb ON wb.id=b.work_id WHERE w.book_id=$1 AND wb.book_id=$1 AND a.kind='STARTED' AND a.recorded_at<be.recorded_at AND b.recorded_at<ae.recorded_at",
      [book],
    );
    assert(
      overlaps.rows[0].n > 0,
      'Concurrent process attempt windows must actually overlap',
    );
  } finally {
    await Promise.all([admin.end(), ip.end()]);
  }
});
