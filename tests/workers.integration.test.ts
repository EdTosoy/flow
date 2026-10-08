import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, after, test } from 'node:test';
import { Pool, type PoolClient } from 'pg';
import fc from 'fast-check';
import { PostgresIngestion } from '@flow/ingestion-postgres';
import { normalize, type BatchCommand } from '@flow/ingestion-domain';
import {
  PostgresWorker,
  LostLease,
  UnknownWorkerCommit,
  type Claim,
} from '@flow/worker-postgres';
import { commitDropProxy } from './helpers/commit-proxy';
const adminUrl = process.env['FLOW_TEST_ADMIN_URL']!,
  url = process.env['FLOW_TEST_WORKER_URL']!,
  ingestionUrl = process.env['FLOW_TEST_INGESTION_URL']!;
if (!adminUrl || !url || !ingestionUrl)
  throw new Error('Run pnpm test:integration');
const admin = new Pool({ connectionString: adminUrl }),
  pool = new Pool({ connectionString: url, max: 15 }),
  importPool = new Pool({ connectionString: ingestionUrl });
const worker = new PostgresWorker(pool),
  ingestion = new PostgresIngestion(importPool);
after(async () => {
  await Promise.all([admin.end(), pool.end(), importPool.end()]);
});
before(async () => {
  assert.equal((await admin.query('SHOW fsync')).rows[0].fsync, 'on');
});
async function fixture(count = 1, policy: Record<string, number> = {}) {
  const bookId = randomUUID();
  await admin.query(
    "INSERT INTO ledger.book(id,code,environment) VALUES($1,$2,'synthetic')",
    [bookId, 'worker-' + bookId],
  );
  const source = await ingestion.registerSource({
    bookId,
    environment: 'synthetic',
    provider: 'test-worker',
    externalAccountId: randomUUID(),
  });
  const commands: BatchCommand[] = [];
  const batches: string[] = [];
  if (Object.keys(policy).length)
    await admin.query(
      `UPDATE worker.policy SET ${Object.keys(policy)
        .map((k, i) => {
          if (
            ![
              'lease_ms',
              'timeout_ms',
              'max_attempts',
              'base_delay_ms',
              'max_delay_ms',
            ].includes(k)
          )
            throw new Error('Bad fixture policy');
          return `${k}=$${i + 1}`;
        })
        .join(',')} WHERE id=1`,
      Object.values(policy),
    );
  try {
    for (let i = 0; i < count; i++) {
      const id = randomUUID();
      const command: BatchCommand = {
        sourceAccountId: source,
        batchKey: id,
        actorId: 'worker-test',
        provenance: { adapterVersion: 'test' },
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
                amount: { amountMinor: '9007199254740993', currency: 'PHP' },
                occurredAt: '2026-01-01T00:00:00.000Z',
                paymentReference: 'payment',
                parentCaptureId: null,
              }),
            ),
          },
        ],
      };
      commands.push(command);
      batches.push((await ingestion.ingest(command)).id);
    }
  } finally {
    if (Object.keys(policy).length)
      await admin.query(
        'UPDATE worker.policy SET max_attempts=5,base_delay_ms=100,max_delay_ms=30000,lease_ms=30000,timeout_ms=10000 WHERE id=1',
      );
  }
  return { bookId, source, commands, batches };
}
async function state(id: string) {
  return (await admin.query('SELECT * FROM worker.work_item WHERE id=$1', [id]))
    .rows[0];
}
async function expire(claim: Claim) {
  await admin.query(
    'SELECT pg_sleep(greatest(0,extract(epoch FROM lease_expires_at-clock_timestamp()))+0.005) FROM worker.work_item WHERE id=$1',
    [claim.id],
  );
}
async function due(id: string) {
  await admin.query(
    'SELECT pg_sleep(greatest(0,extract(epoch FROM next_attempt_at-clock_timestamp()))+0.002) FROM worker.work_item WHERE id=$1',
    [id],
  );
}
async function assertOne(batchId: string) {
  assert.equal((await ingestion.summary(batchId)).pending, 0);
  assert.equal(
    (
      await admin.query(
        'SELECT count(*)::int n FROM ingestion.interpretation i JOIN ingestion.raw_record r ON r.revision_id=i.revision_id WHERE r.batch_id=$1',
        [batchId],
      )
    ).rows[0].n,
    1,
  );
}
async function blocked(name: string, n: number) {
  for (let i = 0; i < 500; i++) {
    if (
      Number(
        (
          await admin.query(
            "SELECT count(*) n FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'",
            [name],
          )
        ).rows[0].n,
      ) >= n
    )
      return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('Contention not observed');
}
async function contendedClaims(bookId: string, n: number) {
  const name = randomUUID(),
    p = new Pool({ connectionString: url, max: n, application_name: name }),
    barrier = await admin.connect(),
    key = 71010;
  const clients: PoolClient[] = [];
  try {
    await barrier.query('SELECT pg_advisory_lock($1)', [key]);
    clients.push(
      ...(await Promise.all(Array.from({ length: n }, () => p.connect()))),
    );
    const work = clients.map(async (c, i) => {
      await c.query('BEGIN');
      await c.query('SELECT pg_advisory_xact_lock_shared($1)', [key]);
      const r = await c.query<{ result: Claim | null }>(
        'SELECT worker.claim($1,$2::uuid) AS result',
        ['worker-' + i, bookId],
      );
      await c.query('COMMIT');
      return r.rows[0]!.result;
    });
    await blocked(name, n);
    await barrier.query('SELECT pg_advisory_unlock($1)', [key]);
    return await Promise.all(work);
  } finally {
    await barrier.query('SELECT pg_advisory_unlock_all()');
    barrier.release();
    for (const c of clients) c.release();
    await p.end();
  }
}
test('originating command replay registers one immutable work intent atomically', async () => {
  const f = await fixture();
  assert.equal((await ingestion.ingest(f.commands[0]!)).id, f.batches[0]);
  await ingestion.requestNormalization(
    f.batches[0]!,
    'synthetic-movement-v1',
    'different-actor',
  );
  const r = await admin.query(
    'SELECT count(*)::int n FROM worker.work_item w JOIN outbox.outbox_event o ON o.id=w.event_id WHERE o.batch_id=$1',
    [f.batches[0]],
  );
  assert.equal(r.rows[0].n, 1);
  const c = await worker.claim('test', f.bookId);
  assert(c);
  await worker.handle(c);
  assert(await worker.finish(c));
  await assertOne(f.batches[0]!);
});
test('100 database-barrier-synchronized workers compete for one item: one lease and one handler', async () => {
  const f = await fixture(),
    claims = (await contendedClaims(f.bookId, 100)).filter(
      (c): c is Claim => c !== null,
    );
  assert.equal(claims.length, 1);
  const c = claims[0]!;
  await worker.handle(c);
  assert(await worker.finish(c));
  assert.equal((await state(c.id)).attempt_count, 1);
  await assertOne(f.batches[0]!);
});
test('twelve workers drain 100 independent jobs with no missing work', async () => {
  const f = await fixture(100);
  await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      worker.processBatch('lane-' + i, 100, f.bookId),
    ),
  );
  const r = await admin.query(
    "SELECT count(*)::int n,min(attempt_count)::int min,max(attempt_count)::int max FROM worker.status WHERE book_id=$1 AND state='SUCCEEDED'",
    [f.bookId],
  );
  assert.deepEqual(r.rows[0], { n: 100, min: 1, max: 1 });
  for (const b of f.batches) await assertOne(b);
});
test('crash after claim expires; two synchronized reclaimers get one new token; stale completion and domain writes are fenced', async () => {
  const f = await fixture(1, { lease_ms: 500, timeout_ms: 50 });
  const a = await worker.claim('A', f.bookId);
  assert(a);
  await expire(a);
  const reclaims = (await contendedClaims(f.bookId, 2)).filter(
    (c): c is Claim => c !== null,
  );
  assert.equal(reclaims.length, 1);
  const b = reclaims[0]!;
  assert.notEqual(a.token, b.token);
  assert.equal(b.attempt, 2);
  assert.equal(await worker.finish(a), false);
  await assert.rejects(worker.handle(a), LostLease);
  assert.equal((await state(a.id)).lease_token, b.token);
  await worker.handle(b);
  assert(await worker.finish(b));
  assert.equal(
    (
      await admin.query(
        "SELECT count(*)::int n FROM worker.attempt_event WHERE work_id=$1 AND kind='EXPIRED'",
        [a.id],
      )
    ).rows[0].n,
    1,
  );
});
test('handler COMMIT then crash before acknowledgement replays one existing interpretation', async () => {
  const f = await fixture(1, { lease_ms: 80, timeout_ms: 50 });
  const a = await worker.claim('crash', f.bookId);
  assert(a);
  await worker.handle(a);
  await assertOne(f.batches[0]!);
  await expire(a);
  const b = await worker.claim('restart', f.bookId);
  assert(b);
  await worker.handle(b);
  assert(await worker.finish(b));
  await assertOne(f.batches[0]!);
});
test('completion COMMIT acknowledgement loss resolves by same token; success never redispatches', async () => {
  const f = await fixture(),
    c = await worker.claim('test', f.bookId);
  assert(c);
  await worker.handle(c);
  const proxy = await commitDropProxy(url),
    faultPool = new Pool({ connectionString: proxy.url }),
    faultWorker = new PostgresWorker(faultPool);
  try {
    await assert.rejects(faultWorker.finish(c), UnknownWorkerCommit);
    await proxy.dropped;
    assert.equal((await state(c.id)).state, 'SUCCEEDED');
    assert(await worker.finish(c));
    assert.equal(await worker.claim('restart', f.bookId), null);
    await assertOne(f.batches[0]!);
  } finally {
    await faultPool.end();
    await proxy.close();
  }
});
test('claim COMMIT acknowledgement loss retains an abandoned lease and recovers on restart', async () => {
  const f = await fixture(1, { lease_ms: 80, timeout_ms: 50 }),
    proxy = await commitDropProxy(url),
    p = new Pool({ connectionString: proxy.url });
  try {
    await assert.rejects(
      new PostgresWorker(p).claim('unknown-claim', f.bookId),
      UnknownWorkerCommit,
    );
    await proxy.dropped;
    const c = (
      await admin.query<{ id: string }>(
        'SELECT id FROM worker.status WHERE book_id=$1',
        [f.bookId],
      )
    ).rows[0]!;
    const w = await state(c.id);
    await expire({ id: w.id } as Claim);
    assert(await worker.processOne('restart', f.bookId));
    await assertOne(f.batches[0]!);
  } finally {
    await p.end();
    await proxy.close();
  }
});
test('domain COMMIT acknowledgement loss keeps its effect; unchanged handler replay converges', async () => {
  const f = await fixture(),
    c = await worker.claim('test', f.bookId);
  assert(c);
  const proxy = await commitDropProxy(url),
    p = new Pool({ connectionString: proxy.url });
  try {
    await assert.rejects(new PostgresWorker(p).handle(c), UnknownWorkerCommit);
    await proxy.dropped;
    await worker.handle(c);
    assert(await worker.finish(c));
    await assertOne(f.batches[0]!);
  } finally {
    await p.end();
    await proxy.close();
  }
});
test('bounded deterministic backoff and terminal exhaustion preserve every attempt', async () => {
  const f = await fixture(1, {
    max_attempts: 3,
    base_delay_ms: 5,
    max_delay_ms: 8,
  });
  let c = await worker.claim('retry', f.bookId);
  assert(c);
  for (let i = 1; i <= 3; i++) {
    assert(
      await worker.finish(c, { classification: 'TRANSIENT', code: '08006' }),
    );
    const w = await state(c.id);
    assert.equal(w.attempt_count, i);
    if (i < 3) {
      assert.equal(w.state, 'RETRYABLE');
      const e = (
        await admin.query(
          "SELECT extract(epoch FROM (w.next_attempt_at-e.recorded_at))*1000 AS delay FROM worker.work_item w JOIN worker.attempt_event e ON e.work_id=w.id AND e.attempt=w.attempt_count AND e.kind='FAILED' WHERE w.id=$1",
          [c.id],
        )
      ).rows[0];
      assert(Number(e.delay) >= (i === 1 ? 5 : 8));
      await due(c.id);
      c = await worker.claim('retry', f.bookId);
      assert(c);
    } else assert.equal(w.state, 'FAILED_TERMINAL');
  }
  assert.equal(await worker.claim('restart', f.bookId), null);
  assert.equal(
    (
      await admin.query(
        'SELECT count(*)::int n FROM worker.attempt_event WHERE work_id=$1',
        [c.id],
      )
    ).rows[0].n,
    6,
  );
});
test('permanent domain/poison/unsupported failures stop at first attempt and other jobs progress', async () => {
  const f = await fixture(4);
  for (const classification of [
    'DOMAIN_REJECTION',
    'POISON',
    'UNSUPPORTED',
  ] as const) {
    const c = await worker.claim('fail', f.bookId);
    assert(c);
    assert(
      await worker.finish(c, { classification, code: 'EXPLICIT_REJECTION' }),
    );
    assert.equal((await state(c.id)).state, 'FAILED_TERMINAL');
  }
  assert(await worker.processOne('healthy', f.bookId));
  assert.equal(await worker.claim('empty', f.bookId), null);
});
test('malformed durable payload becomes visible poison; unrelated work succeeds', async () => {
  const f = await fixture(0);
  await admin.query(
    "CREATE FUNCTION public.phase10_poison() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.payload:=NEW.payload||jsonb_build_object('unexpected','malformed'); RETURN NEW; END $$; CREATE TRIGGER phase10_poison BEFORE INSERT ON outbox.outbox_event FOR EACH ROW WHEN(NEW.event_type='ingestion.normalization_requested') EXECUTE FUNCTION public.phase10_poison()",
  );
  try {
    const id = randomUUID();
    await ingestion.ingest({
      sourceAccountId: f.source,
      batchKey: id,
      actorId: 'test',
      provenance: {},
      records: [],
    });
  } finally {
    await admin.query(
      'DROP TRIGGER phase10_poison ON outbox.outbox_event; DROP FUNCTION public.phase10_poison()',
    );
  }
  assert(await worker.processOne('poison', f.bookId));
  const row = (
    await admin.query(
      'SELECT state,last_failure_class,last_failure_code FROM worker.status WHERE book_id=$1',
      [f.bookId],
    )
  ).rows[0];
  assert.deepEqual(row, {
    state: 'FAILED_TERMINAL',
    last_failure_class: 'POISON',
    last_failure_code: 'INVALID_PAYLOAD',
  });
  const healthy = await fixture();
  assert(await worker.processOne('healthy', healthy.bookId));
});
test('unknown pinned normalizer is explicitly unsupported; raw malformed records get existing FAILED dispositions', async () => {
  const f = await fixture();
  await admin.query(
    "INSERT INTO ingestion.normalizer_version VALUES('phase10-unsupported','Synthetic unsupported historical policy')",
  );
  await importPool.query('SELECT ingestion.request_normalization($1,$2,$3)', [
    f.batches[0],
    'phase10-unsupported',
    'test',
  ]);
  await worker.processBatch('registry', 10, f.bookId);
  const r = await admin.query(
    'SELECT state,last_failure_code FROM worker.status WHERE book_id=$1 ORDER BY state',
    [f.bookId],
  );
  assert(
    r.rows.some(
      (x) =>
        x.state === 'FAILED_TERMINAL' &&
        x.last_failure_code === 'UNSUPPORTED_NORMALIZER',
    ),
  );
  const malformed = await ingestion.ingest({
    sourceAccountId: f.source,
    batchKey: randomUUID(),
    actorId: 'test',
    provenance: {},
    records: [{ ...f.commands[0]!.records[0]!, bytes: Buffer.from('{broken') }],
  });
  await worker.processOne('raw-malformed', f.bookId);
  assert.equal((await ingestion.summary(malformed.id)).failed, 1);
});
test('worker role has only fenced capabilities; history and outbox immutable even via ordinary owner SQL', async () => {
  const f = await fixture(),
    c = await worker.claim('permissions', f.bookId);
  assert(c);
  for (const sql of [
    "UPDATE worker.work_item SET state='SUCCEEDED'",
    'DELETE FROM worker.attempt_event',
    "UPDATE outbox.outbox_event SET payload='{}'",
    "SELECT ledger.post_journal('{}')",
    "SELECT exceptions.generate('{}')",
    'SELECT controls.complete(gen_random_uuid())',
    "SELECT ingestion.complete_normalization(gen_random_uuid(),'synthetic-movement-v1','{}')",
  ]) {
    await assert.rejects(
      pool.query(sql),
      (e) =>
        typeof e === 'object' &&
        e !== null &&
        'code' in e &&
        e.code === '42501',
    );
  }
  for (const sql of [
    "UPDATE worker.work_item SET state='PENDING' WHERE id=$1",
    'UPDATE worker.work_item SET event_id=gen_random_uuid() WHERE id=$1',
    'DELETE FROM worker.work_item WHERE id=$1',
    "UPDATE worker.attempt_event SET kind='FAILED' WHERE work_id=$1",
    'DELETE FROM worker.registration WHERE event_id=(SELECT event_id FROM worker.work_item WHERE id=$1)',
  ]) {
    await assert.rejects(admin.query(sql, [c.id]));
  }
  assert.equal(
    (await pool.query('SELECT worker.finish($1::uuid,NULL) AS ok', [c.id]))
      .rows[0].ok,
    false,
  );
  await worker.handle(c);
  assert(await worker.finish(c));
  await assert.rejects(
    admin.query("UPDATE worker.work_item SET state='RETRYABLE' WHERE id=$1", [
      c.id,
    ]),
  );
});
test('expired crashed attempts exhaust budget without losing terminal evidence', async () => {
  const f = await fixture(1, { lease_ms: 20, timeout_ms: 10, max_attempts: 2 });
  const a = await worker.claim('crash-1', f.bookId);
  assert(a);
  await expire(a);
  const b = await worker.claim('crash-2', f.bookId);
  assert(b);
  await expire(b);
  assert.equal(await worker.claim('sweeper', f.bookId), null);
  const w = await state(b.id);
  assert.equal(w.state, 'FAILED_TERMINAL');
  assert.equal(w.last_failure_class, 'LEASE_EXPIRED');
  assert.equal(
    (
      await admin.query(
        "SELECT count(*)::int n FROM worker.attempt_event WHERE work_id=$1 AND kind='EXPIRED'",
        [b.id],
      )
    ).rows[0].n,
    2,
  );
});
test('failure before claim COMMIT and before completion COMMIT rolls back state/history atomically', async () => {
  const f = await fixture(),
    c = await pool.connect();
  let claim: Claim;
  try {
    await c.query('BEGIN');
    claim = (
      await c.query<{ r: Claim }>('SELECT worker.claim($1,$2) r', [
        'rollback',
        f.bookId,
      ])
    ).rows[0]!.r;
    await c.query('ROLLBACK');
    assert.equal((await state(claim.id)).state, 'PENDING');
    assert.equal((await state(claim.id)).attempt_count, 0);
    const live = await worker.claim('live', f.bookId);
    assert(live);
    await worker.handle(live);
    await c.query('BEGIN');
    await c.query('SELECT worker.finish($1,$2)', [live.id, live.token]);
    await c.query('ROLLBACK');
    assert.equal((await state(live.id)).state, 'PROCESSING');
    assert(await worker.finish(live));
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
});
test('crash before handler and backend death during domain transaction leave replayable pending work', async () => {
  const f = await fixture(),
    claim = await worker.claim('crash', f.bookId);
  assert(claim);
  assert.equal((await ingestion.summary(f.batches[0]!)).pending, 1);
  const c = await pool.connect(),
    raw = (
      await admin.query(
        'SELECT * FROM ingestion.raw_record WHERE batch_id=$1',
        [f.batches[0]],
      )
    ).rows[0];
  c.on('error', () => {});
  try {
    await c.query('BEGIN');
    const pid = (await c.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    await c.query('SELECT worker.complete_normalization($1,$2,$3,$4)', [
      claim.id,
      claim.token,
      raw.id,
      JSON.stringify(
        normalize(raw.payload_bytes, raw.external_id, 'synthetic-movement-v1'),
      ),
    ]);
    await admin.query('SELECT pg_terminate_backend($1)', [pid]);
    await assert.rejects(c.query('COMMIT'));
  } finally {
    c.release(true);
  }
  assert.equal((await ingestion.summary(f.batches[0]!)).pending, 1);
  await worker.handle(claim);
  assert(await worker.finish(claim));
  await assertOne(f.batches[0]!);
});
test('serialization/deadlock SQLSTATE injections retry whole claim/domain/completion transaction', async () => {
  for (const stateCode of ['40001', '40P01']) {
    const f = await fixture();
    await admin.query(
      `CREATE SEQUENCE public.phase10_fault_seq; GRANT USAGE ON SEQUENCE public.phase10_fault_seq TO flow_ledger_owner; CREATE FUNCTION public.phase10_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF nextval('public.phase10_fault_seq')=1 THEN RAISE EXCEPTION USING ERRCODE='${stateCode}',MESSAGE='test transient'; END IF; RETURN NEW; END $$; CREATE TRIGGER phase10_fault BEFORE UPDATE ON worker.work_item FOR EACH ROW EXECUTE FUNCTION public.phase10_fault()`,
    );
    try {
      assert(await worker.processOne('retry-transaction', f.bookId));
      await assertOne(f.batches[0]!);
      const r = (
        await admin.query(
          'SELECT attempt_count FROM worker.status WHERE book_id=$1',
          [f.bookId],
        )
      ).rows[0];
      assert.equal(r.attempt_count, 1);
    } finally {
      await admin.query(
        'DROP TRIGGER phase10_fault ON worker.work_item; DROP FUNCTION public.phase10_fault(); DROP SEQUENCE public.phase10_fault_seq',
      );
    }
  }
});
test('timeout safely stops new domain steps; guarded late work cannot write after retry transition', async () => {
  const f = await fixture(1, { timeout_ms: 10 }),
    lock = await admin.connect();
  await lock.query('BEGIN');
  const raw = (
    await admin.query('SELECT * FROM ingestion.raw_record WHERE batch_id=$1', [
      f.batches[0],
    ])
  ).rows[0];
  await lock.query('SELECT 1 FROM ingestion.revision WHERE id=$1 FOR UPDATE', [
    raw.revision_id,
  ]);
  const processing = worker.processOne('timeout', f.bookId);
  await new Promise((r) => setTimeout(r, 30));
  await lock.query('ROLLBACK');
  lock.release();
  assert(await processing);
  const w = (
    await admin.query('SELECT * FROM worker.status WHERE book_id=$1', [
      f.bookId,
    ])
  ).rows[0];
  assert.equal(w.state, 'RETRYABLE');
  assert.equal(w.last_failure_class, 'TIMEOUT');
  await due(w.id);
  assert(await worker.processOne('timeout-restart', f.bookId));
  await assertOne(f.batches[0]!);
});
test('30 generated retry/replay schedules preserve monotonic counts, unique tokens, success finality, history and payload', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.boolean(), { minLength: 0, maxLength: 3 }),
      async (failures) => {
        const f = await fixture(1, { base_delay_ms: 1, max_delay_ms: 1 });
        let c = await worker.claim('property', f.bookId);
        assert(c);
        const tokens = new Set([c.token]);
        const payload = JSON.stringify(c.payload);
        for (const crash of failures) {
          if (crash) await worker.handle(c);
          assert(
            await worker.finish(c, {
              classification: 'TRANSIENT',
              code: '08006',
            }),
          );
          await due(c.id);
          const n = await worker.claim('property', f.bookId);
          assert(n);
          assert.equal(n.attempt, c.attempt + 1);
          assert(!tokens.has(n.token));
          tokens.add(n.token);
          assert.equal(JSON.stringify(n.payload), payload);
          c = n;
        }
        await worker.handle(c);
        assert(await worker.finish(c));
        assert(await worker.finish(c));
        assert.equal(await worker.claim('later', f.bookId), null);
        await assertOne(f.batches[0]!);
        assert.equal(
          (
            await admin.query(
              "SELECT count(*)::int n FROM worker.attempt_event WHERE work_id=$1 AND kind IN ('FAILED','SUCCEEDED')",
              [c.id],
            )
          ).rows[0].n,
          failures.length + 1,
        );
      },
    ),
    { numRuns: 30, seed: 71003 },
  );
});

test('duplicate fenced domain command reuses original semantic effect before acknowledgement', async () => {
  const f = await fixture(),
    claim = await worker.claim('semantic-replay', f.bookId);
  assert(claim);
  const raw = (
    await admin.query('SELECT * FROM ingestion.raw_record WHERE batch_id=$1', [
      f.batches[0],
    ])
  ).rows[0];
  const result = JSON.stringify(
    normalize(raw.payload_bytes, raw.external_id, 'synthetic-movement-v1'),
  );
  for (let i = 0; i < 3; i++)
    assert.equal(
      (
        await pool.query(
          'SELECT worker.complete_normalization($1,$2,$3,$4) ok',
          [claim.id, claim.token, raw.id, result],
        )
      ).rows[0].ok,
      true,
    );
  await assertOne(f.batches[0]!);
  assert(await worker.finish(claim));
});
test('registration failure or suppressed registration rolls back source transaction and required intent', async () => {
  const f = await fixture(0);
  await admin.query(
    'CREATE FUNCTION public.phase10_registration_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$; CREATE TRIGGER phase10_registration_fault BEFORE INSERT ON worker.registration FOR EACH ROW EXECUTE FUNCTION public.phase10_registration_fault()',
  );
  try {
    await assert.rejects(
      ingestion.ingest({
        sourceAccountId: f.source,
        batchKey: randomUUID(),
        actorId: 'test',
        provenance: {},
        records: [],
      }),
    );
    assert.equal(
      (
        await admin.query(
          'SELECT count(*)::int n FROM ingestion.batch WHERE source_account_id=$1',
          [f.source],
        )
      ).rows[0].n,
      0,
    );
  } finally {
    await admin.query(
      'DROP TRIGGER phase10_registration_fault ON worker.registration; DROP FUNCTION public.phase10_registration_fault()',
    );
  }
});
test('domain and completion transient failure injections retry without duplicating outputs or attempts', async () => {
  for (const target of ['ingestion.interpretation', 'worker.attempt_event']) {
    const f = await fixture(),
      claim = await worker.claim('transient', f.bookId);
    assert(claim);
    await admin.query(
      `CREATE SEQUENCE public.phase10_stage_seq; GRANT USAGE ON SEQUENCE public.phase10_stage_seq TO flow_ledger_owner; CREATE FUNCTION public.phase10_stage_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF nextval('public.phase10_stage_seq')=1 THEN RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='test-only transient'; END IF; RETURN NEW; END $$; CREATE TRIGGER phase10_stage_fault BEFORE INSERT ON ${target} FOR EACH ROW EXECUTE FUNCTION public.phase10_stage_fault()`,
    );
    try {
      await worker.handle(claim);
      assert(await worker.finish(claim));
      await assertOne(f.batches[0]!);
      assert.equal((await state(claim.id)).attempt_count, 1);
    } finally {
      await admin.query(
        `DROP TRIGGER phase10_stage_fault ON ${target}; DROP FUNCTION public.phase10_stage_fault(); DROP SEQUENCE public.phase10_stage_seq`,
      );
    }
  }
});
