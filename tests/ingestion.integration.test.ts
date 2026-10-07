import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, after, test } from 'node:test';
import { Pool, type PoolClient } from 'pg';
import fc from 'fast-check';
import {
  PostgresIngestion,
  UnknownIngestionCommit,
} from '@flow/ingestion-postgres';
import {
  canonicalJson,
  batchPayload,
  normalize,
  sha256,
  type BatchCommand,
  type RawInput,
} from '@flow/ingestion-domain';
import { commitDropProxy } from './helpers/commit-proxy';
const adminUrl = process.env['FLOW_TEST_ADMIN_URL'];
const url = process.env['FLOW_TEST_INGESTION_URL'];
if (!adminUrl || !url)
  throw new Error('Run pnpm test:integration with disposable PostgreSQL');
const admin = new Pool({ connectionString: adminUrl });
const writer = new Pool({ connectionString: url, max: 25 });
const ingestion = new PostgresIngestion(writer);
const bookId = randomUUID();
let account: string;
before(async () => {
  await admin.query(
    'INSERT INTO ledger.book(id,code,environment) VALUES($1,$2,$3)',
    [bookId, `ingestion-${bookId}`, 'synthetic'],
  );
  account = await ingestion.registerSource({
    bookId,
    environment: 'synthetic',
    provider: 'generic-synthetic',
    externalAccountId: 'account-1',
  });
});
after(async () => {
  await Promise.all([admin.end(), writer.end()]);
});
function record(
  id: string = randomUUID(),
  amount = '970000',
  time = '2026-01-01T00:00:00.000Z',
): RawInput {
  return {
    locator: '0',
    objectKind: 'movement',
    externalId: id,
    sourceRevision: null,
    sequence: null,
    sourceObservedAt: null,
    bytes: Buffer.from(
      canonicalJson({
        id,
        kind: 'capture',
        amount: { amountMinor: amount, currency: 'PHP' },
        occurredAt: time,
        paymentReference: 'pay-1',
        parentCaptureId: null,
      }),
    ),
  };
}
function command(records: readonly RawInput[] = [record()]): BatchCommand {
  return {
    sourceAccountId: account,
    batchKey: randomUUID(),
    actorId: 'integration-test',
    provenance: { adapterVersion: 'generic-v1' },
    records,
  };
}
async function rawIds(batchId: string): Promise<string[]> {
  return (
    await writer.query<{ id: string }>(
      'SELECT id FROM ingestion.raw_record WHERE batch_id=$1 ORDER BY receipt_order',
      [batchId],
    )
  ).rows.map((r) => r.id);
}
function code(value: string): (e: unknown) => boolean {
  return (e) => !!e && typeof e === 'object' && 'code' in e && e.code === value;
}
async function rejectedTx(
  fn: (c: PoolClient) => Promise<unknown>,
  expected: string,
): Promise<void> {
  const c = await admin.connect();
  try {
    await c.query('BEGIN');
    await assert.rejects(async () => {
      await fn(c);
      await c.query('COMMIT');
    }, code(expected));
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}
async function blocked(name: string, n: number): Promise<void> {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    const r = await admin.query<{ count: string }>(
      "SELECT count(*)::text FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'",
      [name],
    );
    if (Number(r.rows[0]!.count) >= n) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('Contention not established');
}
async function contend(
  lockSql: string,
  params: unknown[],
  work: (api: PostgresIngestion, index: number) => Promise<unknown>,
  n = 12,
): Promise<unknown[]> {
  const name = randomUUID();
  const pool = new Pool({
    connectionString: url,
    application_name: name,
    max: n,
  });
  const api = new PostgresIngestion(pool);
  const locker = await admin.connect();
  try {
    await locker.query('BEGIN');
    await locker.query(lockSql, params);
    const pending = Array.from({ length: n }, (_, i) => work(api, i));
    await blocked(name, n);
    await locker.query('COMMIT');
    return await Promise.all(pending);
  } finally {
    await locker.query('ROLLBACK');
    locker.release();
    await pool.end();
  }
}
test('raw exact bytes, integrity, scope and audit/outbox; pending survives before normalization', async () => {
  const r = record();
  const c = {
    ...command([r]),
    artifactBytes: Uint8Array.from([0, 255, 1]),
    manifestBytes: Buffer.from('manifest'),
  };
  const batch = await ingestion.ingest(c);
  const rows = await writer.query<{ payload_bytes: Buffer; checksum: string }>(
    'SELECT payload_bytes,checksum FROM ingestion.raw_record WHERE batch_id=$1',
    [batch.id],
  );
  assert.deepEqual(rows.rows[0]!.payload_bytes, Buffer.from(r.bytes));
  assert.equal(rows.rows[0]!.checksum, sha256(r.bytes));
  assert.equal((await ingestion.summary(batch.id)).pending, 1);
  const companions = await writer.query<{ audit: string; outbox: string }>(
    'SELECT (SELECT count(*)::text FROM audit.audit_event WHERE batch_id=$1) AS audit,(SELECT count(*)::text FROM outbox.outbox_event WHERE batch_id=$1) AS outbox',
    [batch.id],
  );
  assert.deepEqual(companions.rows[0], { audit: '2', outbox: '1' });
  const summary = await ingestion.normalizeBatch(batch.id);
  assert.equal(summary.normalized, 1);
  assert.equal(summary.completeness, 'UNKNOWN');
  assert.deepEqual(await ingestion.ingest({ ...c, actorId: 'retry-actor' }), {
    id: batch.id,
    replayed: true,
  });
  await assert.rejects(
    ingestion.ingest({ ...c, records: [record(r.externalId!, '960000')] }),
    code('P2001'),
  );
  const other = await ingestion.registerSource({
    bookId,
    environment: 'synthetic',
    provider: 'generic-synthetic',
    externalAccountId: 'account-2',
  });
  const otherBatch = await ingestion.ingest({
    ...command([r]),
    sourceAccountId: other,
  });
  await ingestion.normalizeBatch(otherBatch.id);
  assert.notEqual(
    (
      await writer.query(
        'SELECT revision_id FROM ingestion.raw_record WHERE batch_id=$1',
        [batch.id],
      )
    ).rows[0].revision_id,
    (
      await writer.query(
        'SELECT revision_id FROM ingestion.raw_record WHERE batch_id=$1',
        [otherBatch.id],
      )
    ).rows[0].revision_id,
  );
});
test('receipt duplicates deduplicate interpretations; changed content and conflicting upstream token remain revisions', async () => {
  const r = { ...record(), sourceRevision: 'token-1' };
  const first = await ingestion.ingest(command([r, { ...r, locator: '1' }]));
  await ingestion.normalizeBatch(first.id);
  assert.equal((await ingestion.summary(first.id)).distinctRevisions, 1);
  const second = await ingestion.ingest(
    command([
      { ...record(r.externalId!, '960000'), sourceRevision: 'token-1' },
    ]),
  );
  await ingestion.normalizeBatch(second.id);
  const f = (
    await writer.query(
      'SELECT * FROM ingestion.fact_status WHERE external_id=$1',
      [r.externalId],
    )
  ).rows[0];
  assert.equal(f.revision_state, 'REVIEW_REQUIRED');
  assert.equal(f.active_revision_id, null);
  assert.equal(f.conflicting_source_token, true);
  const original = (
    await writer.query(
      'SELECT payload_bytes FROM ingestion.raw_record WHERE batch_id=$1',
      [first.id],
    )
  ).rows[0];
  assert.deepEqual(original.payload_bytes, Buffer.from(r.bytes));
  const amounts = (
    await writer.query(
      'SELECT amount_minor::text FROM ingestion.interpretation i JOIN ingestion.revision r ON r.id=i.revision_id WHERE r.fact_id=$1 ORDER BY amount_minor',
      [f.id],
    )
  ).rows.map((r) => r.amount_minor);
  assert.deepEqual(amounts, ['960000', '970000']);
  assert.equal(
    (
      await writer.query(
        'SELECT count(*)::text AS n FROM audit.audit_event WHERE revision_id=$1',
        [f.latest_received_revision_id],
      )
    ).rows[0].n,
    '1',
  );
});
test('malformed/missing identity evidence is retained and failures explicitly partition the population', async () => {
  const records = [
    record(),
    { ...record(), locator: '1', bytes: Buffer.from('{') },
    { ...record(), locator: '2', externalId: null },
    { ...record(), locator: '3', bytes: Uint8Array.from([255]) },
  ];
  const batch = await ingestion.ingest(command(records));
  const ids = await rawIds(batch.id);
  await ingestion.normalizeRaw(ids[0]!);
  await ingestion.normalizeRaw(ids[1]!);
  const partial = await ingestion.summary(batch.id);
  assert.deepEqual(
    [partial.received, partial.normalized, partial.failed, partial.pending],
    [4, 1, 1, 2],
  );
  const final = await ingestion.normalizeBatch(batch.id);
  assert.deepEqual(
    [final.received, final.normalized, final.failed, final.pending],
    [4, 1, 3, 0],
  );
  assert.equal(
    (
      await writer.query(
        'SELECT count(*)::text AS n FROM ingestion.interpretation WHERE basis_raw_id=ANY($1::uuid[]) AND failure_code IS NOT NULL',
        [ids],
      )
    ).rows[0].n,
    '3',
  );
});
test('independent count and sequence coverage; duplicates cannot mask sequence gaps', async () => {
  const r = record();
  for (const [expectedCount, expectedSequence, records, status] of [
    [2, undefined, [r], 'PROVEN_INCOMPLETE'],
    [1, undefined, [r], 'PROVEN_COMPLETE'],
    [
      2,
      { from: 1, to: 2 },
      [
        { ...r, sequence: 1 },
        { ...r, locator: '1', sequence: 1 },
      ],
      'PROVEN_INCOMPLETE',
    ],
    [
      2,
      { from: 1, to: 2 },
      [
        { ...r, sequence: 1 },
        { ...record(), locator: '1', sequence: 2 },
      ],
      'PROVEN_COMPLETE',
    ],
  ] as const) {
    const c: BatchCommand = {
      ...command(records),
      expectedCount,
      ...(expectedSequence ? { expectedSequence } : {}),
    };
    const b = await ingestion.ingest(c);
    assert.equal((await ingestion.summary(b.id)).completeness, status);
  }
  const b = await ingestion.ingest({ ...command([]), expectedCount: 0 });
  assert.equal((await ingestion.summary(b.id)).completeness, 'PROVEN_COMPLETE');
});
test('same/new version replay preserves all previous interpretations and fails same-version drift', async () => {
  const r = record(randomUUID(), '9007199254740993', '2026-01-01T00:00:00Z');
  const b = await ingestion.ingest(command([r]));
  const id = (await rawIds(b.id))[0]!;
  const old = await ingestion.normalizeRaw(id);
  assert.equal(old.state, 'FAILED');
  assert.deepEqual(await ingestion.normalizeRaw(id), old);
  await ingestion.requestNormalization(
    b.id,
    'synthetic-movement-v2',
    'test-replay',
  );
  const newer = await ingestion.normalizeRaw(id, 'synthetic-movement-v2');
  assert.equal(newer.state, 'NORMALIZED');
  assert.equal((await ingestion.summary(b.id)).failed, 1);
  assert.equal(
    (await ingestion.summary(b.id, 'synthetic-movement-v2')).normalized,
    1,
  );
  assert.equal(
    (
      await writer.query(
        'SELECT count(*)::text AS n FROM ingestion.interpretation WHERE basis_raw_id=$1',
        [id],
      )
    ).rows[0].n,
    '2',
  );
  await assert.rejects(
    writer.query('SELECT ingestion.complete_normalization($1,$2,$3::jsonb)', [
      id,
      'synthetic-movement-v1',
      JSON.stringify({ state: 'FAILED', code: 'INVALID_MONEY' }),
    ]),
    code('P2001'),
  );
});
test('runtime grants and database UPDATE/DELETE/TRUNCATE guards preserve history', async () => {
  const b = await ingestion.ingest(command());
  await ingestion.normalizeBatch(b.id);
  for (const table of [
    'source',
    'source_account',
    'batch',
    'source_fact',
    'revision',
    'raw_record',
    'normalizer_version',
    'interpretation',
    'normalization_request',
  ]) {
    await assert.rejects(
      writer.query(
        `UPDATE ingestion.${table} SET ${table === 'normalizer_version' ? 'version=version' : table === 'interpretation' ? 'state=state' : table === 'normalization_request' ? 'actor_id=actor_id' : 'id=id'}`,
      ),
      code('42501'),
    );
    await rejectedTx((c) => c.query(`DELETE FROM ingestion.${table}`), 'P1003');
    await rejectedTx(
      (c) =>
        c.query(
          `UPDATE ingestion.${table} SET ${table === 'normalizer_version' ? 'version=version' : table === 'interpretation' ? 'state=state' : table === 'normalization_request' ? 'actor_id=actor_id' : 'id=id'}`,
        ),
      'P1003',
    );
    await rejectedTx(
      (c) => c.query(`TRUNCATE ingestion.${table} CASCADE`),
      'P1003',
    );
  }
  await assert.rejects(
    writer.query('SELECT ledger.post_journal($1::jsonb)', ['{}']),
    code('42501'),
  );
  await assert.rejects(
    writer.query('SET ROLE flow_ledger_owner'),
    code('42501'),
  );
  await rejectedTx(
    (c) =>
      c.query(
        "UPDATE ingestion.processing SET state='PENDING',completed_at=NULL WHERE raw_id IN (SELECT id FROM ingestion.raw_record WHERE batch_id=$1)",
        [b.id],
      ),
    'P2003',
  );
  await rejectedTx(
    (c) =>
      c.query(
        'INSERT INTO ingestion.raw_record(batch_id,source_account_id,revision_id,locator,object_kind,external_id,payload_bytes) SELECT batch_id,source_account_id,revision_id,$2,object_kind,external_id,payload_bytes FROM ingestion.raw_record WHERE batch_id=$1',
        [b.id, 'late'],
      ),
    'P2003',
  );
});
test('actual blocked same-batch submissions converge to one logical evidence set', async () => {
  const c = command();
  const results = await contend(
    'SELECT id FROM ingestion.source_account WHERE id=$1 FOR UPDATE',
    [account],
    (api) => api.ingest(c),
  );
  assert.equal(new Set(results.map((r) => (r as { id: string }).id)).size, 1);
  assert.equal(
    (
      await writer.query(
        'SELECT count(*)::text AS n FROM ingestion.batch WHERE source_account_id=$1 AND batch_key=$2',
        [account, c.batchKey],
      )
    ).rows[0].n,
    '1',
  );
});
test('actual blocked same fact across batches, conflicting content and normalization serialize safely', async () => {
  const r = record();
  const outputs = await contend(
    'SELECT id FROM ingestion.source_account WHERE id=$1 FOR UPDATE',
    [account],
    (api, i) =>
      api.ingest(
        command([
          {
            ...record(r.externalId!, i % 2 ? '960000' : '970000'),
            locator: '0',
          },
        ]),
      ),
  );
  const batchId = (outputs[0] as { id: string }).id;
  const id = (await rawIds(batchId))[0]!;
  const revision = (
    await writer.query(
      'SELECT revision_id FROM ingestion.raw_record WHERE id=$1',
      [id],
    )
  ).rows[0].revision_id;
  await contend(
    'SELECT id FROM ingestion.revision WHERE id=$1 FOR UPDATE',
    [revision],
    (api) => api.normalizeRaw(id),
  );
  assert.equal(
    (
      await writer.query(
        'SELECT count(*)::text AS n FROM ingestion.interpretation WHERE revision_id=$1',
        [revision],
      )
    ).rows[0].n,
    '1',
  );
  assert.equal(
    (
      await writer.query(
        'SELECT count(*)::text AS n FROM ingestion.revision r JOIN ingestion.source_fact f ON r.fact_id=f.id WHERE f.external_id=$1',
        [r.externalId],
      )
    ).rows[0].n,
    '2',
  );
  for (const output of outputs)
    await ingestion.normalizeBatch((output as { id: string }).id);
});
test('pre-commit rollback and killed processing preserve durable pending evidence and companions', async () => {
  const c = command();
  const client = await writer.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT ingestion.accept_batch($1::jsonb)', [
      batchPayload(c),
    ]);
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
  assert.equal(
    (
      await writer.query(
        'SELECT count(*)::text AS n FROM ingestion.batch WHERE batch_key=$1',
        [c.batchKey],
      )
    ).rows[0].n,
    '0',
  );
  const b = await ingestion.ingest(c);
  const raw = (await rawIds(b.id))[0]!;
  const processing = await writer.connect();
  processing.on('error', () => {});
  try {
    await processing.query('BEGIN');
    const pid = (await processing.query('SELECT pg_backend_pid() AS pid'))
      .rows[0].pid;
    const res = normalize(
      c.records[0]!.bytes,
      c.records[0]!.externalId,
      'synthetic-movement-v1',
    );
    await processing.query(
      'SELECT ingestion.complete_normalization($1,$2,$3::jsonb)',
      [raw, 'synthetic-movement-v1', canonicalJson(res)],
    );
    await admin.query('SELECT pg_terminate_backend($1)', [pid]);
    await assert.rejects(processing.query('COMMIT'));
  } finally {
    processing.release(true);
  }
  assert.equal((await ingestion.summary(b.id)).pending, 1);
  assert.equal((await ingestion.normalizeBatch(b.id)).normalized, 1);
});
test('lost COMMIT acknowledgements recover ingestion and normalization by unchanged identity', async () => {
  for (const action of ['ingest', 'normalize'] as const) {
    const c = command();
    const b = action === 'normalize' ? await ingestion.ingest(c) : undefined;
    const raw = b ? (await rawIds(b.id))[0]! : undefined;
    const proxy = await commitDropProxy(url);
    const pool = new Pool({ connectionString: proxy.url });
    pool.on('error', () => {});
    const api = new PostgresIngestion(pool, writer);
    try {
      await assert.rejects(
        action === 'ingest' ? api.ingest(c) : api.normalizeRaw(raw!),
        UnknownIngestionCommit,
      );
      await Promise.race([
        proxy.dropped,
        new Promise((_, reject) => {
          const timer = setTimeout(
            () =>
              reject(new Error('No COMMIT acknowledgement was intercepted')),
            5000,
          );
          timer.unref();
        }),
      ]);
      if (action === 'ingest') {
        const retry = await ingestion.ingest(c);
        assert.equal(retry.replayed, true);
        assert.equal((await ingestion.summary(retry.id)).received, 1);
      } else {
        assert.equal((await ingestion.normalizeRaw(raw!)).state, 'NORMALIZED');
        assert.equal((await ingestion.summary(b!.id)).normalized, 1);
      }
    } finally {
      await pool.end();
      await proxy.close();
    }
  }
});
test('real PostgreSQL replay/revisions/completeness/exact money property: 50 trials seed 70303', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.bigInt({ min: -9223372036854775808n, max: 9223372036854775806n }),
      fc.integer({ min: 1, max: 4 }),
      fc.boolean(),
      async (amount, n, malformed) => {
        const r = record(randomUUID(), amount.toString());
        const records = [
          r,
          ...(malformed
            ? [{ ...record(), locator: 'bad', bytes: Buffer.from('{') }]
            : []),
        ];
        const c = command(records);
        const first = await ingestion.ingest(c);
        for (let i = 0; i < n; i++)
          assert.deepEqual(await ingestion.ingest(c), {
            id: first.id,
            replayed: true,
          });
        const before = await ingestion.summary(first.id);
        assert.equal(before.received, before.pending);
        const s = await ingestion.normalizeBatch(first.id);
        assert.equal(s.received, s.normalized + s.failed + s.pending);
        assert.equal(s.failed, malformed ? 1 : 0);
        const next = await ingestion.ingest(
          command([record(r.externalId!, (amount + 1n).toString())]),
        );
        await ingestion.normalizeBatch(next.id);
        assert.equal(
          (
            await writer.query(
              'SELECT count(*)::text AS n FROM ingestion.revision v JOIN ingestion.source_fact f ON f.id=v.fact_id WHERE f.external_id=$1',
              [r.externalId],
            )
          ).rows[0].n,
          '2',
        );
        const id = (await rawIds(first.id))[0]!;
        const stored = (
          await writer.query(
            'SELECT amount_minor::text AS amount FROM ingestion.interpretation WHERE basis_raw_id=$1',
            [id],
          )
        ).rows[0].amount;
        assert.equal(BigInt(stored), amount);
      },
    ),
    { numRuns: 50, seed: 70303 },
  );
});

test('ingestion validates before writes and snapshots caller bytes while waiting for a connection', async () => {
  const r = record();
  const bytes = Buffer.from(r.bytes);
  const c = command([{ ...r, bytes }]);
  const single = new Pool({ connectionString: url, max: 1 });
  const held = await single.connect();
  try {
    const pending = new PostgresIngestion(single).ingest(c);
    bytes.fill(0);
    held.release();
    const batch = await pending;
    assert.deepEqual(
      (
        await writer.query(
          'SELECT payload_bytes FROM ingestion.raw_record WHERE batch_id=$1',
          [batch.id],
        )
      ).rows[0].payload_bytes,
      Buffer.from(r.bytes),
    );
  } finally {
    await single.end();
  }
  const invalid = { ...command(), expectedCount: 1.5 };
  await assert.rejects(ingestion.ingest(invalid), RangeError);
  assert.equal(
    (
      await writer.query(
        'SELECT count(*)::text AS n FROM ingestion.batch WHERE batch_key=$1',
        [invalid.batchKey],
      )
    ).rows[0].n,
    '0',
  );
});

test('injected audit/outbox failures roll back batch, receipts, revisions and intent together', async () => {
  for (const target of ['audit.audit_event', 'outbox.outbox_event']) {
    const c = command();
    const tables = [
      'ingestion.batch',
      'ingestion.raw_record',
      'ingestion.revision',
      'ingestion.source_fact',
      'ingestion.processing',
      'audit.audit_event',
      'outbox.outbox_event',
    ];
    const counts = async () =>
      Promise.all(
        tables.map(
          async (table) =>
            (await admin.query(`SELECT count(*)::text AS n FROM ${table}`))
              .rows[0].n,
        ),
      );
    const before = await counts();
    await admin.query(
      "CREATE FUNCTION public.phase3_test_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.batch_id IS NOT NULL THEN RAISE EXCEPTION USING ERRCODE='P2999',MESSAGE='Synthetic failure injection'; END IF; RETURN NEW; END $$",
    );
    try {
      await admin.query(
        `CREATE TRIGGER phase3_test_failure BEFORE INSERT ON ${target} FOR EACH ROW EXECUTE FUNCTION public.phase3_test_failure()`,
      );
      await assert.rejects(ingestion.ingest(c), code('P2999'));
      assert.deepEqual(await counts(), before);
    } finally {
      await admin.query(
        `DROP TRIGGER IF EXISTS phase3_test_failure ON ${target}`,
      );
      await admin.query('DROP FUNCTION public.phase3_test_failure()');
    }
    assert.equal((await ingestion.ingest(c)).replayed, false);
  }
});

test('generated receipt partitions remain complete across mixed pending/success/failure: 30 trials seed 70307', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.constantFrom('pending', 'valid', 'bad'), {
        minLength: 0,
        maxLength: 15,
      }),
      async (states) => {
        const records = states.map((state, index) => ({
          ...record(),
          locator: String(index),
          ...(state === 'bad' ? { bytes: Buffer.from('{') } : {}),
        }));
        const b = await ingestion.ingest(command(records));
        const ids = await rawIds(b.id);
        for (let i = 0; i < states.length; i++)
          if (states[i] !== 'pending') await ingestion.normalizeRaw(ids[i]!);
        const s = await ingestion.summary(b.id);
        assert.equal(s.received, states.length);
        assert.equal(s.received, s.pending + s.normalized + s.failed);
        assert.equal(s.pending, states.filter((x) => x === 'pending').length);
        assert.equal(s.normalized, states.filter((x) => x === 'valid').length);
        assert.equal(s.failed, states.filter((x) => x === 'bad').length);
      },
    ),
    { numRuns: 30, seed: 70307 },
  );
});

test('database commit guards reject accepted batches without raw/disposition/intent and replay requests without companions', async () => {
  await rejectedTx(
    (c) =>
      c.query(
        "INSERT INTO ingestion.batch(source_account_id,batch_key,request_payload,request_checksum,imported_count,completeness) VALUES($1,$2,'{}'::jsonb,encode(sha256(convert_to('{}','UTF8')),'hex'),1,'UNKNOWN')",
        [account, randomUUID()],
      ),
    'P2004',
  );
  const b = await ingestion.ingest(command());
  await rejectedTx(
    (c) =>
      c.query(
        "INSERT INTO ingestion.normalization_request(batch_id,normalizer_version,actor_id) VALUES($1,'synthetic-movement-v2','test')",
        [b.id],
      ),
    'P2004',
  );
  const id = (await rawIds(b.id))[0]!;
  const r = (
    await writer.query(
      'SELECT revision_id,external_id FROM ingestion.raw_record WHERE id=$1',
      [id],
    )
  ).rows[0];
  const bad = {
    state: 'NORMALIZED',
    observation: {
      type: 'movement',
      subtype: 'capture',
      externalId: r.external_id,
      amount: { amountMinor: '2', currency: 'PHP' },
      occurredAt: '2026-01-01T00:00:00.000Z',
      direction: 'inflow',
      reference: 'test',
      parentReference: null,
    },
  };
  await rejectedTx(
    (c) =>
      c.query(
        "INSERT INTO ingestion.interpretation(revision_id,normalizer_version,basis_raw_id,result,result_checksum,state,amount_minor,currency,occurred_at,direction) VALUES($1,'synthetic-movement-v1',$2,$3::jsonb,encode(sha256(convert_to(($3::jsonb)::text,'UTF8')),'hex'),'NORMALIZED',1,'PHP','2026-01-01T00:00:00.000Z','inflow')",
        [r.revision_id, id, JSON.stringify(bad)],
      ),
    'P2003',
  );
  assert.equal((await ingestion.summary(b.id)).pending, 1);
});
