import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { Pool } from 'pg';
import fc from 'fast-check';
import { GROUPED_RULE_VERSION } from '@flow/reconciliation-domain';
import {
  PostgresReconciliation,
  UnknownReconciliationCommit,
} from '@flow/reconciliation-postgres';
import {
  fixture,
  importEvidence,
  money,
  entry,
  report,
} from './helpers/reconciliation-fixture';
import { commitDropProxy } from './helpers/commit-proxy';
const au = process.env['FLOW_TEST_ADMIN_URL']!,
  ru = process.env['FLOW_TEST_RECONCILIATION_URL']!,
  iu = process.env['FLOW_TEST_INGESTION_URL']!,
  pu = process.env['FLOW_TEST_PROCESSOR_URL']!,
  bu = process.env['FLOW_TEST_BANK_URL']!;
if (!au || !ru || !iu || !pu || !bu)
  throw new Error('Run pnpm test:integration');
const admin = new Pool({ connectionString: au }),
  rp = new Pool({ connectionString: ru }),
  ip = new Pool({ connectionString: iu }),
  pp = new Pool({ connectionString: pu }),
  bp = new Pool({ connectionString: bu });
const recon = new PostgresReconciliation(rp);
after(async () => {
  await Promise.all([admin.end(), rp.end(), ip.end(), pp.end(), bp.end()]);
});
async function setup(
  options: {
    amounts?: string[];
    banks?: Record<string, unknown>[];
    declarations?: string[][];
    noDeclaration?: boolean;
    currencies?: string[];
  } = {},
) {
  const amounts = options.amounts ?? ['400000', '300000', '270000'],
    ids = amounts.map((_, i) => 's' + i);
  const f = await fixture(admin, ip, pp, bp, { reports: [], banks: [] });
  await importEvidence(
    f.ingestion,
    f.processor,
    f.source,
    'synthetic-movement',
    'synthetic-movement-v1',
    amounts.map((a, i) => ({
      id: 'c' + i,
      kind: 'capture',
      paymentReference: 'p' + i,
      parentCaptureId: null,
      amount: money(a, options.currencies?.[i] ?? 'PHP'),
      occurredAt: '2026-01-01T00:00:00.000Z',
    })),
  );
  const reports = amounts.map((a, i) => ({
    ...report(ids[i]!, a, 'transfer', ['c' + i]),
    gross: money(a, options.currencies?.[i] ?? 'PHP'),
    fees: money('0', options.currencies?.[i] ?? 'PHP'),
    refunds: money('0', options.currencies?.[i] ?? 'PHP'),
    chargebacks: money('0', options.currencies?.[i] ?? 'PHP'),
    net: money(a, options.currencies?.[i] ?? 'PHP'),
    ...(!options.noDeclaration
      ? { payoutMemberIds: options.declarations?.[i] ?? ids }
      : {}),
  }));
  const batch = await f.ingestion.ingest({
    sourceAccountId: f.source,
    batchKey: 'groups',
    actorId: 'group-fixture',
    provenance: { adapterVersion: 'explicit-transfer-source-v1' },
    records: reports.map((body, i) => ({
      locator: String(i),
      objectKind: 'synthetic-settlement',
      externalId: body.id,
      sourceRevision: null,
      sequence: null,
      sourceObservedAt: null,
      bytes: Buffer.from(JSON.stringify(body)),
    })),
  });
  await f.ingestion.requestNormalization(
    batch.id,
    'synthetic-settlement-v1',
    'test',
  );
  await f.ingestion.normalizeBatch(batch.id, 'synthetic-settlement-v1');
  await f.processor.deriveBatch(batch.id, 'synthetic-settlement-v1');
  if (!options.noDeclaration) {
    await f.ingestion.requestNormalization(
      batch.id,
      'synthetic-settlement-group-v1',
      'test',
    );
    await f.ingestion.normalizeBatch(batch.id, 'synthetic-settlement-group-v1');
  }
  await importEvidence(
    f.ingestion,
    f.bank,
    f.bankSource,
    'synthetic-bank-entry',
    'synthetic-bank-entry-v1',
    options.banks ?? [
      entry('bank', amounts.reduce((a, b) => a + BigInt(b), 0n).toString()),
    ],
  );
  return {
    ...f,
    ids,
    reports,
    batch,
    command: {
      ...f.command,
      ruleVersion: GROUPED_RULE_VERSION as typeof GROUPED_RULE_VERSION,
    },
  };
}
const count = (
  r: Awaited<ReturnType<PostgresReconciliation['run']>>,
  side: string,
  outcome: string,
) =>
  r.outcomes.find((x) => x.side === side && x.outcome === outcome)?.count ?? 0;
const history = async (id: string) =>
  JSON.stringify(
    (
      await admin.query(
        'SELECT to_jsonb(g) AS row FROM reconciliation.match_group g WHERE run_id=$1 UNION ALL SELECT to_jsonb(m) FROM reconciliation.match_group_member m WHERE run_id=$1 UNION ALL SELECT to_jsonb(o) FROM reconciliation.outcome o WHERE run_id=$1 ORDER BY row',
        [id],
      )
    ).rows,
  );
test('declared 4000+3000+2700 proves one bank, exact member evidence, coverage, audit and allocations; replay is stable', async () => {
  const f = await setup(),
    r = await recon.run(f.command);
  assert.equal(r.grouped?.matchedGroups, 1);
  assert.equal(count(r, 'PROCESSOR', 'MATCHED'), 3);
  assert.equal(count(r, 'BANK', 'MATCHED'), 1);
  assert.deepEqual(r.current, [{ status: 'ACTIVE', count: 1 }]);
  const g = (
    await rp.query('SELECT * FROM reconciliation.match_group WHERE run_id=$1', [
      r.id,
    ])
  ).rows[0];
  assert.equal(g.shape, 'N:1');
  assert.equal(g.signed_amount_minor, '970000');
  assert.equal(g.evidence.processorSnapshots.length, 3);
  assert.ok(
    g.evidence.processorSnapshots.every(
      (p: { groupVariants: unknown[] }) => p.groupVariants.length === 1,
    ),
  );
  assert.equal(
    (
      await rp.query(
        'SELECT count(*)::int n FROM reconciliation.current_allocation WHERE group_id=$1',
        [g.id],
      )
    ).rows[0].n,
    4,
  );
  const before = await history(r.id);
  assert.deepEqual(await recon.run(f.command), r);
  assert.equal(await history(r.id), before);
  const next = await recon.run({ ...f.command, runKey: 'next' });
  assert.equal(next.grouped?.matchedGroups, 1);
  assert.equal(await history(r.id), before);
  assert.deepEqual((await recon.summary(r.id)).current, [
    { status: 'SUPERSEDED', count: 1 },
  ]);
  assert.equal(
    (
      await admin.query(
        'SELECT policy_version FROM audit.audit_event WHERE reconciliation_decision_id IN(SELECT id FROM reconciliation.allocation_decision WHERE group_id=$1) ORDER BY created_at',
        [g.id],
      )
    ).rows[0].policy_version,
    GROUPED_RULE_VERSION,
  );
});
test('sum alone, one-unit difference, missing declared member, contradictory currency, bad control and limit refuse; duplicate values retain identities', async () => {
  for (const options of [
    { noDeclaration: true },
    { banks: [entry('bank', '969999')] },
    {
      declarations: [
        ['s0', 's1', 'missing'],
        ['s0', 's1', 'missing'],
        ['s0', 's1', 'missing'],
      ],
    },
    { currencies: ['PHP', 'USD', 'PHP'] },
    { amounts: Array.from({ length: 33 }, () => '1') },
  ]) {
    const f = await setup(options),
      r = await recon.run(f.command);
    assert.equal(r.matchedGroups, 0);
    if ('amounts' in options) assert.ok(r.grouped!.refusedLimitCount > 0);
  }
  const equal = await setup({ amounts: ['1000', '1000'] }),
    r = await recon.run(equal.command);
  assert.equal(r.grouped?.processorMembers, 2);
});
test('two explicit whole groups with identical total and duplicate bank candidates refuse ambiguity without subset enumeration', async () => {
  const f = await setup({
      amounts: ['4000', '6000', '3000', '7000'],
      declarations: [
        ['s0', 's1'],
        ['s0', 's1'],
        ['s2', 's3'],
        ['s2', 's3'],
      ],
      banks: [entry('bank', '10000')],
    }),
    r = await recon.run(f.command);
  assert.equal(r.matchedGroups, 0);
  assert.equal(count(r, 'BANK', 'AMBIGUOUS'), 1);
  assert.equal(count(r, 'PROCESSOR', 'AMBIGUOUS'), 4);
  const copies = await setup({ banks: [entry(), entry('copy')] }),
    cr = await recon.run(copies.command);
  assert.equal(cr.matchedGroups, 0);
  assert.equal(count(cr, 'BANK', 'AMBIGUOUS'), 2);
});
test('group correction and late contradictory bank preserve historical members, invalidate current proof, and new runs retain ambiguous revisions', async () => {
  const f = await setup(),
    r = await recon.run(f.command),
    before = await history(r.id);
  await importEvidence(
    f.ingestion,
    f.processor,
    f.source,
    'synthetic-settlement',
    'synthetic-settlement-v1',
    [{ ...f.reports[0], net: money('399999') }],
  );
  assert.deepEqual((await recon.summary(r.id)).current, [
    { status: 'INVALIDATED', count: 1 },
  ]);
  const next = await recon.run({ ...f.command, runKey: 'corrected' });
  assert.equal(next.matchedGroups, 0);
  assert.ok(count(next, 'PROCESSOR', 'INELIGIBLE') >= 1);
  assert.equal(await history(r.id), before);
});
test('frozen group population refuses current activation when a second bank arrives after plan; all historical outcomes still complete', async () => {
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
    [entry('late')],
  );
  while (await recon.advance(id, 1)) {}
  await recon.complete(id);
  const r = await recon.summary(id);
  assert.equal(r.grouped?.matchedGroups, 1);
  assert.deepEqual(r.current, [{ status: 'STALE', count: 1 }]);
  const next = await recon.run({ ...f.command, runKey: 'later' });
  assert.equal(next.matchedGroups, 0);
  assert.equal(count(next, 'BANK', 'AMBIGUOUS'), 2);
});
async function contend(
  book: string,
  work: (r: PostgresReconciliation, i: number) => Promise<unknown>,
) {
  const blocker = await admin.connect(),
    name = 'group-race-' + randomUUID(),
    pool = new Pool({ connectionString: ru, max: 8, application_name: name });
  let workers: Promise<PromiseSettledResult<unknown>[]> | undefined;
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT FROM ledger.book WHERE id=$1 FOR UPDATE', [
      book,
    ]);
    workers = Promise.allSettled(
      Array.from({ length: 8 }, (_, i) =>
        work(new PostgresReconciliation(pool), i),
      ),
    );
    const deadline = Date.now() + 8000;
    let n = 0;
    while (Date.now() < deadline) {
      n = (
        await admin.query(
          "SELECT count(*)::int n FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'",
          [name],
        )
      ).rows[0].n;
      if (n === 8) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(n, 8);
    await blocker.query('COMMIT');
    for (const r of await workers)
      assert.equal(
        r.status,
        'fulfilled',
        r.status === 'rejected' ? String(r.reason) : '',
      );
  } finally {
    await blocker.query('ROLLBACK');
    blocker.release();
    await workers;
    await pool.end();
  }
}
test('same-group workers and overlapping new runs under eight observed lock waits create one allocation set; 1:1 vs N:1 attempts cannot double consume', async () => {
  const f = await setup();
  await contend(f.book, (r) => r.run(f.command));
  const first = await recon.run(f.command);
  assert.equal(first.matchedGroups, 1);
  await contend(f.book, (r, i) =>
    r.run({
      ...f.command,
      runKey: 'race-' + i,
      ruleVersion: i % 2 ? GROUPED_RULE_VERSION : 'settlement-bank-exact-v1',
    }),
  );
  const groups = (
    await rp.query(
      'SELECT g.shape,count(*)::int n FROM reconciliation.current_allocation a JOIN reconciliation.match_group g ON g.id=a.group_id JOIN reconciliation.run r ON r.id=g.run_id WHERE r.mapping_id=$1 GROUP BY g.shape',
      [f.mappingId],
    )
  ).rows;
  assert.deepEqual(groups, [{ shape: 'N:1', n: 4 }]);
  const ambiguous = await setup({ banks: [entry(), entry('second')] });
  await contend(ambiguous.book, (r, i) =>
    r.run({ ...ambiguous.command, runKey: 'ambiguous-' + i }),
  );
  assert.equal(
    (
      await rp.query(
        'SELECT count(*)::int n FROM reconciliation.current_allocation a JOIN reconciliation.match_group g ON g.id=a.group_id JOIN reconciliation.run r ON r.id=g.run_id WHERE r.mapping_id=$1',
        [ambiguous.mappingId],
      )
    ).rows[0].n,
    0,
  );
});
test('partial member/candidate/audit/outbox failures roll back each stage, normalized evidence survives, and unchanged retry completes', async () => {
  for (const table of [
    'reconciliation.group_candidate',
    'reconciliation.match_group_member',
    'reconciliation.allocation_decision',
    'reconciliation.current_allocation',
    'audit.audit_event',
    'outbox.outbox_event',
  ]) {
    const f = await setup(),
      id = await recon.create(f.command);
    await recon.seal(id);
    if (table !== 'reconciliation.group_candidate') await recon.plan(id);
    const tag = 'fail_group_' + randomUUID().replaceAll('-', '');
    await admin.query(
      `CREATE FUNCTION public.${tag}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION USING ERRCODE='P6999',MESSAGE='Synthetic grouped failure'; END $$`,
    );
    await admin.query(
      `CREATE TRIGGER ${tag} AFTER INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION public.${tag}()`,
    );
    try {
      await assert.rejects(
        table === 'reconciliation.group_candidate'
          ? recon.plan(id)
          : recon.advance(id),
      );
    } finally {
      await admin.query(`DROP TRIGGER ${tag} ON ${table}`);
      await admin.query(`DROP FUNCTION public.${tag}()`);
    }
    assert.equal((await recon.summary(id)).matchedGroups, 0);
    const r = await recon.run(f.command);
    assert.equal(r.grouped?.matchedGroups, 1);
  }
});
test('actual lost grouped acceptance COMMIT acknowledgement replays one group, allocations, audit and intent', async () => {
  const f = await setup(),
    id = await recon.create(f.command);
  await recon.seal(id);
  await recon.plan(id);
  const proxy = await commitDropProxy(ru),
    pool = new Pool({ connectionString: proxy.url });
  pool.on('error', () => {});
  try {
    await assert.rejects(
      new PostgresReconciliation(pool).advance(id),
      UnknownReconciliationCommit,
    );
    await proxy.dropped;
  } finally {
    await pool.end();
    await proxy.close();
  }
  const r = await recon.run(f.command);
  assert.equal(r.grouped?.matchedGroups, 1);
  assert.equal(
    (
      await rp.query(
        'SELECT count(*)::int n FROM reconciliation.current_allocation WHERE group_id IN(SELECT id FROM reconciliation.match_group WHERE run_id=$1)',
        [id],
      )
    ).rows[0].n,
    4,
  );
});
test('20 real PostgreSQL group conservation, permutation/retry, no reuse and immutable new-run history property trials', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.integer({ min: 1, max: 100000 }), {
        minLength: 2,
        maxLength: 5,
      }),
      async (values) => {
        const f = await setup({ amounts: values.map(String) }),
          r = await recon.run(f.command),
          before = await history(r.id);
        assert.equal(r.grouped?.matchedGroups, 1);
        assert.equal(
          r.grouped!.values[0]!.amountMinor,
          values.reduce((a, b) => a + BigInt(b), 0n).toString(),
        );
        assert.deepEqual(await recon.run(f.command), r);
        await recon.run({ ...f.command, runKey: 'new' });
        assert.equal(await history(r.id), before);
        assert.equal(
          (
            await rp.query(
              'SELECT count(*)::int n FROM reconciliation.current_allocation a JOIN reconciliation.match_group g ON g.id=a.group_id JOIN reconciliation.run r ON r.id=g.run_id WHERE r.mapping_id=$1',
              [f.mappingId],
            )
          ).rows[0].n,
          values.length + 1,
        );
      },
    ),
    { numRuns: 20, seed: 70703 },
  );
});
test('oversized search refuses before sealing without truncating source evidence or claiming completion', async () => {
  const ids = Array.from({ length: 40 }, (_, i) => 's' + i),
    decl = ids.map((id, i) => ids.filter((_, j) => i !== j));
  // Every declaration is distinct; 40 declarations fit, but their exact bank fanout exceeds 4096.
  const f = await setup({
    amounts: Array.from({ length: 40 }, () => '1'),
    declarations: decl,
    banks: Array.from({ length: 110 }, (_, i) => entry('b' + i, '39')),
  });
  const id = await recon.create(f.command);
  await assert.rejects(recon.seal(id));
  assert.equal((await recon.summary(id)).state, 'DRAFT');
  assert.equal(
    (
      await rp.query(
        'SELECT count(*)::int n FROM reconciliation.run_member WHERE run_id=$1',
        [id],
      )
    ).rows[0].n,
    0,
  );
});
test('invalid supplemental declaration is explicitly ineligible for grouped rules while the Phase 6 rule remains unchanged', async () => {
  const f = await setup({
    amounts: ['1000', '1000'],
    declarations: [[], []],
    banks: [entry('bank', '1000')],
  });
  const r = await recon.run(f.command);
  assert.equal(r.matchedGroups, 0);
  assert.equal(count(r, 'PROCESSOR', 'INELIGIBLE'), 2);
  const old = await recon.run({
    ...f.command,
    runKey: 'phase6',
    ruleVersion: 'settlement-bank-exact-v1',
  });
  assert.equal(count(old, 'PROCESSOR', 'AMBIGUOUS'), 2);
});
test('grouped bank statement and processor intrinsic failures retain ineligible outcomes without acceptance', async () => {
  const f = await setup({
    banks: [
      entry('bank', '970000', 'transfer', {
        statementReference: 'missing-statement',
        lineIdentity: 'line',
      }),
    ],
  });
  const r = await recon.run(f.command);
  assert.equal(r.matchedGroups, 0);
  assert.equal(count(r, 'BANK', 'INELIGIBLE'), 1);
  const p = await setup();
  await importEvidence(
    p.ingestion,
    p.processor,
    p.source,
    'synthetic-movement',
    'synthetic-movement-v1',
    [
      {
        id: 'c0',
        kind: 'capture',
        paymentReference: 'p0',
        parentCaptureId: null,
        amount: money('399999'),
        occurredAt: '2026-01-01T00:00:00.000Z',
      },
    ],
  );
  const pr = await recon.run(p.command);
  assert.equal(pr.matchedGroups, 0);
  assert.ok(count(pr, 'PROCESSOR', 'INELIGIBLE') > 0);
});
test('database rejects forged/partial/unbalanced groups, immutable candidates and double-use writes', async () => {
  const f = await setup(),
    id = await recon.create(f.command);
  await recon.seal(id);
  await recon.plan(id);
  const client = await admin.connect();
  try {
    await client.query('BEGIN');
    const gid = (
      await client.query(
        `INSERT INTO reconciliation.match_group(run_id,rule_version,shape,currency,signed_amount_minor,evidence)
   SELECT r.id,r.rule_version,'N:1',c.evidence->>'currency',(c.evidence->>'signedAmountMinor')::bigint,c.evidence||jsonb_build_object('ruleVersion',r.rule_version,'mappingId',r.mapping_id,'mutualUnique',true,'populationHash',r.manifest->'populationHash') FROM reconciliation.group_candidate c JOIN reconciliation.run r ON r.id=c.run_id WHERE r.id=$1 RETURNING id`,
        [id],
      )
    ).rows[0].id;
    await client.query(
      `INSERT INTO reconciliation.match_group_member SELECT $1,run_id,item_id,CASE WHEN side='PROCESSOR' THEN 'PROCESSOR_SETTLEMENT' ELSE 'BANK_MOVEMENT' END,(snapshot->>'amountMinor')::bigint,snapshot->>'currency' FROM reconciliation.run_member WHERE run_id=$2 AND side='PROCESSOR' LIMIT 2`,
      [gid, id],
    );
    await assert.rejects(client.query('COMMIT'));
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
  assert.equal((await recon.summary(id)).matchedGroups, 0);
  const r = await recon.run(f.command),
    g = (
      await rp.query(
        'SELECT id FROM reconciliation.match_group WHERE run_id=$1',
        [r.id],
      )
    ).rows[0].id;
  for (const sql of [
    'UPDATE reconciliation.group_candidate SET evidence=evidence',
    'DELETE FROM reconciliation.group_candidate',
    'TRUNCATE reconciliation.group_candidate',
  ])
    await assert.rejects(admin.query(sql));
  await assert.rejects(
    rp.query(
      'INSERT INTO reconciliation.current_allocation SELECT * FROM reconciliation.current_allocation WHERE group_id=$1',
      [g],
    ),
  );
  await assert.rejects(
    admin.query(
      'INSERT INTO reconciliation.current_allocation SELECT * FROM reconciliation.current_allocation WHERE group_id=$1',
      [g],
    ),
  );
  await assert.rejects(
    admin.query(
      'UPDATE reconciliation.match_group_member SET signed_amount_minor=signed_amount_minor+1 WHERE group_id=$1',
      [g],
    ),
  );
});
test('overlapping declared groups sharing one processor under observed contention remain ambiguous and never allocate', async () => {
  const f = await setup({
    amounts: ['1000', '1000', '2000'],
    declarations: [
      ['s0', 's2'],
      ['s1', 's2'],
      ['s0', 's2'],
    ],
    banks: [entry('bank', '3000')],
  });
  await contend(f.book, (r, i) =>
    r.run({ ...f.command, runKey: 'overlap-' + i }),
  );
  const r = await recon.run(f.command);
  assert.equal(r.matchedGroups, 0);
  assert.equal(count(r, 'PROCESSOR', 'AMBIGUOUS'), 3);
});
test('actual backend death after a grouped member insert rolls back the whole acceptance and recovers unchanged identity', async () => {
  const f = await setup(),
    id = await recon.create(f.command);
  await recon.seal(id);
  await recon.plan(id);
  const tag = 'kill_group_' + randomUUID().replaceAll('-', '');
  await admin.query(
    `CREATE FUNCTION public.${tag}() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN PERFORM pg_terminate_backend(pg_backend_pid()); PERFORM pg_sleep(0.05); RETURN NEW; END $$`,
  );
  await admin.query(
    `CREATE TRIGGER ${tag} AFTER INSERT ON reconciliation.match_group_member FOR EACH ROW EXECUTE FUNCTION public.${tag}()`,
  );
  try {
    await assert.rejects(recon.advance(id));
  } finally {
    await admin.query(
      `DROP TRIGGER ${tag} ON reconciliation.match_group_member`,
    );
    await admin.query(`DROP FUNCTION public.${tag}()`);
  }
  assert.equal((await recon.summary(id)).matchedGroups, 0);
  assert.equal((await recon.run(f.command)).grouped?.matchedGroups, 1);
});
test('persisted grouped direction and timing checks describe independent failed predicates precisely', async () => {
  for (const [body, direction, timing] of [
    [
      entry('bank', '970000', 'transfer', {
        bookedAt: '2026-01-08T00:00:00.000Z',
      }),
      true,
      false,
    ],
    [entry('bank', '-970000'), false, true],
  ] as const) {
    const f = await setup({ banks: [body] }),
      r = await recon.run(f.command);
    assert.equal(r.matchedGroups, 0);
    const e = (
      await rp.query(
        'SELECT evidence FROM reconciliation.group_candidate WHERE run_id=$1',
        [r.id],
      )
    ).rows[0].evidence;
    assert.equal(e.directionCompatible, direction);
    assert.equal(e.bookingWindowValid, timing);
  }
});
