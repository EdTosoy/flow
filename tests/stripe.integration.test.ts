import assert from 'node:assert/strict';
import { before, after, afterEach, test } from 'node:test';
import { randomUUID, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { ingressServer } from '../apps/integrations/src/index';
import { Pool } from 'pg';
import { PostgresIngestion } from '@flow/ingestion-postgres';
import { PostgresProcessor } from '@flow/processor-postgres';
import { PostgresWorker } from '@flow/worker-postgres';
import { PostgresReconciliation } from '@flow/reconciliation-postgres';
import { PostgresControls } from '@flow/control-postgres';
import { PostgresExceptions } from '@flow/exception-postgres';
import { commitDropProxy } from './helpers/commit-proxy';
import { UnknownWorkerCommit } from '@flow/worker-postgres';
import { PostgresBank } from '@flow/bank-postgres';
import { PostgresOperations } from '@flow/operations-read-postgres';
import {
  StripeEvidenceDatabase,
  StripeEvidenceWorker,
  backfill,
} from '@flow/stripe-postgres';
import {
  eventEnvelope,
  StripeBoundaryError,
  STRIPE_API_VERSION,
  type JsonObject,
  type StripeReader,
} from '@flow/stripe-integration';
import { stripeFixture } from '../libs/stripe-integration/test/fixture';
import { clean } from './helpers/resilience';
const adminUrl = process.env['FLOW_TEST_ADMIN_URL'],
  ingressUrl = process.env['FLOW_TEST_STRIPE_INGRESS_URL'],
  workerUrl = process.env['FLOW_TEST_STRIPE_WORKER_URL'];
if (!adminUrl || !ingressUrl || !workerUrl)
  throw new Error('Run pnpm test:stripe');
const admin = new Pool({ connectionString: adminUrl }),
  ingressPool = new Pool({ connectionString: ingressUrl, max: 4 }),
  workerPool = new Pool({ connectionString: workerUrl, max: 4 });
const f = stripeFixture(),
  bookId = randomUUID();
let reconciliationRunId: string;
let sourceAccountId: string,
  database: StripeEvidenceDatabase,
  worker: StripeEvidenceWorker;
before(async () => {
  await admin.query(
    "INSERT INTO ledger.book(id,code,environment) VALUES($1,$2,'test')",
    [bookId, 'stripe-' + bookId],
  );
  sourceAccountId = await new PostgresIngestion(admin).registerSource({
    bookId,
    environment: 'test',
    provider: 'stripe',
    externalAccountId: f.accountId,
  });
  await admin.query(
    "SELECT stripe.configure($1::uuid,$2,'flow_test_stripe_ingress','ingress')",
    [sourceAccountId, f.accountId],
  );
  await admin.query(
    "SELECT stripe.configure($1::uuid,$2,'flow_test_stripe_worker','worker')",
    [sourceAccountId, f.accountId],
  );
  database = new StripeEvidenceDatabase(ingressPool, {
    sourceAccountId,
    accountId: f.accountId,
  });
  worker = new StripeEvidenceWorker(
    workerPool,
    { sourceAccountId, accountId: f.accountId },
    f.reader,
    {
      log: (entry) => {
        if (entry.outcome !== 'SUCCEEDED')
          console.log(
            'Stripe work classification',
            entry.failureCode ?? entry.outcome,
          );
      },
    },
  );
});
afterEach(async () => {
  await clean(admin, bookId);
});
after(async () => {
  await Promise.all([admin.end(), ingressPool.end(), workerPool.end()]);
});
async function accept(row: JsonObject, origin: 'webhook' | 'api' = 'webhook') {
  return database.accept(
    eventEnvelope(row, f.accountId),
    Buffer.from(JSON.stringify(row)),
    origin,
  );
}
async function drain(executor = worker): Promise<void> {
  await executor.processBatch('stripe-test', 100, bookId);
}
async function activityCount(): Promise<number> {
  return Number(
    (
      await admin.query(
        'SELECT count(*)::text AS n FROM processor.activity WHERE source_account_id=$1',
        [sourceAccountId],
      )
    ).rows[0].n,
  );
}
test('signed HTTP requests acknowledge real PostgreSQL durability, reject conflicts and fail closed when PostgreSQL is unavailable', async () => {
  const sdk = createRequire(resolve('libs/stripe-integration/package.json'))(
    'stripe',
  );
  const secret = 'whsec_' + randomBytes(24).toString('hex');
  const server = ingressServer(database, {
    accountId: f.accountId,
    secrets: [secret],
  });
  const brokenUrl = new URL(ingressUrl!);
  brokenUrl.port = '1';
  const unavailablePool = new Pool({
    connectionString: brokenUrl.toString(),
    connectionTimeoutMillis: 250,
  });
  const unavailableServer = ingressServer(
    new StripeEvidenceDatabase(unavailablePool, {
      sourceAccountId,
      accountId: f.accountId,
    }),
    { accountId: f.accountId, secrets: [secret] },
  );
  try {
    const urls: string[] = [];
    for (const s of [server, unavailableServer]) {
      await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
      const address = s.address();
      assert.ok(address && typeof address === 'object');
      urls.push('http://127.0.0.1:' + address.port);
    }
    const row = f.event();
    const send = (url: string, data: JsonObject) => {
      const payload = JSON.stringify(data);
      return fetch(url + '/webhooks/stripe', {
        method: 'POST',
        body: payload,
        headers: {
          'stripe-signature': sdk.webhooks.generateTestHeaderString({
            payload,
            secret,
          }),
        },
      });
    };
    const response = await send(urls[0]!, row);
    assert.equal(response.status, 200);
    await response.text();
    assert.equal(
      (
        await admin.query(
          'SELECT count(*)::integer AS n FROM stripe.event WHERE event_id=$1',
          [row['id']],
        )
      ).rows[0].n,
      1,
    );
    const replay = await send(urls[0]!, row);
    assert.equal(replay.status, 200);
    assert.match(await replay.text(), /duplicate/);
    const conflict = await send(urls[0]!, {
      ...row,
      created: Number(row['created']) + 1,
    });
    assert.equal(conflict.status, 409);
    assert.equal((await send(urls[1]!, f.event())).status, 503);
    assert.equal((await fetch(urls[1]! + '/health/ready')).status, 503);
    assert.equal((await fetch(urls[1]! + '/health/live')).status, 200);
    await drain();
    assert.equal(await activityCount(), 2);
  } finally {
    for (const s of [server, unavailableServer]) {
      s.closeAllConnections();
      await new Promise<void>((r) => s.close(() => r()));
    }
    await unavailablePool.end();
  }
});
test('immutable exact bytes, UNKNOWN coverage and transactional work exist before acknowledgement', async () => {
  assert.equal(await database.ready(), true);
  const row = f.event(),
    raw = Buffer.from(JSON.stringify(row, null, 2));
  const result = await database.accept(
    eventEnvelope(row, f.accountId),
    raw,
    'webhook',
  );
  const state = await admin.query(
    'SELECT r.payload_bytes,b.completeness,w.handler,w.state FROM ingestion.raw_record r JOIN ingestion.batch b ON b.id=r.batch_id JOIN outbox.outbox_event o ON o.batch_id=b.id JOIN worker.work_item w ON w.event_id=o.id WHERE b.id=$1',
    [result.id],
  );
  assert.deepEqual(state.rows[0].payload_bytes, raw);
  assert.equal(state.rows[0].completeness, 'UNKNOWN');
  assert.equal(state.rows[0].handler, 'stripe-evidence');
  assert.equal(state.rows[0].state, 'PENDING');
  await assert.rejects(
    admin.query("UPDATE stripe.event SET origin='api' WHERE batch_id=$1", [
      result.id,
    ]),
  );
  await drain();
  assert.equal(await activityCount(), 2);
});
test('duplicate signed logical event and concurrent acceptance preserve one receipt; conflict cannot overwrite', async () => {
  const row = f.event();
  const held = await admin.connect();
  await held.query('BEGIN');
  await held.query(
    'SELECT 1 FROM ingestion.source_account WHERE id=$1 FOR UPDATE',
    [sourceAccountId],
  );
  const attempts = [accept(row), accept(row), accept(row)];
  await new Promise((r) => setTimeout(r, 30));
  const waiting = await admin.query(
    "SELECT count(*)::integer AS n FROM pg_stat_activity WHERE usename='flow_test_stripe_ingress' AND wait_event_type='Lock'",
  );
  assert.ok(waiting.rows[0].n >= 2);
  await held.query('COMMIT');
  held.release();
  const results = await Promise.all(attempts);
  assert.equal(new Set(results.map((x) => x.id)).size, 1);
  assert.equal(results.filter((x) => x.replayed).length, 2);
  await assert.rejects(
    accept({
      ...row,
      data: {
        object: { id: 'ch_conflict', object: 'charge', livemode: false },
      },
    }),
  );
  assert.equal(
    (
      await admin.query(
        'SELECT count(*)::integer AS n FROM stripe.event WHERE event_id=$1',
        [row['id']],
      )
    ).rows[0].n,
    1,
  );
  await drain();
  assert.equal(await activityCount(), 2);
});
test('webhook/API deduplication tolerates API serialization while preserving the original webhook bytes', async () => {
  const row = f.event(),
    raw = Buffer.from(JSON.stringify(row, null, 2));
  const first = await database.accept(
    eventEnvelope(row, f.accountId),
    raw,
    'webhook',
  );
  const duplicate = await accept({ ...row, pending_webhooks: 0 }, 'api');
  assert.equal(duplicate.id, first.id);
  assert.equal(duplicate.replayed, true);
  assert.deepEqual(
    (
      await admin.query(
        'SELECT payload_bytes FROM ingestion.raw_record WHERE batch_id=$1',
        [first.id],
      )
    ).rows[0].payload_bytes,
    raw,
  );
  await drain();
  assert.equal(await activityCount(), 2);
});
test('refund.updated before refund.created and separate same-charge events have one economic effect', async () => {
  await accept(f.event('refund.updated', f.refundId));
  await drain();
  const count = await activityCount();
  assert.equal(count, 3);
  await accept(f.event('refund.created', f.refundId));
  await accept(f.event());
  await drain();
  assert.equal(await activityCount(), count);
  const payment = (
    await admin.query(
      'SELECT id FROM processor.payment WHERE source_account_id=$1 AND external_payment_reference=$2',
      [sourceAccountId, f.chargeId],
    )
  ).rows[0].id;
  const result = await new PostgresProcessor(admin).evaluate(
    'payment',
    payment,
    'stripe-refund-order',
    'processor-movement-v1',
  );
  assert.equal(result.result['lifecycle'], 'partially_refunded');
  assert.equal(result.result['refundedMinor'], '2000');
});
test('multiple partial refunds are distinct and exact', async () => {
  const id = 're_' + randomUUID().replaceAll('-', ''),
    bt = 'txn_' + randomUUID().replaceAll('-', '');
  f.resources.set('refund:' + id, {
    ...f.resources.get('refund:' + f.refundId)!,
    id,
    amount: 1000,
    balance_transaction: bt,
  });
  f.resources.set('balance_transaction:' + bt, {
    ...f.resources.get('balance_transaction:' + f.refundBt)!,
    id: bt,
    source: id,
    amount: -1000,
    net: -1000,
  });
  await accept(f.event('refund.created', id));
  await drain();
  assert.equal(
    (
      await admin.query(
        "SELECT count(*)::integer AS n,sum(contribution_minor)::text AS amount FROM processor.activity WHERE source_account_id=$1 AND kind='REFUND'",
        [sourceAccountId],
      )
    ).rows[0].amount,
    '-3000',
  );
});
test('crash after accepted receipt before normalization recovers through existing lease expiry', async () => {
  await admin.query(
    'UPDATE worker.policy SET lease_ms=1000,timeout_ms=900 WHERE id=1',
  );
  try {
    await accept(f.event());
  } finally {
    await admin.query(
      'UPDATE worker.policy SET lease_ms=30000,timeout_ms=10000 WHERE id=1',
    );
  }
  const claim = await worker.claim('crashed', bookId);
  assert.ok(claim);
  await new Promise((r) => setTimeout(r, 1100));
  const fresh = await worker.claim('recovered', bookId);
  assert.ok(fresh);
  assert.equal(fresh.id, claim.id);
  assert.notEqual(fresh.token, claim.token);
  await assert.rejects(worker.handle(claim));
  await worker.handle(fresh);
  assert.equal(await worker.finish(fresh), true);
});
test('external enrichment and projection commit survive lost acknowledgement with one effect', async () => {
  await accept(f.event());
  const claim = await worker.claim('before-ack', bookId);
  assert.ok(claim);
  await worker.handle(claim);
  const count = await activityCount();
  const calls = f.calls.length;
  await worker.handle(claim);
  assert.equal(f.calls.length, calls);
  assert.equal(await activityCount(), count);
  assert.equal(await worker.finish(claim), true);
  assert.equal(await worker.finish(claim), true);
});
test('automatic payout members flow through existing processor, reconciliation, controls and read-only operations', async () => {
  await accept(f.event('payout.reconciliation_completed', f.payoutId));
  await drain();
  const settlement = (
    await admin.query(
      'SELECT id FROM processor.settlement_batch WHERE source_account_id=$1 AND transfer_reference=$2',
      [sourceAccountId, f.payoutId],
    )
  ).rows[0];
  assert.ok(settlement);
  const evaluated = await new PostgresProcessor(admin).evaluate(
    'settlement',
    settlement.id,
    'stripe-payout',
    'processor-movement-v1',
  );
  assert.deepEqual(evaluated.result['controls'], []);
  assert.equal(evaluated.result['calculatedNetMinor'], '6530');
  const ingester = new PostgresIngestion(admin);
  const bankSource = await ingester.registerSource({
    bookId,
    environment: 'test',
    provider: 'synthetic-bank-demo',
    externalAccountId: 'synthetic-bank',
  });
  const batch = await ingester.ingest({
    sourceAccountId: bankSource,
    batchKey: 'synthetic-stripe-bank',
    actorId: 'stripe-test-only',
    provenance: {
      environment: 'synthetic',
      purpose: 'controlled demo; not independent bank proof',
    },
    records: [
      {
        locator: '0',
        objectKind: 'synthetic-bank-entry',
        externalId: 'synthetic_' + f.payoutId,
        sourceRevision: null,
        sequence: null,
        sourceObservedAt: null,
        bytes: Buffer.from(
          JSON.stringify({
            id: 'synthetic_' + f.payoutId,
            status: 'booked',
            amount: { amountMinor: '6530', currency: 'USD' },
            bookedAt: '2026-01-03T00:00:00.000Z',
            transferReference: f.payoutId,
            statementReference: null,
            lineIdentity: null,
            sequence: null,
            runningBalance: null,
          }),
        ),
      },
    ],
  });
  await ingester.requestNormalization(
    batch.id,
    'synthetic-bank-entry-v1',
    'stripe-test',
  );
  await ingester.normalizeBatch(batch.id, 'synthetic-bank-entry-v1');
  await new PostgresBank(admin).deriveBatch(
    batch.id,
    'synthetic-bank-entry-v1',
  );
  const mapping = await admin.query(
    "INSERT INTO reconciliation.account_mapping(book_id,processor_source_account_id,bank_source_account_id,currency,reference_contract) VALUES($1,$2,$3,'USD','synthetic-transfer-reference-v1') RETURNING id",
    [bookId, sourceAccountId, bankSource],
  );
  const run = await new PostgresReconciliation(admin).run({
    mappingId: mapping.rows[0].id,
    runKey: 'stripe-demo-run',
    actorId: 'stripe-test',
    from: '2026-01-01T00:00:00.000Z',
    to: '2026-01-04T00:00:00.000Z',
    effectiveAt: '2026-01-04T00:00:00.000Z',
  });
  assert.ok(run);
  reconciliationRunId = run.id;
  assert.equal(
    run.outcomes
      .filter((o) => o.outcome === 'MATCHED')
      .reduce((n, o) => n + o.count, 0),
    2,
  );
  assert.equal(run.current.find((c) => c.status === 'ACTIVE')?.count, 1);
  assert.equal(run.sourceCoverage, 'UNKNOWN');
  const controls = await new PostgresControls(admin).run({
    bookId,
    runKey: 'stripe-demo-controls',
    actorId: 'stripe-test',
    reconciliationRunIds: [run.id],
  });
  assert.equal(controls.assurance, 'UNKNOWN');
  assert.deepEqual(
    await new PostgresExceptions(admin).generate(run.id, 'stripe-test'),
    [],
  );

  const opsPool = new Pool({
    connectionString: process.env['FLOW_TEST_OPERATIONS_URL'],
    max: 2,
  });
  try {
    const overview = await new PostgresOperations(opsPool).read(
      'overview',
      bookId,
    );
    assert.ok(overview);
  } finally {
    await opsPool.end();
  }
});
test('bounded paginated backfill is overlapping/idempotent and remains UNKNOWN', async () => {
  const events = [
    f.event(),
    f.event('refund.updated', f.refundId),
    f.event('refund.created', f.refundId),
  ];
  f.setEvents(events);
  const first = await backfill(
    database,
    f.reader,
    f.created - 1,
    f.created + 1,
    3,
    f.created + 86400,
  );
  assert.equal(first.received, 3);
  const second = await backfill(
    database,
    f.reader,
    f.created - 1,
    f.created + 2,
    3,
    f.created + 86400,
  );
  assert.equal(second.duplicates, 3);
  await drain();
  await assert.rejects(
    backfill(
      database,
      f.reader,
      f.created - 40 * 86400,
      f.created,
      10,
      f.created + 86400,
    ),
  );
  assert.equal(
    (
      await admin.query(
        "SELECT count(*)::integer AS n FROM ingestion.batch WHERE source_account_id=$1 AND completeness<>'UNKNOWN'",
        [sourceAccountId],
      )
    ).rows[0].n,
    0,
  );
});
test('ingress and worker privileges cannot mutate financial truth or impersonate another source', async () => {
  for (const pool of [ingressPool, workerPool]) {
    await assert.rejects(
      pool.query(
        'INSERT INTO processor.payment(source_account_id,external_payment_reference) VALUES($1,$2)',
        [sourceAccountId, 'forbidden'],
      ),
    );
    await assert.rejects(
      pool.query('SELECT ingestion.accept_batch($1::jsonb)', ['{}']),
    );
    await assert.rejects(
      pool.query("UPDATE ledger.book SET code='forbidden' WHERE id=$1", [
        bookId,
      ]),
    );
    await assert.rejects(
      pool.query(
        "SELECT stripe.configure($1::uuid,$2,current_user,'ingress')",
        [sourceAccountId, f.accountId],
      ),
    );
  }
  const ordinaryPool = new Pool({
    connectionString: process.env['FLOW_TEST_WORKER_URL'],
  });
  try {
    assert.equal(
      await new PostgresWorker(ordinaryPool).claim('ordinary-worker', bookId),
      null,
    );
  } finally {
    await ordinaryPool.end();
  }
  assert.equal(STRIPE_API_VERSION, '2026-09-30.endive');
});

test('sandbox verification counts completed economic evidence with only the narrow worker capability', async () => {
  const created = f.created + 12345;
  const row = f.event('charge.succeeded', f.chargeId, { created });
  await assert.rejects(
    workerPool.query('SELECT 1 FROM outbox.outbox_event LIMIT 1'),
    { code: '42501' },
  );
  await accept(row);
  assert.equal(await worker.completedEvidenceCount(created, created), 0n);
  await drain();
  assert.equal(await worker.completedEvidenceCount(created, created), 1n);
  assert.equal(
    await worker.completedEvidenceCount(created + 1, created + 2),
    0n,
  );
  await accept(row, 'api');
  await drain();
  assert.equal(await worker.completedEvidenceCount(created, created), 1n);
  const otherAccountId = 'acct_' + randomUUID().replaceAll('-', '');
  const otherSourceId = await new PostgresIngestion(admin).registerSource({
    bookId,
    environment: 'test',
    provider: 'stripe',
    externalAccountId: otherAccountId,
  });
  const role = 'stripe_test_ingress_' + randomUUID().replaceAll('-', '');
  await admin.query(
    'CREATE ROLE ' +
      role +
      ' LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',
  );
  await admin.query('GRANT flow_stripe_ingress TO ' + role);
  await admin.query("SELECT stripe.configure($1::uuid,$2,$3::name,'ingress')", [
    otherSourceId,
    otherAccountId,
    role,
  ]);
  const url = new URL(adminUrl!);
  url.username = role;
  const otherPool = new Pool({ connectionString: url.toString(), max: 1 });
  try {
    const binding = {
      sourceAccountId: otherSourceId,
      accountId: otherAccountId,
    };
    await new StripeEvidenceDatabase(otherPool, binding).accept(
      eventEnvelope(row, otherAccountId),
      Buffer.from(JSON.stringify(row)),
      'webhook',
    );
    const otherScope = new StripeEvidenceWorker(workerPool, binding, f.reader);
    assert.equal(await otherScope.completedEvidenceCount(created, created), 0n);
  } finally {
    await otherPool.end();
  }
});

test('transient rate limit respects guidance and permanent version failure is terminal', async () => {
  await accept(f.event());
  const api: StripeReader = {
    ...f.reader,
    read: async (kind, id) => {
      if (kind === 'charge')
        throw new StripeBoundaryError('TRANSIENT', 'STRIPE_RATE_LIMIT', 2);
      return f.reader.read(kind, id);
    },
  };
  const executor = new StripeEvidenceWorker(
    workerPool,
    { sourceAccountId, accountId: f.accountId },
    api,
  );
  await executor.processOne('rate-limit', bookId);
  const failed = (
    await admin.query(
      "SELECT state,last_failure_code,extract(epoch FROM next_attempt_at-clock_timestamp()) AS remaining FROM worker.work_item WHERE last_failure_code='STRIPE_RATE_LIMIT' ORDER BY created_at DESC LIMIT 1",
    )
  ).rows[0];
  assert.equal(failed.state, 'RETRYABLE');
  assert.ok(Number(failed.remaining) > 1.5);
  await accept(
    f.event('charge.succeeded', f.chargeId, { api_version: '2019-02-19' }),
  );
  await drain();
  assert.ok(
    (
      await admin.query(
        "SELECT 1 FROM worker.work_item WHERE last_failure_code='UNSUPPORTED_EVENT_API_VERSION' AND state='FAILED_TERMINAL'",
      )
    ).rowCount,
  );
});

test('lost PostgreSQL COMMIT acknowledgement retries the same event and preserves one logical receipt', async () => {
  const proxy = await commitDropProxy(ingressUrl!);
  const pool = new Pool({ connectionString: proxy.url, max: 1 });
  pool.on('error', () => {});
  const row = f.event();
  try {
    await assert.rejects(
      new StripeEvidenceDatabase(pool, {
        sourceAccountId,
        accountId: f.accountId,
      }).accept(
        eventEnvelope(row, f.accountId),
        Buffer.from(JSON.stringify(row)),
        'webhook',
      ),
      UnknownWorkerCommit,
    );
    await proxy.dropped;
    const replay = await accept(row);
    assert.equal(replay.replayed, true);
    assert.equal(
      (
        await admin.query(
          'SELECT count(*)::integer AS n FROM stripe.event WHERE event_id=$1',
          [row['id']],
        )
      ).rows[0].n,
      1,
    );
    await drain();
  } finally {
    await pool.end();
    await proxy.close();
  }
});
test('pending and unsupported late dispute evidence invalidate current assurance without altering frozen allocation', async () => {
  assert.ok(reconciliationRunId);
  const original = (
    await admin.query(
      'SELECT to_jsonb(g) AS row FROM reconciliation.match_group g WHERE run_id=$1 ORDER BY id',
      [reconciliationRunId],
    )
  ).rows;
  const row = f.event('charge.dispute.funds_reinstated', f.disputeId);
  await accept(row);
  const current = (
    await new PostgresReconciliation(admin).summary(reconciliationRunId)
  ).current;
  assert.equal(current.find((c) => c.status === 'INVALIDATED')?.count, 1);
  const control = await admin.query(
    "SELECT result FROM (SELECT processor.evaluation_snapshot('settlement',s.id,'processor-movement-v1','processor-v1')->'result' AS result FROM processor.settlement_batch s WHERE source_account_id=$1) q",
    [sourceAccountId],
  );
  assert.equal(control.rows[0].result.sufficient, false);
  assert.equal(control.rows[0].result.calculatedNetMinor, null);
  assert.deepEqual(
    (
      await admin.query(
        'SELECT to_jsonb(g) AS row FROM reconciliation.match_group g WHERE run_id=$1 ORDER BY id',
        [reconciliationRunId],
      )
    ).rows,
    original,
  );
});
