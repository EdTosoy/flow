import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, after, test } from 'node:test';
import { Pool } from 'pg';
import fc from 'fast-check';
import { PostgresIngestion } from '@flow/ingestion-postgres';
import {
  PostgresReconciliation,
  UnknownReconciliationCommit,
} from '@flow/reconciliation-postgres';
import {
  fixture,
  installInvariantSweeps,
  entry,
  report,
  money,
  importEvidence,
} from './helpers/reconciliation-fixture';
import { commitDropProxy } from './helpers/commit-proxy';
installInvariantSweeps();
const au = process.env['FLOW_TEST_ADMIN_URL'],
  ru = process.env['FLOW_TEST_RECONCILIATION_URL'],
  iu = process.env['FLOW_TEST_INGESTION_URL'],
  pu = process.env['FLOW_TEST_PROCESSOR_URL'],
  bu = process.env['FLOW_TEST_BANK_URL'];
if (!au || !ru || !iu || !pu || !bu)
  throw new Error('Run pnpm test:integration');
const admin = new Pool({ connectionString: au }),
  rp = new Pool({ connectionString: ru }),
  ip = new Pool({ connectionString: iu }),
  pp = new Pool({ connectionString: pu }),
  bp = new Pool({ connectionString: bu });
const recon = new PostgresReconciliation(rp);
before(async () => {
  await admin.query('SELECT 1');
});
after(async () => {
  await Promise.all([admin.end(), rp.end(), ip.end(), pp.end(), bp.end()]);
});
const setup = (options: Parameters<typeof fixture>[4] = {}) =>
  fixture(admin, ip, pp, bp, options);
const counts = (
  r: Awaited<ReturnType<PostgresReconciliation['run']>>,
  side: string,
  outcome: string,
) =>
  r.outcomes.find((x) => x.side === side && x.outcome === outcome)?.count ?? 0;
test('exact successful proof retains normalized provenance, audit, outbox, whole-item conservation and complete coverage', async () => {
  const f = await setup(),
    r = await recon.run(f.command);
  assert.equal(r.state, 'COMPLETED');
  assert.equal(r.matchedGroups, 1);
  assert.equal(counts(r, 'PROCESSOR', 'MATCHED'), 1);
  assert.equal(counts(r, 'BANK', 'MATCHED'), 1);
  assert.equal(r.sourceCoverage, 'UNKNOWN');
  assert.deepEqual(r.current, [{ status: 'ACTIVE', count: 1 }]);
  const group = (
    await rp.query('SELECT * FROM reconciliation.match_group WHERE run_id=$1', [
      r.id,
    ])
  ).rows[0];
  assert.equal(group.signed_amount_minor, '970000');
  assert.equal(group.evidence.referenceExact, true);
  assert.equal(group.evidence.ruleVersion, 'settlement-bank-exact-v1');
  assert.equal(
    group.evidence.processorSnapshot.normalizerVersion,
    'synthetic-settlement-v1',
  );
  assert.equal(group.evidence.bankSnapshot.interpreterVersion, 'bank-v1');
  assert.equal(
    (
      await rp.query(
        'SELECT count(*)::integer n FROM reconciliation.active_allocation WHERE group_id=$1',
        [group.id],
      )
    ).rows[0].n,
    2,
  );
  assert.equal(
    (
      await admin.query(
        'SELECT count(*)::integer n FROM audit.audit_event WHERE reconciliation_decision_id IN(SELECT id FROM reconciliation.allocation_decision WHERE group_id=$1)',
        [group.id],
      )
    ).rows[0].n,
    1,
  );
  assert.equal(
    (
      await admin.query(
        'SELECT count(*)::integer n FROM ledger.ledger_transaction WHERE book_id=$1',
        [f.book],
      )
    ).rows[0].n,
    0,
  );
  assert.deepEqual(
    await recon.run({ ...f.command, actorId: 'another-authorized-caller' }),
    r,
  );
});
test('no bank counterpart and extra unrelated bank entries receive explicit unmatched outcomes', async () => {
  const none = await setup({ banks: [] }),
    a = await recon.run(none.command);
  assert.equal(counts(a, 'PROCESSOR', 'UNMATCHED'), 1);
  assert.equal(a.bankPopulation, 0);
  const extra = await setup({
      banks: [entry(), entry('extra', '970000', 'unrelated')],
    }),
    b = await recon.run(extra.command);
  assert.equal(b.matchedGroups, 1);
  assert.equal(counts(b, 'BANK', 'UNMATCHED'), 1);
});
test('one-to-two identical reference candidates and two-to-one processor candidates remain ambiguous', async () => {
  const banks = await setup({ banks: [entry(), entry('copy')] }),
    r = await recon.run(banks.command);
  assert.equal(r.matchedGroups, 0);
  assert.equal(counts(r, 'PROCESSOR', 'AMBIGUOUS'), 1);
  assert.equal(counts(r, 'BANK', 'AMBIGUOUS'), 2);
  // Independent explicit source components avoid a Phase 4 conflicting-membership control masking the Phase 6 ambiguity test.
  const processors = await setup({
    reports: [
      report(),
      report('other', '970000', 'transfer', ['other-capture', 'other-fee']),
    ],
  });
  await importEvidence(
    processors.ingestion,
    processors.processor,
    processors.source,
    'synthetic-movement',
    'synthetic-movement-v1',
    [
      {
        id: 'other-capture',
        kind: 'capture',
        paymentReference: 'other-payment',
        parentCaptureId: null,
        amount: money('1000000'),
        occurredAt: '2026-01-01T00:02:00.000Z',
      },
      {
        id: 'other-fee',
        kind: 'fee',
        paymentReference: 'other-payment',
        parentCaptureId: 'other-capture',
        amount: money('-30000'),
        occurredAt: '2026-01-01T00:02:01.000Z',
      },
    ],
  );
  const second = await recon.run(processors.command);
  assert.equal(second.matchedGroups, 0);
  assert.equal(counts(second, 'PROCESSOR', 'AMBIGUOUS'), 2);
  assert.equal(counts(second, 'BANK', 'AMBIGUOUS'), 1);
});
test('amount/currency/reference/direction/time mismatches never become proof', async () => {
  for (const banks of [
    [entry('bank', '969999')],
    [entry('bank', '970000', 'wrong')],
    [entry('bank', '-970000')],
    [
      entry('bank', '970000', 'transfer', {
        bookedAt: '2026-01-06T00:00:00.000Z',
      }),
    ],
    [entry('bank', '970000', 'transfer', { amount: money('970000', 'USD') })],
  ]) {
    const f = await setup({ banks }),
      r = await recon.run(f.command);
    assert.equal(r.matchedGroups, 0);
    assert.equal(counts(r, 'PROCESSOR', 'UNMATCHED'), 1);
    if (
      banks[0]?.['amount'] &&
      (banks[0]['amount'] as { currency: string }).currency === 'USD'
    )
      assert.equal(r.bankPopulation, 0);
    else assert.equal(counts(r, 'BANK', 'UNMATCHED'), 1);
  }
});
test('late bank evidence belongs to a new frozen run; replay keeps earlier unmatched history', async () => {
  const f = await setup({ banks: [] }),
    old = await recon.run(f.command);
  await importEvidence(
    f.ingestion,
    f.bank,
    f.bankSource,
    'synthetic-bank-entry',
    'synthetic-bank-entry-v1',
    [entry()],
  );
  assert.deepEqual(await recon.run(f.command), old);
  const next = await recon.run({ ...f.command, runKey: 'late' });
  assert.equal(next.matchedGroups, 1);
  assert.equal(counts(old, 'PROCESSOR', 'UNMATCHED'), 1);
});
test('source correction invalidates current assurance immediately; new run retains all historical proof and ambiguity', async () => {
  const f = await setup(),
    old = await recon.run(f.command),
    history = await snapshot(old.id);
  await importEvidence(
    f.ingestion,
    f.processor,
    f.source,
    'synthetic-settlement',
    'synthetic-settlement-v1',
    [report('settlement', '960000')],
  );
  assert.deepEqual((await recon.summary(old.id)).current, [
    { status: 'INVALIDATED', count: 1 },
  ]);
  const next = await recon.run({ ...f.command, runKey: 'corrected' });
  assert.equal(counts(next, 'PROCESSOR', 'INELIGIBLE'), 1);
  assert.equal(next.matchedGroups, 0);
  assert.equal(await snapshot(old.id), history);
  assert.equal(
    (
      await rp.query(
        'SELECT count(*)::integer n FROM reconciliation.current_allocation a JOIN reconciliation.match_group g ON g.id=a.group_id WHERE g.run_id=$1',
        [old.id],
      )
    ).rows[0].n,
    0,
  );
});
async function snapshot(id: string) {
  return JSON.stringify(
    await Promise.all(
      [
        'run',
        'run_member',
        'candidate',
        'outcome_plan',
        'match_group',
        'match_group_member',
        'outcome',
      ].map(
        async (table) =>
          (
            await rp.query(
              `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') rows FROM reconciliation.${table} t WHERE ${table === 'run' ? 'id' : 'run_id'}=$1`,
              [id],
            )
          ).rows[0].rows,
      ),
    ),
  );
}
test('new runs supersede current allocation with linked audit while historical results stay byte-identical', async () => {
  const f = await setup(),
    old = await recon.run(f.command),
    before = await snapshot(old.id),
    next = await recon.run({ ...f.command, runKey: 'second' });
  assert.equal(next.matchedGroups, 1);
  assert.equal(await snapshot(old.id), before);
  assert.deepEqual((await recon.summary(old.id)).current, [
    { status: 'SUPERSEDED', count: 1 },
  ]);
  assert.equal(
    (
      await rp.query(
        'SELECT count(*)::integer n FROM reconciliation.current_allocation a JOIN reconciliation.match_group g ON g.id=a.group_id WHERE g.run_id=$1',
        [next.id],
      )
    ).rows[0].n,
    2,
  );
  assert.equal(
    (
      await rp.query(
        "SELECT count(*)::integer n FROM reconciliation.allocation_decision WHERE decision='SUPERSEDED' AND successor_group_id IN(SELECT id FROM reconciliation.match_group WHERE run_id=$1)",
        [next.id],
      )
    ).rows[0].n,
    1,
  );
});
test('processor-internal inconsistency, ambiguous bank evidence and unidentified entries are ineligible', async () => {
  const invalid = await setup({ capture: '999999' }),
    a = await recon.run(invalid.command);
  assert.equal(counts(a, 'PROCESSOR', 'INELIGIBLE'), 1);
  assert.equal(a.matchedGroups, 0);
  const ambiguous = await setup();
  await importEvidence(
    ambiguous.ingestion,
    ambiguous.bank,
    ambiguous.bankSource,
    'synthetic-bank-entry',
    'synthetic-bank-entry-v1',
    [entry('bank', '960000')],
  );
  const b = await recon.run(ambiguous.command);
  assert.equal(counts(b, 'BANK', 'INELIGIBLE'), 1);
  assert.equal(b.matchedGroups, 0);
  const unknown = await setup({ banks: [entry(null)] }),
    c = await recon.run(unknown.command);
  assert.equal(counts(c, 'BANK', 'INELIGIBLE'), 1);
  assert.equal(c.matchedGroups, 0);
});
test('bank-internal statement failures block associated entries; unrelated statement failures do not block a bare booked entry', async () => {
  const f = await setup({
    banks: [
      entry('bank', '970000', 'transfer', {
        statementReference: 'statement',
        lineIdentity: 'line-1',
      }),
    ],
  });
  await importEvidence(
    f.ingestion,
    f.bank,
    f.bankSource,
    'synthetic-bank-statement',
    'synthetic-bank-statement-v1',
    [
      {
        id: 'statement',
        currency: 'PHP',
        reportedAt: '2026-01-04T00:00:00.000Z',
        opening: money('0'),
        closing: money('969999'),
        expectedLineCount: 1,
        lineIds: ['line-1'],
      },
    ],
  );
  const r = await recon.run(f.command);
  assert.equal(counts(r, 'BANK', 'INELIGIBLE'), 1);
  assert.equal(r.matchedGroups, 0);
  const bare = await setup();
  await importEvidence(
    bare.ingestion,
    bare.bank,
    bare.bankSource,
    'synthetic-bank-statement',
    'synthetic-bank-statement-v1',
    [
      {
        id: 'unrelated',
        currency: 'PHP',
        reportedAt: '2026-01-04T00:00:00.000Z',
        opening: money('0'),
        closing: money('1'),
        expectedLineCount: 100,
      },
    ],
  );
  assert.equal((await recon.run(bare.command)).matchedGroups, 1);
});
test('run identity/config conflicts and unknown/unrelated mappings are explicit', async () => {
  const f = await setup();
  await recon.run(f.command);
  await assert.rejects(
    recon.run({ ...f.command, to: '2026-01-11T00:00:00.000Z' }),
    { code: 'P6001' },
  );
  await assert.rejects(recon.run({ ...f.command, mappingId: randomUUID() }));
  await assert.rejects(
    admin.query(
      "INSERT INTO reconciliation.account_mapping(book_id,processor_source_account_id,bank_source_account_id,currency,reference_contract) VALUES($1,$2,$3,'USD','synthetic-transfer-reference-v1')",
      [randomUUID(), f.source, f.bankSource],
    ),
    { code: '23503' },
  );
});
test('durable stages recover creation/freezing/partial progress; finalization rejects incomplete results', async () => {
  const f = await setup({ banks: [entry(), entry('extra', '1', 'other')] }),
    id = await recon.create(f.command);
  assert.equal((await recon.summary(id)).state, 'DRAFT');
  await recon.seal(id);
  assert.equal((await recon.summary(id)).state, 'SEALED');
  await recon.plan(id);
  await assert.rejects(recon.complete(id), { code: 'P6004' });
  await recon.advance(id, 1);
  assert.equal((await recon.summary(id)).state, 'RUNNING');
  const result = await recon.run(f.command);
  assert.equal(result.state, 'COMPLETED');
  assert.equal(result.matchedGroups, 1);
  assert.equal(counts(result, 'BANK', 'UNMATCHED'), 1);
});
test('frozen plan remains deterministic after contradictory late arrival; stale historical matches never allocate current value', async () => {
  const f = await setup(),
    id = await recon.create(f.command);
  await recon.seal(id);
  await recon.plan(id);
  await importEvidence(
    f.ingestion,
    f.bank,
    f.bankSource,
    'synthetic-bank-entry',
    'synthetic-bank-entry-v1',
    [entry('late-duplicate')],
  );
  const old = await recon.run(f.command);
  assert.equal(old.matchedGroups, 1);
  assert.deepEqual(old.current, [{ status: 'STALE', count: 1 }]);
  const next = await recon.run({ ...f.command, runKey: 'fresh' });
  assert.equal(next.matchedGroups, 0);
  assert.equal(counts(next, 'PROCESSOR', 'AMBIGUOUS'), 1);
});
test('20 real PostgreSQL exact/idempotency/history/conservation property trials', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.bigInt({ min: 1n, max: 9223372036854775807n }),
      fc.integer({ min: 1, max: 4 }),
      async (amount, n) => {
        const f = await setup({
          capture: amount.toString(),
          fee: '0',
          reports: [report('settlement', amount.toString())],
          banks: [entry('bank', amount.toString())],
        });
        const result = await recon.run(f.command),
          before = await snapshot(result.id);
        assert.equal(result.matchedGroups, 1);
        for (let i = 0; i < n; i++)
          assert.deepEqual(await recon.run(f.command), result);
        assert.equal(await snapshot(result.id), before);
        assert.equal(
          result.values.find((x) => x.side === 'PROCESSOR')?.amountMinor,
          amount.toString(),
        );
      },
    ),
    { numRuns: 20, seed: 70604 },
  );
});
async function contend(
  book: string,
  work: (r: PostgresReconciliation, i: number) => Promise<unknown>,
) {
  const blocker = await admin.connect(),
    name = 'recon-contend-' + randomUUID(),
    pool = new Pool({ connectionString: ru!, max: 12, application_name: name });
  let workers: Promise<PromiseSettledResult<unknown>[]> | undefined;
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT FROM ledger.book WHERE id=$1 FOR UPDATE', [
      book,
    ]);
    workers = Promise.allSettled(
      Array.from({ length: 12 }, (_, i) =>
        work(new PostgresReconciliation(pool), i),
      ),
    );
    const deadline = Date.now() + 8000;
    let blocked = 0;
    while (Date.now() < deadline) {
      blocked = (
        await admin.query(
          "SELECT count(*)::integer n FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'",
          [name],
        )
      ).rows[0].n;
      if (blocked === 12) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(
      blocked,
      12,
      'All contenders must reach a real PostgreSQL lock wait',
    );
    await blocker.query('COMMIT');
    const results = await workers;
    for (const result of results)
      assert.equal(
        result.status,
        'fulfilled',
        result.status === 'rejected' ? String(result.reason) : '',
      );
    return results;
  } finally {
    await blocker.query('ROLLBACK');
    blocker.release();
    await workers;
    await pool.end();
  }
}
test('twelve observed lock contenders execute the same command as one logical run/result/audit/intent', async () => {
  const f = await setup();
  await contend(f.book, (r) => r.run(f.command));
  const result = await recon.run(f.command);
  assert.equal(result.matchedGroups, 1);
  assert.equal(
    (
      await rp.query(
        'SELECT count(*)::integer n FROM reconciliation.run WHERE mapping_id=$1',
        [f.mappingId],
      )
    ).rows[0].n,
    1,
  );
  assert.equal(
    (
      await rp.query(
        'SELECT count(*)::integer n FROM reconciliation.allocation_decision WHERE caused_by_run_id=$1',
        [result.id],
      )
    ).rows[0].n,
    1,
  );
});
test('twelve candidate workers cannot duplicate a match or its allocation', async () => {
  const f = await setup(),
    id = await recon.create(f.command);
  await recon.seal(id);
  await recon.plan(id);
  await contend(f.book, (r) => r.advance(id));
  await recon.complete(id);
  assert.equal((await recon.summary(id)).matchedGroups, 1);
  assert.equal(
    (
      await rp.query(
        'SELECT count(*)::integer n FROM reconciliation.current_allocation a JOIN reconciliation.match_group g ON g.id=a.group_id WHERE g.run_id=$1',
        [id],
      )
    ).rows[0].n,
    2,
  );
});
test('competing processor and bank counterparts under observed contention never allocate ambiguous financial evidence', async () => {
  const f = await setup({ banks: [entry(), entry('competing')] }),
    id = await recon.create(f.command);
  await recon.seal(id);
  await recon.plan(id);
  await contend(f.book, (r) => r.advance(id));
  await recon.complete(id);
  assert.equal((await recon.summary(id)).matchedGroups, 0);
  assert.equal(
    (
      await admin.query(
        'SELECT count(*)::integer n FROM reconciliation.current_allocation a JOIN reconciliation.item i ON i.id=a.item_id JOIN ingestion.source_fact s ON s.id=i.source_fact_id WHERE s.source_account_id IN($1,$2)',
        [f.source, f.bankSource],
      )
    ).rows[0].n,
    0,
  );
});
test('overlapping historical/new runs contend without corrupting snapshots or double allocation', async () => {
  const f = await setup(),
    first = await recon.run(f.command),
    old = await snapshot(first.id);
  await contend(f.book, (r, i) =>
    r.run({ ...f.command, runKey: i % 2 ? 'new-1' : 'new-2' }),
  );
  assert.equal(await snapshot(first.id), old);
  const rows = (
    await rp.query(
      'SELECT a.item_id,count(*)::integer n FROM reconciliation.current_allocation a JOIN reconciliation.match_group g ON g.id=a.group_id JOIN reconciliation.run r ON r.id=g.run_id WHERE r.mapping_id=$1 GROUP BY a.item_id',
      [f.mappingId],
    )
  ).rows;
  assert.equal(rows.length, 2);
  assert.ok(rows.every((x) => x.n === 1));
});
test('concurrent corrected evidence and old-run retry preserve immutable history and invalidate current proof', async () => {
  const f = await setup(),
    old = await recon.run(f.command),
    before = await snapshot(old.id);
  const pending = await recon.create({ ...f.command, runKey: 'overlap' });
  await recon.seal(pending);
  await recon.plan(pending);
  const blocker = await admin.connect(),
    prefix = 'recon-correction-' + randomUUID(),
    rr = new Pool({ connectionString: ru!, application_name: prefix + '-run' }),
    ii = new Pool({
      connectionString: iu!,
      application_name: prefix + '-source',
    });
  let contenders: Promise<PromiseSettledResult<unknown>[]> | undefined;
  try {
    await blocker.query('BEGIN');
    await blocker.query(
      'SELECT FROM ingestion.source_account WHERE id=$1 FOR UPDATE',
      [f.bankSource],
    );
    contenders = Promise.allSettled([
      new PostgresReconciliation(rr).advance(pending),
      importEvidence(
        new PostgresIngestion(ii),
        f.bank,
        f.bankSource,
        'synthetic-bank-entry',
        'synthetic-bank-entry-v1',
        [entry('bank', '960000')],
      ),
    ]);
    const deadline = Date.now() + 8000;
    let waiting = 0;
    while (Date.now() < deadline) {
      waiting = (
        await admin.query(
          "SELECT count(*)::integer n FROM pg_stat_activity WHERE application_name IN($1,$2) AND wait_event_type='Lock'",
          [prefix + '-run', prefix + '-source'],
        )
      ).rows[0].n;
      if (waiting === 2) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(
      waiting,
      2,
      'Correction and acceptance both reached observed source lock contention',
    );
    await blocker.query('COMMIT');
    for (const result of await contenders)
      assert.equal(
        result.status,
        'fulfilled',
        result.status === 'rejected' ? String(result.reason) : '',
      );
  } finally {
    await blocker.query('ROLLBACK');
    blocker.release();
    await contenders;
    await Promise.all([rr.end(), ii.end()]);
  }
  await recon.complete(pending);
  assert.equal(await snapshot(old.id), before);
  assert.ok(
    ['SUPERSEDED', 'INVALIDATED'].includes(
      (await recon.summary(old.id)).current[0]?.status ?? '',
    ),
  );
  const active = (
    await rp.query(
      'SELECT count(*)::integer n FROM reconciliation.active_allocation a JOIN reconciliation.match_group g ON g.id=a.group_id JOIN reconciliation.run r ON r.id=g.run_id WHERE r.mapping_id=$1',
      [f.mappingId],
    )
  ).rows[0].n;
  assert.equal(active, 0);
  const fresh = await recon.run({ ...f.command, runKey: 'after-correction' });
  assert.equal(fresh.matchedGroups, 0);
  assert.equal(counts(fresh, 'BANK', 'INELIGIBLE'), 1);
});
async function withFault(table: string, operation: () => Promise<void>) {
  const tag = 'phase6_' + randomUUID().replaceAll('-', '');
  await admin.query(
    `CREATE FUNCTION public.${tag}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION USING ERRCODE='P6999',MESSAGE='Synthetic injected failure'; END $$`,
  );
  await admin.query(
    `CREATE TRIGGER ${tag} AFTER INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION public.${tag}()`,
  );
  try {
    await operation();
  } finally {
    await admin.query(`DROP TRIGGER ${tag} ON ${table}`);
    await admin.query(`DROP FUNCTION public.${tag}()`);
  }
}
test('failure in every financial stage rolls back that stage while frozen evidence remains durable and retryable', async () => {
  for (const [table, stage] of [
    ['reconciliation.run_member', 'seal'],
    ['reconciliation.candidate', 'plan'],
    ['reconciliation.outcome_plan', 'plan'],
    ['reconciliation.match_group', 'advance'],
    ['reconciliation.match_group_member', 'advance'],
    ['reconciliation.outcome', 'advance'],
    ['reconciliation.allocation_decision', 'advance'],
    ['reconciliation.current_allocation', 'advance'],
    ['audit.audit_event', 'advance'],
    ['outbox.outbox_event', 'advance'],
    ['outbox.outbox_event', 'complete'],
  ] as const) {
    const f = await setup(),
      id = await recon.create(f.command);
    if (stage !== 'seal') await recon.seal(id);
    if (stage === 'advance' || stage === 'complete') await recon.plan(id);
    if (stage === 'complete') await recon.advance(id);
    const before = await snapshot(id);
    await withFault(table, async () => {
      await assert.rejects(recon[stage](id), { code: 'P6999' });
    });
    assert.equal(await snapshot(id), before);
    assert.equal((await recon.run(f.command)).matchedGroups, 1);
    assert.equal(
      (
        await pp.query(
          'SELECT count(*)::integer n FROM processor.settlement_batch WHERE source_account_id=$1',
          [f.source],
        )
      ).rows[0].n,
      1,
    );
  }
});
test('actual successful COMMIT acknowledgement loss at create/seal/plan/accept/complete safely replays unchanged identity', async () => {
  for (const stage of [
    'create',
    'seal',
    'plan',
    'advance',
    'complete',
  ] as const) {
    const f = await setup(),
      id = stage === 'create' ? null : await recon.create(f.command);
    if (stage === 'plan' || stage === 'advance' || stage === 'complete')
      await recon.seal(id!);
    if (stage === 'advance' || stage === 'complete') await recon.plan(id!);
    if (stage === 'complete') await recon.advance(id!);
    const proxy = await commitDropProxy(ru!),
      pool = new Pool({ connectionString: proxy.url });
    pool.on('error', () => {});
    try {
      const client = new PostgresReconciliation(pool);
      await assert.rejects(
        stage === 'create' ? client.create(f.command) : client[stage](id!),
        UnknownReconciliationCommit,
      );
      await proxy.dropped;
    } finally {
      await pool.end();
      await proxy.close();
    }
    const result = await recon.run(f.command);
    assert.equal(result.matchedGroups, 1);
    assert.equal(result.state, 'COMPLETED');
  }
});
test('backend termination inside match creation rolls back proof/allocation while normalized inputs survive', async () => {
  const f = await setup(),
    id = await recon.create(f.command);
  await recon.seal(id);
  await recon.plan(id);
  const tag = 'phase6_kill_' + randomUUID().replaceAll('-', '');
  await admin.query(
    `CREATE FUNCTION public.${tag}() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN PERFORM pg_terminate_backend(pg_backend_pid()); PERFORM pg_sleep(0.05); RETURN NEW; END $$`,
  );
  await admin.query(
    `CREATE TRIGGER ${tag} BEFORE INSERT ON reconciliation.match_group FOR EACH ROW EXECUTE FUNCTION public.${tag}()`,
  );
  try {
    await assert.rejects(recon.advance(id));
  } finally {
    await admin.query(`DROP TRIGGER ${tag} ON reconciliation.match_group`);
    await admin.query(`DROP FUNCTION public.${tag}()`);
  }
  assert.equal((await recon.summary(id)).state, 'RUNNING');
  assert.equal((await recon.summary(id)).matchedGroups, 0);
  assert.equal((await recon.run(f.command)).matchedGroups, 1);
});
test('runtime privileges and administrator guards reject forged/late/mutable financial history and double allocation', async () => {
  const f = await setup(),
    result = await recon.run(f.command),
    before = await snapshot(result.id);
  for (const table of [
    'run_member',
    'candidate',
    'outcome_plan',
    'outcome',
    'match_group',
    'match_group_member',
    'allocation_decision',
    'item',
    'account_mapping',
    'rule_version',
  ]) {
    await assert.rejects(rp.query(`DELETE FROM reconciliation.${table}`), {
      code: '42501',
    });
    await assert.rejects(admin.query(`DELETE FROM reconciliation.${table}`), {
      code: 'P1003',
    });
    await assert.rejects(
      admin.query(`TRUNCATE reconciliation.${table} CASCADE`),
      { code: 'P1003' },
    );
  }
  await assert.rejects(
    admin.query(
      "UPDATE reconciliation.run SET state='RUNNING',completed_at=NULL WHERE id=$1",
      [result.id],
    ),
    { code: 'P1003' },
  );
  await assert.rejects(rp.query("SELECT ledger.post_journal('{}'::jsonb)"), {
    code: '42501',
  });
  await assert.rejects(
    rp.query(
      "SELECT processor.derive(NULL,'synthetic-movement-v1','processor-v1')",
    ),
    { code: '42501' },
  );
  await assert.rejects(rp.query('SET ROLE flow_ledger_owner'), {
    code: '42501',
  });
  await assert.rejects(
    admin.query(
      'INSERT INTO reconciliation.run_member SELECT * FROM reconciliation.run_member WHERE run_id=$1 LIMIT 1',
      [result.id],
    ),
    { code: 'P6003' },
  );
  await assert.rejects(
    admin.query(
      'INSERT INTO reconciliation.candidate SELECT * FROM reconciliation.candidate WHERE run_id=$1',
      [result.id],
    ),
    { code: 'P6003' },
  );
  await assert.rejects(
    admin.query(
      'INSERT INTO reconciliation.current_allocation SELECT * FROM reconciliation.current_allocation WHERE group_id IN(SELECT id FROM reconciliation.match_group WHERE run_id=$1)',
      [result.id],
    ),
    { code: 'P6003' },
  );
  await assert.rejects(
    admin.query(
      'DELETE FROM reconciliation.current_allocation WHERE group_id IN(SELECT id FROM reconciliation.match_group WHERE run_id=$1)',
      [result.id],
    ),
    { code: 'P6003' },
  );
  assert.equal(await snapshot(result.id), before);
});
test('deferred guards reject partial population and unaudited completion even to administrative SQL', async () => {
  const f = await setup(),
    id = await recon.create(f.command),
    c = await admin.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await c.query('SELECT reconciliation.seal($1)', [id]);
    await c
      .query('DELETE FROM reconciliation.run_member WHERE run_id=$1', [id])
      .then(
        () => assert.fail('must be immutable'),
        (e) => assert.equal(e.code, 'P1003'),
      );
    await c.query('ROLLBACK');
    assert.equal((await recon.summary(id)).state, 'DRAFT');
    await recon.seal(id);
    await recon.plan(id);
    await recon.advance(id);
    await c.query('BEGIN');
    await c.query(
      "UPDATE reconciliation.run SET state='COMPLETED',completed_at=transaction_timestamp() WHERE id=$1",
      [id],
    );
    await assert.rejects(c.query('COMMIT'), { code: 'P6004' });
    await c.query('ROLLBACK');
    assert.equal((await recon.summary(id)).state, 'RUNNING');
    await recon.complete(id);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
});
test('reviewed SQL command boundary executes the same guarded financial proof', async () => {
  const f = await setup(),
    id = await recon.create(f.command);
  await recon.seal(id);
  await recon.plan(id);
  await admin.query('SELECT reconciliation.advance($1::uuid,100)', [id]);
  await admin.query('SELECT reconciliation.complete($1::uuid)', [id]);
  assert.equal((await recon.summary(id)).matchedGroups, 1);
});
test('independent acquisition incompleteness of bank or required processor components blocks proof without inventing completeness', async () => {
  const f = await setup();
  await importEvidence(
    f.ingestion,
    f.bank,
    f.bankSource,
    'synthetic-bank-entry',
    'synthetic-bank-entry-v1',
    [entry()],
    { expectedCount: 2 },
  );
  const r = await recon.run(f.command);
  assert.equal(r.matchedGroups, 0);
  assert.equal(counts(r, 'BANK', 'INELIGIBLE'), 1);
  const g = await setup();
  await importEvidence(
    g.ingestion,
    g.processor,
    g.source,
    'synthetic-movement',
    'synthetic-movement-v1',
    [
      {
        id: 'fee',
        kind: 'fee',
        paymentReference: 'payment',
        parentCaptureId: 'capture',
        amount: money('-30000'),
        occurredAt: '2026-01-01T00:00:01.000Z',
      },
    ],
    { expectedCount: 2 },
  );
  const s = await recon.run(g.command);
  assert.equal(s.matchedGroups, 0);
  assert.equal(counts(s, 'PROCESSOR', 'INELIGIBLE'), 1);
});
async function secondSettlement(
  f: Awaited<ReturnType<typeof setup>>,
  reference = 'transfer',
) {
  await importEvidence(
    f.ingestion,
    f.processor,
    f.source,
    'synthetic-movement',
    'synthetic-movement-v1',
    [
      {
        id: 'other-capture',
        kind: 'capture',
        paymentReference: 'other-payment',
        parentCaptureId: null,
        amount: money('1000000'),
        occurredAt: '2026-01-01T00:02:00.000Z',
      },
      {
        id: 'other-fee',
        kind: 'fee',
        paymentReference: 'other-payment',
        parentCaptureId: 'other-capture',
        amount: money('-30000'),
        occurredAt: '2026-01-01T00:02:01.000Z',
      },
    ],
  );
  await importEvidence(
    f.ingestion,
    f.processor,
    f.source,
    'synthetic-settlement',
    'synthetic-settlement-v1',
    [report('other', '970000', reference, ['other-capture', 'other-fee'])],
  );
}
test('two eligible processor counterparts contend for one bank movement without arbitrary allocation', async () => {
  const f = await setup();
  await secondSettlement(f);
  const id = await recon.create(f.command);
  await recon.seal(id);
  await recon.plan(id);
  await contend(f.book, (r) => r.advance(id));
  await recon.complete(id);
  const summary = await recon.summary(id);
  assert.equal(summary.matchedGroups, 0);
  assert.equal(counts(summary, 'PROCESSOR', 'AMBIGUOUS'), 2);
  assert.equal(counts(summary, 'BANK', 'AMBIGUOUS'), 1);
});
test('valid evidence for one pair cannot allocate a different equal-amount counterpart with its own valid plan', async () => {
  const f = await setup({
    banks: [entry(), entry('other-bank', '970000', 'other-reference')],
  });
  await secondSettlement(f, 'other-reference');
  const id = await recon.create(f.command);
  await recon.seal(id);
  await recon.plan(id);
  const c = await admin.connect();
  try {
    await c.query('BEGIN');
    const group = (
      await c.query(
        `INSERT INTO reconciliation.match_group(run_id,rule_version,currency,signed_amount_minor,evidence)
 SELECT r.id,r.rule_version,p.snapshot->>'currency',(p.snapshot->>'amountMinor')::bigint,c.evidence||jsonb_build_object('ruleVersion',r.rule_version,'mappingId',r.mapping_id,'processorSnapshot',p.snapshot,'bankSnapshot',b.snapshot,'mutualUnique',true,'populationHash',r.manifest->'populationHash')
 FROM reconciliation.run r JOIN reconciliation.candidate c ON c.run_id=r.id JOIN reconciliation.run_member p ON p.run_id=r.id AND p.item_id=c.processor_item_id JOIN reconciliation.run_member b ON b.run_id=r.id AND b.item_id=c.bank_item_id
 WHERE r.id=$1 AND p.processor_batch_id=$2 RETURNING id`,
        [id, f.reports[0]!.id],
      )
    ).rows[0].id;
    await assert.rejects(
      c.query(
        `INSERT INTO reconciliation.match_group_member SELECT $1,run_id,item_id,'BANK_MOVEMENT',(snapshot->>'amountMinor')::bigint,snapshot->>'currency' FROM reconciliation.run_member WHERE run_id=$2 AND side='BANK' AND snapshot->>'reference'='other-reference'`,
        [group, id],
      ),
      { code: 'P6003' },
    );
    await c.query('ROLLBACK');
    assert.equal((await recon.run(f.command)).matchedGroups, 2);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
});
test('SQLSTATE retry reruns the whole unchanged financial stage', async () => {
  for (const code of ['40001', '40P01']) {
    const f = await setup(),
      id = await recon.create(f.command);
    await recon.seal(id);
    await recon.plan(id);
    const name = 'phase6_retry_' + randomUUID().replaceAll('-', '');
    await admin.query(`CREATE SEQUENCE public.${name}`);
    await admin.query(
      `GRANT USAGE ON SEQUENCE public.${name} TO flow_ledger_owner`,
    );
    await admin.query(
      `CREATE FUNCTION public.${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF nextval('public.${name}')=1 THEN RAISE EXCEPTION USING ERRCODE='${code}',MESSAGE='Synthetic retryable fault'; END IF; RETURN NEW; END $$`,
    );
    await admin.query(
      `CREATE TRIGGER ${name} BEFORE INSERT ON reconciliation.match_group FOR EACH ROW EXECUTE FUNCTION public.${name}()`,
    );
    try {
      assert.equal(await recon.advance(id), 2);
      await recon.complete(id);
      assert.equal((await recon.summary(id)).matchedGroups, 1);
    } finally {
      await admin.query(`DROP TRIGGER ${name} ON reconciliation.match_group`);
      await admin.query(`DROP FUNCTION public.${name}()`);
      await admin.query(`DROP SEQUENCE public.${name}`);
    }
  }
});
test('REPEATABLE READ freezing excludes a bank movement committed after snapshot establishment and prevents stale current activation', async () => {
  const f = await setup(),
    id = await recon.create(f.command),
    c = await admin.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await c.query('SELECT 1 FROM reconciliation.run WHERE id=$1', [id]);
    await importEvidence(
      f.ingestion,
      f.bank,
      f.bankSource,
      'synthetic-bank-entry',
      'synthetic-bank-entry-v1',
      [entry('during-freeze')],
    );
    await c.query('SELECT reconciliation.seal($1::uuid)', [id]);
    await c.query('COMMIT');
    assert.equal((await recon.summary(id)).bankPopulation, 1);
    const historical = await recon.run(f.command);
    assert.equal(historical.matchedGroups, 1);
    assert.deepEqual(historical.current, [{ status: 'STALE', count: 1 }]);
    const current = await recon.run({ ...f.command, runKey: 'after-freeze' });
    assert.equal(current.bankPopulation, 2);
    assert.equal(current.matchedGroups, 0);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
});
