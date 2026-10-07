import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, after, test } from 'node:test';
import { Pool, type PoolClient } from 'pg';
import fc from 'fast-check';
import { canonicalJson, type RawInput } from '@flow/ingestion-domain';
import { PostgresIngestion } from '@flow/ingestion-postgres';
import {
  PostgresProcessor,
  UnknownProcessorCommit,
} from '@flow/processor-postgres';
import { commitDropProxy } from './helpers/commit-proxy';
const adminUrl = process.env['FLOW_TEST_ADMIN_URL'],
  url = process.env['FLOW_TEST_PROCESSOR_URL'],
  ingestionUrl = process.env['FLOW_TEST_INGESTION_URL'];
if (!adminUrl || !url || !ingestionUrl)
  throw new Error('Run pnpm test:integration');
const admin = new Pool({ connectionString: adminUrl }),
  writer = new Pool({ connectionString: url, max: 20 }),
  ip = new Pool({ connectionString: ingestionUrl });
const ingestion = new PostgresIngestion(ip),
  processor = new PostgresProcessor(writer),
  bookId = randomUUID();
before(async () => {
  await admin.query(
    "INSERT INTO ledger.book(id,code,environment) VALUES($1,$2,'synthetic')",
    [bookId, 'processor-' + bookId],
  );
});
after(async () => {
  await Promise.all([admin.end(), writer.end(), ip.end()]);
});
const money = (amountMinor: string, currency = 'PHP') => ({
  amountMinor,
  currency,
});
function movement(
  id: string,
  kind = 'capture',
  amount = '10000',
  payment = 'p',
  parent: string | null = null,
  currency = 'PHP',
): RawInput {
  return {
    locator: id,
    objectKind: 'synthetic-movement',
    externalId: id,
    sourceRevision: null,
    sequence: null,
    sourceObservedAt: null,
    bytes: Buffer.from(
      canonicalJson({
        id,
        kind,
        amount: money(amount, currency),
        paymentReference: payment,
        parentCaptureId: parent,
        occurredAt: '2026-01-01T00:00:00.000Z',
      }),
    ),
  };
}
function report(id: string, components: string[], net = '9700'): RawInput {
  return {
    locator: id,
    objectKind: 'synthetic-settlement',
    externalId: id,
    sourceRevision: null,
    sequence: null,
    sourceObservedAt: null,
    bytes: Buffer.from(
      canonicalJson({
        id,
        transferReference: 't-' + id,
        componentIds: components,
        net: money(net),
        gross: money('10000'),
        fees: money('-300'),
        refunds: money('0'),
        chargebacks: money('0'),
        reportedAt: '2026-01-02T00:00:00.000Z',
      }),
    ),
  };
}
async function account(): Promise<string> {
  return ingestion.registerSource({
    bookId,
    environment: 'synthetic',
    provider: 'processor-test',
    externalAccountId: randomUUID(),
  });
}
async function normalized(
  aid: string,
  records: RawInput[],
  version:
    | 'synthetic-movement-v1'
    | 'synthetic-movement-v2'
    | 'synthetic-settlement-v1' = 'synthetic-movement-v1',
) {
  const b = await ingestion.ingest({
    sourceAccountId: aid,
    batchKey: randomUUID(),
    actorId: 'processor-test',
    provenance: { adapter: 'test-v1' },
    records,
  });
  if (version !== 'synthetic-movement-v1')
    await ingestion.requestNormalization(b.id, version, 'test');
  await ingestion.normalizeBatch(b.id, version);
  const revisions = (
    await ip.query<{ revision_id: string }>(
      'SELECT revision_id FROM ingestion.raw_record WHERE batch_id=$1 ORDER BY receipt_order',
      [b.id],
    )
  ).rows.map((r) => r.revision_id);
  return { batchId: b.id, revisions };
}
async function derived(
  aid: string,
  records: RawInput[],
  version:
    | 'synthetic-movement-v1'
    | 'synthetic-settlement-v1' = 'synthetic-movement-v1',
) {
  const n = await normalized(aid, records, version);
  const results = [];
  for (const id of n.revisions)
    results.push(await processor.derive(id, version));
  return { ...n, results };
}
function code(c: string) {
  return (e: unknown) =>
    typeof e === 'object' && e !== null && 'code' in e && e.code === c;
}
async function rejectedTx(
  fn: (c: PoolClient) => Promise<unknown>,
  expected: string,
) {
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
async function contend(
  aid: string,
  work: (api: PostgresProcessor, i: number) => Promise<unknown>,
  n = 12,
) {
  const name = randomUUID(),
    pool = new Pool({ connectionString: url, application_name: name, max: n }),
    api = new PostgresProcessor(pool),
    locker = await admin.connect();
  try {
    await locker.query('BEGIN');
    await locker.query(
      'SELECT id FROM ingestion.source_account WHERE id=$1 FOR UPDATE',
      [aid],
    );
    const pending = Promise.allSettled(
      Array.from({ length: n }, (_, i) => work(api, i)),
    );
    const end = Date.now() + 8000;
    let blocked = false;
    while (Date.now() < end) {
      const row = (
        await admin.query(
          "SELECT count(*)::integer AS n FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'",
          [name],
        )
      ).rows[0];
      if (row.n >= n) {
        blocked = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(blocked, 'All workers must actually wait on PostgreSQL locks');
    await locker.query('COMMIT');
    return await pending;
  } finally {
    await locker.query('ROLLBACK');
    locker.release();
    await pool.end();
  }
}
function fulfilled(results: PromiseSettledResult<unknown>[]) {
  return results.map((r) => {
    assert.equal(r.status, 'fulfilled');
    return (r as PromiseFulfilledResult<{ id: string }>).value;
  });
}

test('provenance, exact signed components, independent payment identity and lifecycle with multiple refunds/fees', async () => {
  const aid = await account();
  const capture = await derived(aid, [movement('c')]);
  const payment = capture.results[0]!.paymentId!;
  assert.equal(
    (await processor.evaluate('payment', payment, 'captured')).result.lifecycle,
    'captured',
  );
  await derived(aid, [
    movement('f1', 'fee', '-300', 'p', 'c'),
    movement('f2', 'fee', '-10', 'p', 'c'),
    movement('r1', 'refund', '-2000', 'p', 'c'),
  ]);
  assert.equal(
    (await processor.evaluate('payment', payment, 'partial')).result.lifecycle,
    'partially_refunded',
  );
  await derived(aid, [movement('r2', 'refund', '-8000', 'p', 'c')]);
  const full = await processor.evaluate('payment', payment, 'full');
  assert.equal(full.result.lifecycle, 'refunded');
  assert.equal(full.result.validRefundMinor, '10000');
  const batch = await derived(
    aid,
    [report('s', ['c', 'f1', 'f2', 'r1', 'r2'], '-310')],
    'synthetic-settlement-v1',
  );
  const evaluation = await processor.evaluate(
    'settlement',
    batch.results[0]!.id,
    'first',
  );
  assert.deepEqual(evaluation.result.controls, []);
  assert.equal(evaluation.result.calculatedNetMinor, '-310');
  const provenance = (
    await writer.query(
      'SELECT d.revision_id,i.basis_raw_id,r.payload_bytes FROM processor.derivation d JOIN ingestion.interpretation i ON i.revision_id=d.revision_id AND i.normalizer_version=d.normalizer_version JOIN ingestion.raw_record r ON r.id=i.basis_raw_id WHERE d.id=$1',
      [capture.results[0]!.id],
    )
  ).rows[0];
  assert.equal(provenance.revision_id, capture.revisions[0]);
  assert.ok(provenance.payload_bytes.length);
  assert.equal(
    (
      await admin.query(
        'SELECT count(*)::text AS n FROM ledger.ledger_transaction WHERE book_id=$1',
        [bookId],
      )
    ).rows[0].n,
    '0',
  );
  const other = await account(),
    otherCapture = await derived(other, [movement('c')]);
  assert.notEqual(otherCapture.results[0]!.paymentId, payment);
});

test('chargeback is distinct from refund; invalid directions and parents remain explicit', async () => {
  const aid = await account();
  const c = await derived(aid, [
    movement('c'),
    movement('cb', 'chargeback', '-5000', 'p', 'c'),
  ]);
  const p = c.results[0]!.paymentId!;
  const result = (await processor.evaluate('payment', p, 'chargeback')).result;
  assert.equal(result.lifecycle, 'charged_back');
  assert.equal(result.refundedMinor, '0');
  assert.equal(result.chargebackMinor, '5000');
  await derived(aid, [
    movement('bad', 'refund', '2000', 'p', 'c'),
    movement('orphan', 'refund', '-1', 'p', 'absent'),
  ]);
  const invalid = (await processor.evaluate('payment', p, 'invalid')).result;
  assert.equal(invalid.lifecycle, 'under_review');
  assert.ok(invalid.controls.includes('INVALID_SIGN'));
  assert.ok(invalid.controls.includes('INVALID_PARENT'));
  assert.equal(invalid.validRefundMinor, '0');
});

test('processor controls retain missing, duplicate, cross-currency and net mismatch evidence', async () => {
  const aid = await account();
  await derived(aid, [
    movement('c'),
    movement('f', 'fee', '-300', 'p', 'c'),
    movement('usd', 'capture', '100', 'u', null, 'USD'),
  ]);
  for (const [id, components, net, expected] of [
    ['missing', ['c', 'missing'], '10000', 'MISSING_ACTIVITY'],
    ['duplicate', ['c', 'c'], '20000', 'DUPLICATE_MEMBERSHIP'],
    ['cross', ['usd'], '100', 'CROSS_CURRENCY_MEMBERSHIP'],
    ['wrong-net', ['f'], '-301', 'NET_MISMATCH'],
  ] as const) {
    const batch = await derived(
      aid,
      [report(id, [...components], net)],
      'synthetic-settlement-v1',
    );
    const evaluation = await processor.evaluate(
      'settlement',
      batch.results[0]!.id,
      'control',
    );
    assert.ok(evaluation.result.controls.includes(expected));
    if (expected !== 'NET_MISMATCH')
      assert.equal(evaluation.result.calculatedNetMinor, null);
    else {
      assert.equal(evaluation.result.reportedNetMinor, '-301');
      assert.equal(evaluation.result.calculatedNetMinor, '-300');
    }
    assert.equal(
      (
        await writer.query(
          'SELECT count(*)::text AS n FROM audit.audit_event WHERE processor_evaluation_id=$1',
          [evaluation.id],
        )
      ).rows[0].n,
      '1',
    );
  }
});

test('out-of-order membership freezes missing result; later activity creates new reproducible evaluation', async () => {
  const aid = await account(),
    s = await derived(
      aid,
      [report('s', ['c'], '10000')],
      'synthetic-settlement-v1',
    );
  const sid = s.results[0]!.id;
  const old = await processor.evaluate('settlement', sid, 'before');
  assert.ok(old.result.controls.includes('MISSING_ACTIVITY'));
  await derived(aid, [movement('c')]);
  const current = await processor.evaluate('settlement', sid, 'after');
  assert.deepEqual(current.result.controls, []);
  assert.deepEqual(
    (await processor.evaluate('settlement', sid, 'before')).result,
    old.result,
  );
  const input = (
    await writer.query('SELECT input FROM processor.evaluation WHERE id=$1', [
      current.id,
    ])
  ).rows[0].input;
  assert.ok(input.members[0].activityId);
});

test('source corrections preserve activities/calculation history and invalidate unambiguous selection', async () => {
  const aid = await account(),
    c = await derived(aid, [{ ...movement('c'), sourceRevision: '1' }]);
  const s = await derived(
    aid,
    [report('s', ['c'], '10000')],
    'synthetic-settlement-v1',
  );
  const original = await processor.evaluate(
    'settlement',
    s.results[0]!.id,
    'original',
  );
  assert.deepEqual(original.result.controls, []);
  await derived(aid, [
    { ...movement('c', 'capture', '9600'), sourceRevision: '2' },
  ]);
  const next = await processor.evaluate(
    'settlement',
    s.results[0]!.id,
    'correction',
  );
  assert.ok(next.result.controls.includes('AMBIGUOUS_ACTIVITY'));
  assert.equal(next.result.calculatedNetMinor, null);
  assert.deepEqual(
    (await processor.evaluate('settlement', s.results[0]!.id, 'original'))
      .result,
    original.result,
  );
  assert.equal(
    (
      await writer.query(
        'SELECT contribution_minor::text AS n FROM processor.activity WHERE id=$1',
        [c.results[0]!.id],
      )
    ).rows[0].n,
    '10000',
  );
  assert.equal(
    (
      await processor.evaluate(
        'payment',
        c.results[0]!.paymentId!,
        'correction',
      )
    ).result.lifecycle,
    'under_review',
  );
  await derived(aid, [report('s', ['c'], '9600')], 'synthetic-settlement-v1');
  assert.ok(
    (
      await processor.evaluate('settlement', s.results[0]!.id, 'changed-report')
    ).result.controls.includes('AMBIGUOUS_SETTLEMENT'),
  );
});

test('normalization versions are pinned and never double-counted; unsupported interpretation and evaluation key drift rejected', async () => {
  const aid = await account(),
    n = await normalized(aid, [movement('c')]);
  const first = await processor.derive(
    n.revisions[0]!,
    'synthetic-movement-v1',
  );
  await ingestion.requestNormalization(
    n.batchId,
    'synthetic-movement-v2',
    'test',
  );
  await ingestion.normalizeBatch(n.batchId, 'synthetic-movement-v2');
  const second = await processor.derive(
    n.revisions[0]!,
    'synthetic-movement-v2',
  );
  assert.notEqual(first.id, second.id);
  assert.equal(first.paymentId, second.paymentId);
  for (const nv of ['synthetic-movement-v1', 'synthetic-movement-v2'])
    assert.equal(
      (await processor.evaluate('payment', first.paymentId!, nv, nv)).result
        .capturedMinor,
      '10000',
    );
  await assert.rejects(
    processor.derive(
      n.revisions[0]!,
      'synthetic-movement-v1',
      'processor-future',
    ),
    code('P4002'),
  );
  await assert.rejects(
    processor.evaluate(
      'payment',
      first.paymentId!,
      'synthetic-movement-v1',
      'synthetic-movement-v2',
    ),
    code('P4001'),
  );
});

test('actual duplicate derivation and concurrent payment association converge under 12 blocked workers', async () => {
  const aid = await account(),
    n = await normalized(aid, [
      movement('c'),
      movement('f', 'fee', '-300', 'p', 'c'),
    ]);
  const duplicate = fulfilled(
    await contend(aid, (api) =>
      api.derive(n.revisions[0]!, 'synthetic-movement-v1'),
    ),
  );
  assert.equal(new Set(duplicate.map((r) => r.id)).size, 1);
  const associationAccount = await account();
  const related = await normalized(associationAccount, [
    movement('c'),
    movement('f', 'fee', '-300', 'p', 'c'),
  ]);
  fulfilled(
    await contend(associationAccount, (api, i) =>
      api.derive(related.revisions[i % 2]!, 'synthetic-movement-v1'),
    ),
  );
  assert.equal(
    (
      await writer.query(
        'SELECT count(*)::text AS n FROM processor.payment WHERE source_account_id=$1',
        [associationAccount],
      )
    ).rows[0].n,
    '1',
  );
  assert.equal(
    (
      await writer.query(
        'SELECT count(*)::text AS n FROM processor.activity WHERE source_account_id=$1',
        [associationAccount],
      )
    ).rows[0].n,
    '2',
  );
});

test('concurrent identical settlement derivation creates one membership; conflicting batches yield explicit controls', async () => {
  const aid = await account();
  await derived(aid, [movement('c')]);
  const n = await normalized(
    aid,
    [report('s', ['c'], '10000'), report('competing', ['c'], '10000')],
    'synthetic-settlement-v1',
  );
  const results = fulfilled(
    await contend(aid, (api) =>
      api.derive(n.revisions[0]!, 'synthetic-settlement-v1'),
    ),
  );
  assert.equal(new Set(results.map((r) => r.id)).size, 1);
  assert.equal(
    (
      await writer.query(
        'SELECT count(*)::text AS n FROM processor.membership WHERE batch_id=$1',
        [results[0]!.id],
      )
    ).rows[0].n,
    '1',
  );
  fulfilled(
    await contend(aid, (api, i) =>
      api.derive(n.revisions[i % 2]!, 'synthetic-settlement-v1'),
    ),
  );
  const batches = (
    await writer.query(
      'SELECT id FROM processor.settlement_batch WHERE source_account_id=$1',
      [aid],
    )
  ).rows;
  for (const b of batches)
    assert.ok(
      (
        await processor.evaluate('settlement', b.id, 'conflict')
      ).result.controls.includes('CONFLICTING_MEMBERSHIP'),
    );
});

test('concurrent refunds cannot produce a validated over-refund; all offending external claims survive', async () => {
  const aid = await account(),
    c = await derived(aid, [movement('c')]),
    n = await normalized(aid, [
      movement('r1', 'refund', '-6000', 'p', 'c'),
      movement('r2', 'refund', '-6000', 'p', 'c'),
    ]);
  fulfilled(
    await contend(aid, (api, i) =>
      api.derive(n.revisions[i % 2]!, 'synthetic-movement-v1'),
    ),
  );
  const evaluated = await processor.evaluate(
    'payment',
    c.results[0]!.paymentId!,
    'refunds',
  );
  assert.equal(evaluated.result.refundedMinor, '12000');
  assert.equal(evaluated.result.validRefundMinor, '0');
  assert.ok(evaluated.result.controls.includes('REFUND_EXCEEDS_CAPTURE'));
  assert.equal(evaluated.result.lifecycle, 'under_review');
  await rejectedTx(
    (cl) =>
      cl.query(
        'INSERT INTO processor.evaluation(source_account_id,payment_id,evaluation_key,activity_normalizer_version,interpreter_version,input,result) VALUES($1,$2,\'forged\',\'synthetic-movement-v1\',\'processor-v1\',\'{}\', \'{"controls":[],"lifecycle":"refunded","capturedMinor":"10000","validRefundMinor":"12000"}\')',
        [aid, c.results[0]!.paymentId],
      ),
    'P4003',
  );
});

test('database runtime privileges, immutable history, sealed membership and deferred population/intent guards', async () => {
  const aid = await account(),
    c = await derived(aid, [movement('c')]),
    s = await derived(
      aid,
      [report('s', ['c'], '10000')],
      'synthetic-settlement-v1',
    );
  await processor.evaluate('payment', c.results[0]!.paymentId!, 'valid');
  await processor.evaluate('settlement', s.results[0]!.id, 'valid');
  for (const table of [
    'payment',
    'derivation',
    'activity',
    'settlement_batch',
    'membership',
    'evaluation',
    'evaluation_activity',
    'interpreter_version',
  ]) {
    await assert.rejects(
      writer.query(`DELETE FROM processor.${table}`),
      code('42501'),
    );
    await rejectedTx(
      (cl) => cl.query(`DELETE FROM processor.${table}`),
      'P1003',
    );
    await rejectedTx(
      (cl) => cl.query(`TRUNCATE processor.${table} CASCADE`),
      'P1003',
    );
  }
  await rejectedTx(
    (cl) =>
      cl.query(
        'UPDATE processor.activity SET contribution_minor=1 WHERE id=$1',
        [c.results[0]!.id],
      ),
    'P1003',
  );
  await rejectedTx(
    (cl) =>
      cl.query("INSERT INTO processor.membership VALUES($1,2,'c')", [
        s.results[0]!.id,
      ]),
    'P4003',
  );
  await assert.rejects(
    writer.query('SELECT ledger.post_journal($1::jsonb)', ['{}']),
    code('42501'),
  );
  await assert.rejects(
    writer.query('SET ROLE flow_ledger_owner'),
    code('42501'),
  );
  const another = await normalized(aid, [movement('orphan')]);
  await rejectedTx(
    (cl) =>
      cl.query(
        "INSERT INTO processor.derivation(revision_id,normalizer_version,interpreter_version,source_account_id,fact_id,kind) SELECT r.id,'synthetic-movement-v1','processor-v1',r.source_account_id,r.fact_id,'activity' FROM ingestion.revision r WHERE id=$1",
        [another.revisions[0]],
      ),
    'P4004',
  );
});

test('failure after identity/activity/member/audit/outbox creation rolls back the whole stage; normalized input survives', async () => {
  for (const table of [
    'processor.payment',
    'processor.activity',
    'processor.membership',
    'outbox.outbox_event',
    'audit.audit_event',
  ]) {
    const aid = await account(),
      settlement = table === 'processor.membership',
      n = await normalized(
        aid,
        [
          settlement
            ? report('s', ['c'])
            : movement(
                'c',
                'capture',
                table === 'audit.audit_event' ? '-1' : '10000',
              ),
        ],
        settlement ? 'synthetic-settlement-v1' : 'synthetic-movement-v1',
      );
    const nv = settlement ? 'synthetic-settlement-v1' : 'synthetic-movement-v1';
    let subject: string | undefined;
    if (table === 'audit.audit_event')
      subject = (await processor.derive(n.revisions[0]!, nv)).paymentId!;
    await admin.query(
      "CREATE FUNCTION public.phase4_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION USING ERRCODE='P4999',MESSAGE='Synthetic processor failure'; END $$",
    );
    try {
      await admin.query(
        `CREATE TRIGGER phase4_fail AFTER INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION public.phase4_fail()`,
      );
      await assert.rejects(
        subject
          ? processor.evaluate('payment', subject, 'failed')
          : processor.derive(n.revisions[0]!, nv),
        code('P4999'),
      );
      if (subject)
        assert.equal(
          (
            await writer.query(
              'SELECT count(*)::text AS n FROM processor.evaluation WHERE payment_id=$1',
              [subject],
            )
          ).rows[0].n,
          '0',
        );
      else
        assert.equal(
          (
            await writer.query(
              'SELECT count(*)::text AS n FROM processor.derivation WHERE revision_id=$1',
              [n.revisions[0]],
            )
          ).rows[0].n,
          '0',
        );
      assert.equal((await ingestion.summary(n.batchId, nv)).normalized, 1);
    } finally {
      await admin.query(`DROP TRIGGER phase4_fail ON ${table}`);
      await admin.query('DROP FUNCTION public.phase4_fail()');
    }
    if (subject)
      assert.ok(
        (await processor.evaluate('payment', subject, 'failed')).result.controls
          .length,
      );
    else
      assert.equal(
        (await processor.derive(n.revisions[0]!, nv)).replayed,
        false,
      );
  }
});

test('backend crash during derivation rolls back identity and history; unchanged retry recovers', async () => {
  for (const settlement of [false, true]) {
    const aid = await account(),
      n = await normalized(
        aid,
        [settlement ? report('s', ['c']) : movement('c')],
        settlement ? 'synthetic-settlement-v1' : 'synthetic-movement-v1',
      ),
      cl = await writer.connect();
    cl.on('error', () => {});
    try {
      await cl.query('BEGIN');
      const pid = (await cl.query('SELECT pg_backend_pid() AS pid')).rows[0]
        .pid;
      await cl.query("SELECT processor.derive($1,$2,'processor-v1')", [
        n.revisions[0],
        settlement ? 'synthetic-settlement-v1' : 'synthetic-movement-v1',
      ]);
      await admin.query('SELECT pg_terminate_backend($1)', [pid]);
      await assert.rejects(cl.query('COMMIT'));
    } finally {
      cl.release(true);
    }
    assert.equal(
      (
        await writer.query(
          'SELECT count(*)::text AS n FROM processor.payment WHERE source_account_id=$1',
          [aid],
        )
      ).rows[0].n,
      '0',
    );
    assert.equal(
      (
        await ingestion.summary(
          n.batchId,
          settlement ? 'synthetic-settlement-v1' : 'synthetic-movement-v1',
        )
      ).normalized,
      1,
    );
    assert.equal(
      (
        await processor.derive(
          n.revisions[0]!,
          settlement ? 'synthetic-settlement-v1' : 'synthetic-movement-v1',
        )
      ).replayed,
      false,
    );
  }
});

test('actual lost COMMIT acknowledgement for derivation and evaluation replays one durable result', async () => {
  for (const action of ['derive', 'evaluate']) {
    const aid = await account(),
      n = await normalized(aid, [movement('c')]);
    const payment =
      action === 'evaluate'
        ? (await processor.derive(n.revisions[0]!, 'synthetic-movement-v1'))
            .paymentId
        : undefined;
    const proxy = await commitDropProxy(url!),
      pool = new Pool({ connectionString: proxy.url });
    pool.on('error', () => {});
    const api = new PostgresProcessor(pool, writer);
    try {
      await assert.rejects(
        payment
          ? api.evaluate('payment', payment, 'unknown')
          : api.derive(n.revisions[0]!, 'synthetic-movement-v1'),
        UnknownProcessorCommit,
      );
      await proxy.dropped;
      const recovered = payment
        ? await processor.evaluate('payment', payment, 'unknown')
        : await processor.derive(n.revisions[0]!, 'synthetic-movement-v1');
      assert.equal(recovered.replayed, true);
    } finally {
      await pool.end();
      await proxy.close();
    }
  }
});

test('real DB idempotency, exact totals and correction preservation property: 30 trials seed 70404', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.bigInt({ min: 1n, max: 9223372036854775806n }),
      fc.integer({ min: 1, max: 4 }),
      async (amount, n) => {
        const aid = await account(),
          c = await derived(aid, [movement('c', 'capture', String(amount))]);
        for (let i = 0; i < n; i++)
          assert.equal(
            (await processor.derive(c.revisions[0]!, 'synthetic-movement-v1'))
              .id,
            c.results[0]!.id,
          );
        const old = await processor.evaluate(
          'payment',
          c.results[0]!.paymentId!,
          'old',
        );
        assert.equal(old.result.capturedMinor, String(amount));
        await derived(aid, [movement('c', 'capture', String(amount + 1n))]);
        assert.equal(
          (await processor.evaluate('payment', c.results[0]!.paymentId!, 'new'))
            .result.lifecycle,
          'under_review',
        );
        assert.deepEqual(
          (await processor.evaluate('payment', c.results[0]!.paymentId!, 'old'))
            .result,
          old.result,
        );
      },
    ),
    { numRuns: 30, seed: 70404 },
  );
});

test('correction committed while original derivation waits does not authorize receipt-order supersession', async () => {
  const aid = await account(),
    n = await normalized(aid, [movement('c')]);
  const locker = await admin.connect(),
    pool = new Pool({
      connectionString: url,
      application_name: 'phase4-correction-wait',
    }),
    api = new PostgresProcessor(pool);
  let pending: Promise<unknown> | undefined;
  try {
    await locker.query('BEGIN');
    await locker.query(
      'SELECT id FROM ingestion.source_account WHERE id=$1 FOR UPDATE',
      [aid],
    );
    pending = api.derive(n.revisions[0]!, 'synthetic-movement-v1');
    const end = Date.now() + 8000;
    let blocked = false;
    while (Date.now() < end) {
      const row = (
        await admin.query(
          "SELECT count(*)::integer AS n FROM pg_stat_activity WHERE application_name='phase4-correction-wait' AND wait_event_type='Lock'",
        )
      ).rows[0];
      if (row.n === 1) {
        blocked = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(blocked);
    const cmd = {
      sourceAccountId: aid,
      batchKey: randomUUID(),
      actorId: 'test',
      provenance: { adapter: 'test' },
      records: [movement('c', 'capture', '9600')],
    };
    const { batchPayload } = await import('@flow/ingestion-domain');
    await locker.query('SELECT ingestion.accept_batch($1::jsonb)', [
      batchPayload(cmd),
    ]);
    await locker.query('COMMIT');
    const original = (await pending) as { paymentId: string; id: string };
    const evaluation = await processor.evaluate(
      'payment',
      original.paymentId,
      'correction-during-processing',
    );
    assert.equal(evaluation.result.lifecycle, 'under_review');
    assert.ok(evaluation.result.controls.includes('AMBIGUOUS_ACTIVITY'));
    assert.equal(
      (
        await writer.query(
          'SELECT contribution_minor::text AS n FROM processor.activity WHERE id=$1',
          [original.id],
        )
      ).rows[0].n,
      '10000',
    );
  } finally {
    await locker.query('ROLLBACK');
    locker.release();
    await pending?.catch(() => {});
    await pool.end();
  }
});

test('cross-currency payment aggregate is unknown rather than adding incompatible money', async () => {
  const aid = await account(),
    c = await derived(aid, [
      movement('php'),
      movement('usd', 'capture', '500', 'p', null, 'USD'),
    ]);
  const e = await processor.evaluate(
    'payment',
    c.results[0]!.paymentId!,
    'mixed',
  );
  assert.ok(e.result.controls.includes('CROSS_CURRENCY_PAYMENT'));
  assert.equal(e.result.currency, null);
  assert.equal(e.result.capturedMinor, null);
  assert.equal(e.result.validRefundMinor, '0');
});

test('processor adapter retries whole unchanged commands for retryable SQLSTATEs', async () => {
  for (const sqlstate of ['40001', '40P01']) {
    const aid = await account(),
      n = await normalized(aid, [movement('c')]);
    await admin.query('CREATE SEQUENCE public.phase4_retry_attempt');
    await admin.query(
      'GRANT USAGE ON SEQUENCE public.phase4_retry_attempt TO flow_ledger_owner',
    );
    await admin.query(
      `CREATE FUNCTION public.phase4_retry() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF nextval('public.phase4_retry_attempt')=1 THEN RAISE EXCEPTION USING ERRCODE='${sqlstate}',MESSAGE='Synthetic retry injection'; END IF; RETURN NEW; END $$`,
    );
    try {
      await admin.query(
        'CREATE TRIGGER phase4_retry BEFORE INSERT ON processor.derivation FOR EACH ROW EXECUTE FUNCTION public.phase4_retry()',
      );
      const result = await processor.derive(
        n.revisions[0]!,
        'synthetic-movement-v1',
      );
      assert.equal(result.replayed, false);
      assert.equal(
        (await processor.derive(n.revisions[0]!, 'synthetic-movement-v1')).id,
        result.id,
      );
      assert.equal(
        (
          await writer.query(
            'SELECT count(*)::text AS n FROM processor.activity WHERE source_account_id=$1',
            [aid],
          )
        ).rows[0].n,
        '1',
      );
    } finally {
      await admin.query('DROP TRIGGER phase4_retry ON processor.derivation');
      await admin.query('DROP FUNCTION public.phase4_retry()');
      await admin.query('DROP SEQUENCE public.phase4_retry_attempt');
    }
  }
});

test('real PostgreSQL cumulative refund bound property: 25 trials seed 70410', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.bigInt({ min: 1n, max: 100000n }),
      fc.array(fc.bigInt({ min: 1n, max: 50000n }), {
        minLength: 1,
        maxLength: 5,
      }),
      async (capture, refunds) => {
        const aid = await account(),
          c = await derived(aid, [
            movement('c', 'capture', String(capture)),
            ...refunds.map((r, i) =>
              movement('r' + i, 'refund', String(-r), 'p', 'c'),
            ),
          ]);
        const e = await processor.evaluate(
          'payment',
          c.results[0]!.paymentId!,
          'bound',
        );
        const total = refunds.reduce((a, b) => a + b, 0n);
        assert.equal(BigInt(e.result.refundedMinor!), total);
        assert.ok(BigInt(e.result.validRefundMinor!) <= capture);
        assert.equal(
          e.result.controls.includes('REFUND_EXCEEDS_CAPTURE'),
          total > capture,
        );
        assert.equal(
          e.result.validRefundMinor,
          total > capture ? '0' : String(total),
        );
      },
    ),
    { numRuns: 25, seed: 70410 },
  );
});

test('processor SQL preserves signed Money minimum, zero fees and totals wider than BIGINT', async () => {
  const aid = await account();
  await derived(aid, [
    movement('c1', 'capture', '9223372036854775807', 'p1'),
    movement('c2', 'capture', '9223372036854775807', 'p2'),
    movement('fee', 'fee', '0', 'p1', 'c1'),
  ]);
  const s = await derived(
    aid,
    [report('wide', ['c1', 'c2', 'fee'], '9223372036854775807')],
    'synthetic-settlement-v1',
  );
  const wide = await processor.evaluate('settlement', s.results[0]!.id, 'wide');
  assert.equal(wide.result.calculatedNetMinor, '18446744073709551614');
  assert.deepEqual(wide.result.controls, ['NET_MISMATCH']);
  const other = await account();
  await derived(other, [
    movement('c', 'capture', '1'),
    movement('cb', 'chargeback', '-9223372036854775808', 'p', 'c'),
  ]);
  const batch = await derived(
    other,
    [report('negative', ['c', 'cb'], '-9223372036854775807')],
    'synthetic-settlement-v1',
  );
  const negative = await processor.evaluate(
    'settlement',
    batch.results[0]!.id,
    'negative',
  );
  assert.equal(negative.result.calculatedNetMinor, '-9223372036854775807');
  assert.deepEqual(negative.result.controls, []);
});
