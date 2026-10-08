import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { Pool } from 'pg';
import fc from 'fast-check';
import {
  PostgresExceptions,
  UnknownExceptionCommit,
} from '@flow/exception-postgres';
import { type CaseCommand, type CaseView } from '@flow/exception-domain';
import { PostgresReconciliation } from '@flow/reconciliation-postgres';
import {
  fixture,
  installInvariantSweeps,
  entry,
  report,
  importEvidence,
  money,
} from './helpers/reconciliation-fixture';
import { commitDropProxy } from './helpers/commit-proxy';
installInvariantSweeps();
const au = process.env['FLOW_TEST_ADMIN_URL']!,
  eu = process.env['FLOW_TEST_EXCEPTION_URL']!;
if (!au || !eu) throw new Error('Run pnpm test:integration');
const admin = new Pool({ connectionString: au }),
  ep = new Pool({ connectionString: eu }),
  rp = new Pool({
    connectionString: process.env['FLOW_TEST_RECONCILIATION_URL'],
  }),
  ip = new Pool({ connectionString: process.env['FLOW_TEST_INGESTION_URL'] }),
  pp = new Pool({ connectionString: process.env['FLOW_TEST_PROCESSOR_URL'] }),
  bp = new Pool({ connectionString: process.env['FLOW_TEST_BANK_URL'] });
const exceptions = new PostgresExceptions(ep),
  recon = new PostgresReconciliation(rp);
after(async () => {
  await Promise.all([admin, ep, rp, ip, pp, bp].map((p) => p.end()));
});
const cmd = (
  view: CaseView,
  action: CaseCommand['action'],
  extras: Partial<CaseCommand> = {},
): CaseCommand => ({
  caseId: view.id,
  commandKey: randomUUID(),
  expectedVersion: view.version,
  actorId: 'synthetic-reviewer',
  reason: 'Documented synthetic operational decision',
  action,
  ...extras,
});
async function setup(options: Parameters<typeof fixture>[4] = { banks: [] }) {
  const f = await fixture(admin, ip, pp, bp, options),
    run = await recon.run(f.command),
    ids = await exceptions.generate(run.id, 'case-generator');
  return {
    ...f,
    run,
    ids,
    views: await Promise.all(ids.map((id) => exceptions.get(id))),
  };
}
test('missing movement creates one immutable case across outcome/run retries, with exact exposure', async () => {
  const f = await setup();
  assert.equal(f.ids.length, 1);
  const c = f.views[0]!;
  assert.equal(c.state, 'OPEN');
  assert.equal(c.classification, 'MISSING_BANK_MOVEMENT');
  assert.equal(c.exposure?.amountMinor, '970000');
  assert.equal(c.currentlyReconciled, false);
  assert.deepEqual(
    await exceptions.generate(f.run.id, 'different-system-actor'),
    f.ids,
  );
  const later = await recon.run({ ...f.command, runKey: 'same-evidence' });
  assert.deepEqual(await exceptions.generate(later.id, 'system'), f.ids);
  const history = (
    await admin.query('SELECT * FROM exceptions.occurrence WHERE case_id=$1', [
      c.id,
    ])
  ).rows;
  assert.equal(history.length, 2);
  assert.deepEqual(history[0].condition, history[1].condition);
  assert.equal((await exceptions.get(c.id)).state, 'OPEN');
});
test('accepted risk resolves operations while reconciliation remains UNMATCHED and value unreconciled', async () => {
  const f = await setup();
  let c = await exceptions.apply(cmd(f.views[0]!, 'START_REVIEW'));
  c = await exceptions.apply(cmd(c, 'ASSIGN', { assigneeId: 'operator-2' }));
  c = await exceptions.apply(
    cmd(c, 'CLASSIFY', { classification: 'TIMING_LATE_ARRIVAL' }),
  );
  c = await exceptions.apply(
    cmd(c, 'NOTE', {
      note: 'Synthetic source evidence reviewed; no credentials or personal data.',
    }),
  );
  c = await exceptions.apply(cmd(c, 'AWAIT_EVIDENCE'));
  c = await exceptions.apply(cmd(c, 'RESUME_REVIEW'));
  const resolve = cmd(c, 'RESOLVE', { resolution: 'ACCEPTED_RISK' });
  c = await exceptions.apply(resolve);
  assert.equal(c.state, 'RESOLVED');
  assert.equal(c.currentlyReconciled, false);
  assert.deepEqual(await exceptions.apply(resolve), c);
  await assert.rejects(
    exceptions.apply({ ...resolve, reason: 'conflicting meaning' }),
    { code: 'P8001' },
  );
  const summary = await exceptions.summary(f.mappingId);
  assert.equal(summary.exposure[0]!.acceptedRiskMinor, '970000');
  assert.equal(summary.exposure[0]!.amountMinor, '970000');
  assert.equal(summary.manualReconciliationTotal, 0);
  assert.equal((await recon.summary(f.run.id)).matchedGroups, 0);
  const counts = (
    await admin.query(
      'SELECT count(*)::integer AS n,count(DISTINCT exception_event_id)::integer AS events FROM audit.audit_event WHERE exception_event_id IN(SELECT id FROM exceptions.event WHERE case_id=$1)',
      [c.id],
    )
  ).rows[0];
  assert.equal(counts.n, c.version);
  assert.equal(counts.events, c.version);
  await assert.rejects(exceptions.apply(cmd(c, 'START_REVIEW')));
});
test('extra movement, mismatch, ambiguity, and ineligible source controls receive distinct classifications/exposures', async () => {
  const scenarios: [Parameters<typeof fixture>[4], string, string | null][] = [
    [{ reports: [], banks: [entry()] }, 'EXTRA_BANK_MOVEMENT', '970000'],
    [{ banks: [entry('bank', '969999')] }, 'AMOUNT_MISMATCH', '1'],
    [{ banks: [entry('b1'), entry('b2')] }, 'AMBIGUOUS_MATCH', null],
    [
      { reports: [report('settlement', '970001')] },
      'PROCESSOR_INCONSISTENCY',
      null,
    ],
    [{ banks: [entry(null)] }, 'UNSUPPORTED_CASE', null],
    [
      {
        banks: [
          entry('b', '970000', 'transfer', {
            statementReference: 'missing',
            lineIdentity: 'l',
          }),
        ],
      },
      'BANK_INCONSISTENCY',
      null,
    ],
  ];
  for (const [options, classification, exposure] of scenarios) {
    const f = await setup(options);
    const c = f.views.find((c) => c.classification === classification);
    assert(c, classification + ': ' + JSON.stringify(f.views));
    assert.equal(c.exposure?.amountMinor ?? null, exposure);
  }
});
test('late bank arrival produces fresh allocation; explicit verified resolution preserves original history', async () => {
  const f = await setup();
  let c = await exceptions.apply(cmd(f.views[0]!, 'START_REVIEW'));
  await assert.rejects(
    exceptions.apply(
      cmd(c, 'RESOLVE', {
        resolution: 'FIXED_AND_VERIFIED',
        evidenceRunId: f.run.id,
      }),
    ),
    { code: 'P8002' },
  );
  const original = (
    await admin.query(
      'SELECT to_jsonb(o) AS row FROM reconciliation.outcome o WHERE run_id=$1',
      [f.run.id],
    )
  ).rows;
  await importEvidence(
    f.ingestion,
    f.bank,
    f.bankSource,
    'synthetic-bank-entry',
    'synthetic-bank-entry-v1',
    [entry()],
  );
  const later = await recon.run({ ...f.command, runKey: 'late-bank' });
  assert.equal(later.matchedGroups, 1);
  c = await exceptions.apply(
    cmd(c, 'RESOLVE', {
      resolution: 'FIXED_AND_VERIFIED',
      evidenceRunId: later.id,
    }),
  );
  assert.equal(c.state, 'RESOLVED');
  assert.equal(c.currentlyReconciled, true);
  assert.equal(c.evidenceRunId, later.id);
  assert.equal(
    (await exceptions.summary(f.mappingId)).exposure[0]!.amountMinor,
    '0',
  );
  assert.deepEqual(
    (
      await admin.query(
        'SELECT to_jsonb(o) AS row FROM reconciliation.outcome o WHERE run_id=$1',
        [f.run.id],
      )
    ).rows,
    original,
  );
  await importEvidence(
    f.ingestion,
    f.bank,
    f.bankSource,
    'synthetic-bank-entry',
    'synthetic-bank-entry-v1',
    [entry('bank', '970001')],
  );
  assert.equal((await exceptions.get(c.id)).currentlyReconciled, false);
  const corrected = await recon.run({ ...f.command, runKey: 'correction' });
  await exceptions.generate(corrected.id, 'system');
  c = await exceptions.get(c.id);
  assert.equal(c.state, 'UNDER_REVIEW');
  assert.equal(c.resolution, null);
  const oldResolution = (
    await admin.query(
      "SELECT resolution,evidence_run_id FROM exceptions.event WHERE case_id=$1 AND action='RESOLVE'",
      [c.id],
    )
  ).rows[0];
  assert.equal(oldResolution.resolution, 'FIXED_AND_VERIFIED');
  assert.equal(oldResolution.evidence_run_id, later.id);
  await exceptions.generate(corrected.id, 'system');
  assert.equal((await exceptions.get(c.id)).version, c.version);
});
test('source correction reopens accepted risk; old evidence/notes/resolution remain immutable', async () => {
  const f = await setup();
  let c = await exceptions.apply(cmd(f.views[0]!, 'START_REVIEW'));
  c = await exceptions.apply(
    cmd(c, 'RESOLVE', { resolution: 'ACCEPTED_RISK' }),
  );
  await importEvidence(
    f.ingestion,
    f.processor,
    f.source,
    'synthetic-settlement',
    'synthetic-settlement-v1',
    [report('settlement', '970001')],
  );
  const later = await recon.run({ ...f.command, runKey: 'corrected' });
  await exceptions.generate(later.id, 'system');
  const next = await exceptions.get(c.id);
  assert.equal(next.state, 'UNDER_REVIEW');
  assert.equal(next.classification, 'SOURCE_REVISION_AMBIGUITY');
  assert.equal(next.exposure, null);
  assert.equal((await exceptions.summary(f.mappingId)).reopenedTotal, 1);
  assert.equal(
    (
      await admin.query(
        'SELECT count(*)::integer AS n FROM exceptions.case_record WHERE mapping_id=$1',
        [f.mappingId],
      )
    ).rows[0].n,
    1,
  );
});
test('invalidated matched proof creates operational review, never changes allocations', async () => {
  const f = await setup({});
  assert.equal(f.ids.length, 0);
  await importEvidence(
    f.ingestion,
    f.bank,
    f.bankSource,
    'synthetic-bank-entry',
    'synthetic-bank-entry-v1',
    [entry('bank', '970001')],
  );
  const ids = await exceptions.generate(f.run.id, 'system');
  assert.equal(ids.length, 2);
  for (const id of ids) {
    const c = await exceptions.get(id);
    assert.equal(c.classification, 'CURRENT_PROOF_INVALIDATED');
    assert.equal(c.exposure, null);
    assert.equal(c.currentlyReconciled, false);
  }
  assert.equal((await recon.summary(f.run.id)).matchedGroups, 1);
});
test('typed evidence attachments preserve scoped lineage and reject foreign evidence', async () => {
  const f = await setup();
  let c = f.views[0]!;
  for (const attachment of [
    { kind: 'PROCESSOR_SETTLEMENT' as const, id: f.reports[0]!.id },
    { kind: 'RECONCILIATION_RUN' as const, id: f.run.id },
  ])
    c = await exceptions.apply(cmd(c, 'ATTACH', { attachment }));
  const foreign = await setup();
  await assert.rejects(
    exceptions.apply(
      cmd(c, 'ATTACH', {
        attachment: {
          kind: 'PROCESSOR_SETTLEMENT',
          id: foreign.reports[0]!.id,
        },
      }),
    ),
    { code: 'P8003' },
  );
  for (const table of ['case_record', 'event', 'occurrence', 'attachment']) {
    await assert.rejects(admin.query(`DELETE FROM exceptions.${table}`), {
      code: 'P1003',
    });
    await assert.rejects(admin.query(`TRUNCATE exceptions.${table}`));
  }
  await assert.rejects(
    ep.query(
      'INSERT INTO exceptions.case_record(mapping_id,item_id,original_run_id) VALUES($1,$2,$3)',
      [f.mappingId, c.itemId, f.run.id],
    ),
    { code: '42501' },
  );
  await assert.rejects(ep.query("SELECT ledger.post_journal('{}')"), {
    code: '42501',
  });
});
/** Each contender must be observed waiting on PostgreSQL before release. */
async function contend<T>(
  book: string,
  n: number,
  operation: (service: PostgresExceptions, i: number) => Promise<T>,
) {
  const label = 'exceptions-contention-' + randomUUID();
  const pool = new Pool({
    connectionString: eu,
    max: n,
    application_name: label,
  });
  const service = new PostgresExceptions(pool),
    holder = await admin.connect();
  const tasks: Promise<PromiseSettledResult<T>[]>[] = [];
  try {
    await holder.query('BEGIN');
    await holder.query(
      'SELECT FROM ledger.book WHERE id=$1 FOR NO KEY UPDATE',
      [book],
    );
    const settled = Promise.allSettled(
      Array.from({ length: n }, (_, i) => operation(service, i)),
    );
    tasks.push(settled);
    let waits = 0;
    const deadline = Date.now() + 7000;
    while (Date.now() < deadline) {
      waits = (
        await admin.query(
          "SELECT count(*)::integer AS n FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'",
          [label],
        )
      ).rows[0].n;
      if (waits === n) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(waits, n, 'all contenders actually blocked on DB locks');
    await holder.query('COMMIT');
    return await settled;
  } finally {
    await holder.query('ROLLBACK');
    holder.release();
    await Promise.all(tasks);
    await pool.end();
  }
}
test('eight blocked creators converge on one logical case/audit/intent', async () => {
  const f = await fixture(admin, ip, pp, bp, { banks: [] }),
    run = await recon.run(f.command);
  const results = await contend(f.book, 8, (s) =>
    s.generate(run.id, 'generator'),
  );
  assert(results.every((r) => r.status === 'fulfilled'));
  const ids = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  assert.equal(new Set(ids).size, 1);
  const c = await exceptions.get(ids[0]!);
  assert.equal(c.version, 1);
});
test('two reviewers, review-vs-resolve and assignment races reject stale/impossible transitions', async () => {
  const f = await setup(),
    c = f.views[0]!;
  const reviewers = await contend(f.book, 2, (s) =>
    s.apply(cmd(c, 'START_REVIEW')),
  );
  assert.equal(reviewers.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(
    reviewers.filter(
      (r) => r.status === 'rejected' && r.reason.code === 'P8005',
    ).length,
    1,
  );
  const reviewed = await exceptions.get(c.id);
  const assignments = await contend(f.book, 2, (s, i) =>
    s.apply(cmd(reviewed, 'ASSIGN', { assigneeId: 'operator-' + i })),
  );
  assert.equal(assignments.filter((r) => r.status === 'fulfilled').length, 1);
  const open = await setup();
  const race = await contend(open.book, 2, (s, i) =>
    s.apply(
      cmd(
        open.views[0]!,
        i === 0 ? 'START_REVIEW' : 'RESOLVE',
        i === 0 ? {} : { resolution: 'NOT_RECONCILED' },
      ),
    ),
  );
  assert.equal(race.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal((await exceptions.get(open.ids[0]!)).state, 'UNDER_REVIEW');
});
test('resolution versus new-condition generation preserves an explicit history under contention', async () => {
  const f = await setup();
  const reviewed = await exceptions.apply(cmd(f.views[0]!, 'START_REVIEW'));
  await importEvidence(
    f.ingestion,
    f.processor,
    f.source,
    'synthetic-settlement',
    'synthetic-settlement-v1',
    [report('settlement', '970001')],
  );
  const newer = await recon.run({ ...f.command, runKey: 'changed' });
  const results = await contend<unknown>(f.book, 2, (s, i) =>
    i === 0
      ? s.apply(cmd(reviewed, 'RESOLVE', { resolution: 'ACCEPTED_RISK' }))
      : s.generate(newer.id, 'generator'),
  );
  assert(results.some((r) => r.status === 'fulfilled'));
  const c = await exceptions.get(reviewed.id);
  assert.equal(c.state, 'UNDER_REVIEW');
  const states = (
    await admin.query(
      'SELECT previous_state,state,action FROM exceptions.event WHERE case_id=$1 ORDER BY version',
      [c.id],
    )
  ).rows;
  assert(
    states.every((e, i) =>
      i === 0
        ? e.previous_state === 'ABSENT'
        : e.previous_state === states[i - 1].state,
    ),
  );
});
async function eventCount(cid: string) {
  return (
    await admin.query(
      'SELECT count(*)::integer AS n FROM exceptions.event WHERE case_id=$1',
      [cid],
    )
  ).rows[0].n;
}
test('event/audit/intent failures roll back the complete command, unchanged retry recovers', async () => {
  const f = await setup();
  let c = f.views[0]!;
  for (const table of [
    'exceptions.event',
    'audit.audit_event',
    'outbox.outbox_event',
  ]) {
    const fn = 'fail_exception_' + randomUUID().replaceAll('-', '');
    const predicate =
      table === 'exceptions.event'
        ? `NEW.case_id='${c.id}'::uuid`
        : `NEW.exception_event_id IN(SELECT id FROM exceptions.event WHERE case_id='${c.id}'::uuid)`;
    await admin.query(
      `CREATE FUNCTION public.${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${predicate} THEN RAISE EXCEPTION USING ERRCODE='P8999',MESSAGE='injected exception failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER ${fn} BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION public.${fn}()`,
    );
    const note = cmd(c, 'NOTE', { note: 'Synthetic failure/retry context' }),
      before = await eventCount(c.id);
    try {
      await assert.rejects(exceptions.apply(note), { code: 'P8999' });
      assert.equal(await eventCount(c.id), before);
    } finally {
      await admin.query(
        `DROP TRIGGER ${fn} ON ${table}; DROP FUNCTION public.${fn}()`,
      );
    }
    c = await exceptions.apply(note);
    assert.equal(await eventCount(c.id), before + 1);
  }
});
test('actual backend death inside a decision leaves no event/audit/intent and unchanged retry succeeds', async () => {
  const f = await setup(),
    c = f.views[0]!,
    fn = 'sleep_exception_' + randomUUID().replaceAll('-', '');
  await admin.query(
    `CREATE FUNCTION public.${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.case_id='${c.id}'::uuid THEN PERFORM pg_sleep(15); END IF; RETURN NEW; END $$; CREATE TRIGGER ${fn} AFTER INSERT ON exceptions.event FOR EACH ROW EXECUTE FUNCTION public.${fn}()`,
  );
  const label = 'exception-kill-' + randomUUID(),
    pool = new Pool({ connectionString: eu, application_name: label });
  pool.on('error', () => {});
  const note = cmd(c, 'NOTE', { note: 'Synthetic recovery after crash' });
  const promise = new PostgresExceptions(pool).apply(note);
  const observed = promise.then(
    () => false,
    () => true,
  );
  try {
    let pid: number | undefined;
    const deadline = Date.now() + 7000;
    while (Date.now() < deadline) {
      pid = (
        await admin.query(
          "SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND wait_event='PgSleep'",
          [label],
        )
      ).rows[0]?.pid;
      if (pid) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert(pid);
    await admin.query('SELECT pg_terminate_backend($1)', [pid]);
    assert(await observed);
    assert.equal(await eventCount(c.id), 1);
  } finally {
    await observed;
    await admin.query(
      `DROP TRIGGER ${fn} ON exceptions.event; DROP FUNCTION public.${fn}()`,
    );
    await pool.end();
  }
  assert.equal((await exceptions.apply(note)).version, 2);
});
test('lost successful COMMIT acknowledgement for generation and resolution recovers one durable effect', async () => {
  const f = await fixture(admin, ip, pp, bp, { banks: [] }),
    run = await recon.run(f.command);
  const proxy = await commitDropProxy(eu),
    pool = new Pool({ connectionString: proxy.url });
  pool.on('error', () => {});
  try {
    await assert.rejects(
      new PostgresExceptions(pool).generate(run.id, 'system'),
      UnknownExceptionCommit,
    );
    await proxy.dropped;
  } finally {
    await pool.end();
    await proxy.close();
  }
  const ids = await exceptions.generate(run.id, 'system');
  assert.equal(ids.length, 1);
  let c = await exceptions.apply(
    cmd(await exceptions.get(ids[0]!), 'START_REVIEW'),
  );
  const resolve = cmd(c, 'RESOLVE', { resolution: 'ACCEPTED_RISK' }),
    proxy2 = await commitDropProxy(eu),
    pool2 = new Pool({ connectionString: proxy2.url });
  pool2.on('error', () => {});
  try {
    await assert.rejects(
      new PostgresExceptions(pool2).apply(resolve),
      UnknownExceptionCommit,
    );
    await proxy2.dropped;
  } finally {
    await pool2.end();
    await proxy2.close();
  }
  c = await exceptions.apply(resolve);
  assert.equal(c.version, 3);
  assert.equal(await eventCount(c.id), 3);
});
test('deferred guards and raw SQL reject orphan cases, missing companions and forged history', async () => {
  const f = await setup();
  const c = f.views[0]!;
  await assert.rejects(
    admin.query(
      "INSERT INTO exceptions.event(case_id,version,command_key,command,action,previous_state,state,classification,evidence_run_id,actor_id,reason) VALUES($1,2,'forged','{}','RESOLVE','OPEN','OPEN','MISSING_BANK_MOVEMENT',$2,'actor','forged')",
      [c.id, f.run.id],
    ),
    { code: 'P8003' },
  );
  for (const field of ['exposure_minor', 'condition']) {
    const row = (
      await admin.query(
        'SELECT * FROM exceptions.occurrence WHERE case_id=$1',
        [c.id],
      )
    ).rows[0];
    await assert.rejects(
      admin.query(
        `INSERT INTO exceptions.occurrence SELECT case_id,run_id,item_id,event_id,${field === 'condition' ? "'{}'::jsonb" : 'condition'},classification,currency,${field === 'exposure_minor' ? '1' : 'exposure_minor'},exposure_reason FROM exceptions.occurrence WHERE case_id=$1`,
        [row.case_id],
      ),
      { code: 'P8003' },
    );
  }
  // Deleting companions cannot bypass creation deferred checks, even through a deliberately suppressed insert.
  const fn = 'suppress_exception_' + randomUUID().replaceAll('-', '');
  await admin.query(
    `CREATE FUNCTION public.${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.exception_event_id IS NOT NULL THEN RETURN NULL; END IF; RETURN NEW; END $$; CREATE TRIGGER ${fn} BEFORE INSERT ON audit.audit_event FOR EACH ROW EXECUTE FUNCTION public.${fn}()`,
  );
  try {
    await assert.rejects(exceptions.apply(cmd(c, 'START_REVIEW')), {
      code: 'P8004',
    });
    assert.equal(await eventCount(c.id), 1);
  } finally {
    await admin.query(
      `DROP TRIGGER ${fn} ON audit.audit_event; DROP FUNCTION public.${fn}()`,
    );
  }
});
test('20 real PostgreSQL properties: unique identity, exact accepted risk, preserved evidence and idempotent resolution', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.bigInt({ min: 1n, max: 9007199254741993n }),
      fc.integer({ min: 1, max: 4 }),
      async (a, replays) => {
        const f = await setup({
          banks: [],
          capture: (a + 30000n).toString(),
          reports: [
            {
              ...report('settlement', a.toString()),
              gross: money((a + 30000n).toString()),
            },
          ],
        });
        const c = f.views[0]!;
        for (let i = 0; i < replays; i++)
          assert.deepEqual(
            await exceptions.generate(f.run.id, 'system'),
            f.ids,
          );
        const before = (
          await admin.query(
            'SELECT condition FROM exceptions.occurrence WHERE case_id=$1',
            [c.id],
          )
        ).rows;
        let view = await exceptions.apply(cmd(c, 'START_REVIEW'));
        const resolve = cmd(view, 'RESOLVE', { resolution: 'ACCEPTED_RISK' });
        view = await exceptions.apply(resolve);
        for (let i = 0; i < replays; i++)
          assert.deepEqual(await exceptions.apply(resolve), view);
        assert.equal(view.currentlyReconciled, false);
        assert.equal(view.exposure?.amountMinor, a.toString());
        assert.equal(
          (await exceptions.summary(f.mappingId)).exposure[0]!
            .acceptedRiskMinor,
          a.toString(),
        );
        assert.equal((await recon.summary(f.run.id)).matchedGroups, 0);
        assert.deepEqual(
          (
            await admin.query(
              'SELECT condition FROM exceptions.occurrence WHERE case_id=$1',
              [c.id],
            )
          ).rows,
          before,
        );
        assert.equal((await exceptions.summary(f.mappingId)).createdTotal, 1);
      },
    ),
    { seed: 70803, numRuns: 20 },
  );
});
test('explicit reopening cites new unresolved run and preserves the prior structured resolution', async () => {
  const f = await setup();
  let c = await exceptions.apply(cmd(f.views[0]!, 'START_REVIEW'));
  c = await exceptions.apply(
    cmd(c, 'RESOLVE', { resolution: 'SOURCE_CORRECTION_REQUIRED' }),
  );
  await importEvidence(
    f.ingestion,
    f.processor,
    f.source,
    'synthetic-settlement',
    'synthetic-settlement-v1',
    [report('settlement', '970001')],
  );
  const later = await recon.run({ ...f.command, runKey: 'explicit-reopen' });
  const reopened = await exceptions.apply(
    cmd(c, 'REOPEN', { evidenceRunId: later.id }),
  );
  assert.equal(reopened.state, 'UNDER_REVIEW');
  assert.equal(reopened.resolution, null);
  assert.equal(reopened.exposure, null);
  assert.deepEqual(await exceptions.generate(later.id, 'system'), [c.id]);
  assert.equal((await exceptions.get(c.id)).version, reopened.version);
});
test('all nonfinancial resolution reasons leave historical outcomes and allocations unchanged', async () => {
  for (const resolution of [
    'SOURCE_CORRECTION_REQUIRED',
    'PROCESSOR_FEE_CONFIRMED',
    'TIMING_DIFFERENCE',
    'DUPLICATE_SOURCE_RECORD',
    'ACCEPTED_RISK',
    'ACCOUNTING_ADJUSTMENT_REQUIRED',
    'NOT_RECONCILED',
    'UNSUPPORTED_SOURCE',
    'OTHER',
  ] as const) {
    const f = await setup(),
      view = await exceptions.apply(cmd(f.views[0]!, 'START_REVIEW'));
    const resolved = await exceptions.apply(
      cmd(view, 'RESOLVE', { resolution }),
    );
    assert.equal(resolved.currentlyReconciled, false);
    assert.equal(resolved.resolution, resolution);
    assert.equal((await recon.summary(f.run.id)).matchedGroups, 0);
    assert.equal(
      (
        await admin.query(
          'SELECT count(*)::integer AS n FROM reconciliation.current_allocation WHERE item_id=$1',
          [view.itemId],
        )
      ).rows[0].n,
      0,
    );
  }
});
test('source incompleteness stays reviewable; exposure unknown and correction source history retained', async () => {
  const f = await fixture(admin, ip, pp, bp, { reports: [], banks: [] });
  await importEvidence(
    f.ingestion,
    f.processor,
    f.source,
    'synthetic-settlement',
    'synthetic-settlement-v1',
    [report()],
    { expectedCount: 2 },
  );
  const run = await recon.run(f.command),
    ids = await exceptions.generate(run.id, 'system'),
    view = await exceptions.get(ids[0]!);
  assert.equal(view.classification, 'SOURCE_INCOMPLETENESS');
  assert.equal(view.exposure, null);
});
test('exposure totals retain exact large money and separate currencies and sides', async () => {
  const a = '9007199254740993';
  const f = await setup({
    capture: '9007199254770993',
    banks: [],
    reports: [{ ...report('settlement', a), gross: money('9007199254770993') }],
  });
  assert.equal(f.views[0]!.exposure?.amountMinor, a);
  const other = await fixture(admin, ip, pp, bp, { banks: [], reports: [] });
  await importEvidence(
    other.ingestion,
    other.processor,
    other.source,
    'synthetic-movement',
    'synthetic-movement-v1',
    [
      {
        id: 'usd-capture',
        kind: 'capture',
        paymentReference: 'usd-payment',
        parentCaptureId: null,
        amount: money(a, 'USD'),
        occurredAt: '2026-01-01T00:00:00.000Z',
      },
    ],
  );
  await importEvidence(
    other.ingestion,
    other.processor,
    other.source,
    'synthetic-settlement',
    'synthetic-settlement-v1',
    [
      {
        ...report('usd-settlement', a, 'usd-transfer', ['usd-capture']),
        gross: money(a, 'USD'),
        fees: money('0', 'USD'),
        refunds: money('0', 'USD'),
        chargebacks: money('0', 'USD'),
        net: money(a, 'USD'),
      },
    ],
  );
  const mapping = (
    await admin.query(
      "INSERT INTO reconciliation.account_mapping(book_id,processor_source_account_id,bank_source_account_id,currency,reference_contract) VALUES($1,$2,$3,'USD','synthetic-transfer-reference-v1') RETURNING id",
      [other.book, other.source, other.bankSource],
    )
  ).rows[0].id;
  const run = await recon.run({ ...other.command, mappingId: mapping }),
    ids = await exceptions.generate(run.id, 'system');
  assert.equal((await exceptions.get(ids[0]!)).exposure?.amountMinor, a);
  assert.equal(
    (await exceptions.summary(mapping)).exposure[0]!.currency,
    'USD',
  );
  assert.equal(
    (await exceptions.summary(f.mappingId)).exposure[0]!.currency,
    'PHP',
  );
});
test('queued command bytes cannot change and retryable SQLSTATEs replay whole unchanged transactions', async () => {
  const f = await setup(),
    c = f.views[0]!,
    pool = new Pool({ connectionString: eu, max: 1 }),
    holder = await pool.connect();
  const command = { ...cmd(c, 'NOTE', { note: 'Original review note' }) };
  const pending = new PostgresExceptions(pool).apply(command);
  command.note = 'Changed after submission';
  command.reason = 'Changed after submission';
  holder.release();
  const result = await pending;
  await pool.end();
  const event = (
    await admin.query(
      'SELECT note,reason FROM exceptions.event WHERE case_id=$1 AND version=$2',
      [c.id, result.version],
    )
  ).rows[0];
  assert.equal(event.note, 'Original review note');
  assert.equal(event.reason, 'Documented synthetic operational decision');
  for (const code of ['40001', '40P01']) {
    const fn = 'retry_exception_' + randomUUID().replaceAll('-', '');
    await admin.query(
      `CREATE SEQUENCE public.${fn}; GRANT USAGE ON SEQUENCE public.${fn} TO flow_ledger_owner; CREATE FUNCTION public.${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.case_id='${c.id}'::uuid AND nextval('public.${fn}')=1 THEN RAISE EXCEPTION USING ERRCODE='${code}',MESSAGE='injected retryable transaction'; END IF; RETURN NEW; END $$; CREATE TRIGGER ${fn} BEFORE INSERT ON exceptions.event FOR EACH ROW EXECUTE FUNCTION public.${fn}()`,
    );
    try {
      const before = await exceptions.get(c.id);
      const view = await exceptions.apply(
        cmd(before, 'NOTE', { note: 'One durable retried note' }),
      );
      assert.equal(view.version, before.version + 1);
    } finally {
      await admin.query(
        `DROP TRIGGER ${fn} ON exceptions.event; DROP FUNCTION public.${fn}(); DROP SEQUENCE public.${fn}`,
      );
    }
  }
});
test('later exact matching explicitly supersedes an accepted-risk conclusion without rewriting history', async () => {
  const f = await setup();
  let c = await exceptions.apply(cmd(f.views[0]!, 'START_REVIEW'));
  c = await exceptions.apply(
    cmd(c, 'RESOLVE', { resolution: 'ACCEPTED_RISK' }),
  );
  const riskVersion = c.version;
  await importEvidence(
    f.ingestion,
    f.bank,
    f.bankSource,
    'synthetic-bank-entry',
    'synthetic-bank-entry-v1',
    [entry()],
  );
  const later = await recon.run({
    ...f.command,
    runKey: 'accepted-risk-now-matched',
  });
  const supersede = cmd(c, 'SUPERSEDE', { evidenceRunId: later.id });
  c = await exceptions.apply(supersede);
  assert.equal(c.state, 'RESOLVED');
  assert.equal(c.resolution, 'FIXED_AND_VERIFIED');
  assert.equal(c.currentlyReconciled, true);
  assert.equal(c.evidenceRunId, later.id);
  assert.deepEqual(await exceptions.apply(supersede), c);
  const old = (
    await admin.query(
      'SELECT resolution,evidence_run_id FROM exceptions.event WHERE case_id=$1 AND version=$2',
      [c.id, riskVersion],
    )
  ).rows[0];
  assert.equal(old.resolution, 'ACCEPTED_RISK');
  assert.equal(old.evidence_run_id, f.run.id);
  assert.equal(
    (await exceptions.summary(f.mappingId)).exposure[0]!.acceptedRiskMinor,
    '0',
  );
});
test('all typed attachment targets are scoped, attributable, immutable references', async () => {
  const f = await setup();
  let c = f.views[0]!;
  const bankEntries = await importEvidence(
    f.ingestion,
    f.bank,
    f.bankSource,
    'synthetic-bank-entry',
    'synthetic-bank-entry-v1',
    [
      entry('bank', '970000', 'transfer', {
        statementReference: 's',
        lineIdentity: 'line',
      }),
    ],
  );
  const statements = await importEvidence(
    f.ingestion,
    f.bank,
    f.bankSource,
    'synthetic-bank-statement',
    'synthetic-bank-statement-v1',
    [
      {
        id: 's',
        currency: 'PHP',
        reportedAt: '2026-01-05T00:00:00.000Z',
        expectedLineCount: 1,
        lineIds: ['line'],
        opening: money('0'),
        closing: money('970000'),
      },
    ],
  );
  const later = await recon.run({ ...f.command, runKey: 'evidence' });
  const processorControl = await f.processor.evaluate(
    'settlement',
    f.reports[0]!.id,
    'control',
  );
  const bankControl = await f.bank.evaluate(statements[0]!.id, 'control');
  const activity = (
    await admin.query(
      'SELECT id FROM processor.activity WHERE source_account_id=$1 LIMIT 1',
      [f.source],
    )
  ).rows[0].id;
  const raw = (
    await admin.query(
      'SELECT id FROM ingestion.raw_record WHERE source_account_id=$1 LIMIT 1',
      [f.source],
    )
  ).rows[0].id;
  const group = (
    await admin.query(
      'SELECT id FROM reconciliation.match_group WHERE run_id=$1',
      [later.id],
    )
  ).rows[0].id;
  for (const attachment of [
    { kind: 'PROCESSOR_ACTIVITY' as const, id: activity },
    { kind: 'SOURCE_RECORD' as const, id: raw },
    { kind: 'PROCESSOR_CONTROL' as const, id: processorControl.id },
    { kind: 'BANK_CONTROL' as const, id: bankControl.id },
    { kind: 'BANK_ENTRY' as const, id: bankEntries[0]!.id },
    { kind: 'MATCH_GROUP' as const, id: group },
  ])
    c = await exceptions.apply(cmd(c, 'ATTACH', { attachment }));
  assert.equal(
    (
      await admin.query(
        'SELECT count(*)::integer AS n FROM exceptions.attachment a JOIN exceptions.event e ON e.id=a.event_id WHERE e.case_id=$1',
        [c.id],
      )
    ).rows[0].n,
    6,
  );
  for (const table of ['case_record', 'event', 'occurrence', 'attachment'])
    await assert.rejects(
      admin.query(
        `UPDATE exceptions.${table} SET ${table === 'event' ? "reason='changed'" : table === 'occurrence' ? "exposure_reason='changed'" : table === 'attachment' ? 'event_id=event_id' : 'id=id'}`,
      ),
      { code: 'P1003' },
    );
});
test('database cannot commit a case without its creation decision, or a decision without its attachment', async () => {
  const f = await fixture(admin, ip, pp, bp, { banks: [] }),
    run = await recon.run(f.command);
  const item = (
    await admin.query(
      'SELECT item_id FROM reconciliation.outcome WHERE run_id=$1',
      [run.id],
    )
  ).rows[0].item_id;
  await assert.rejects(
    admin.query(
      'INSERT INTO exceptions.case_record(mapping_id,item_id,original_run_id) VALUES($1,$2,$3)',
      [f.mappingId, item, run.id],
    ),
    { code: 'P8004' },
  );
  const ids = await exceptions.generate(run.id, 'system'),
    c = await exceptions.get(ids[0]!);
  const fn = 'suppress_attachment_' + randomUUID().replaceAll('-', '');
  await admin.query(
    `CREATE FUNCTION public.${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$; CREATE TRIGGER ${fn} BEFORE INSERT ON exceptions.attachment FOR EACH ROW EXECUTE FUNCTION public.${fn}()`,
  );
  try {
    await assert.rejects(
      exceptions.apply(
        cmd(c, 'ATTACH', {
          attachment: { kind: 'RECONCILIATION_RUN', id: run.id },
        }),
      ),
      { code: 'P8004' },
    );
    assert.equal((await exceptions.get(c.id)).version, 1);
  } finally {
    await admin.query(
      `DROP TRIGGER ${fn} ON exceptions.attachment; DROP FUNCTION public.${fn}()`,
    );
  }
});
test('negative exposure uses exact magnitude, oversized residual stays unknown, and aggregate totals remain wider exact strings', async () => {
  const negative = await setup({
    capture: '1',
    fee: '-10',
    banks: [],
    reports: [
      { ...report('settlement', '-9'), gross: money('1'), fees: money('10') },
    ],
  });
  assert.equal(negative.views[0]!.exposure?.amountMinor, '9');
  const max = '9223372036854775807';
  const mismatch = await setup({
    capture: '1',
    fee: '-' + max,
    banks: [entry('bank', max)],
    reports: [
      {
        ...report('settlement', '-9223372036854775806'),
        gross: money('1'),
        fees: money(max),
      },
    ],
  });
  assert(
    mismatch.views.every(
      (c) =>
        c.classification === 'AMOUNT_MISMATCH' &&
        c.exposure === null &&
        c.exposureReason === 'MONEY_MAGNITUDE_OUT_OF_RANGE',
    ),
  );
  const f = await fixture(admin, ip, pp, bp, { reports: [], banks: [] });
  for (let i = 0; i < 2; i++) {
    await importEvidence(
      f.ingestion,
      f.processor,
      f.source,
      'synthetic-movement',
      'synthetic-movement-v1',
      [
        {
          id: 'large-capture-' + i,
          kind: 'capture',
          paymentReference: 'large-payment-' + i,
          parentCaptureId: null,
          amount: money(max),
          occurredAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    );
    await importEvidence(
      f.ingestion,
      f.processor,
      f.source,
      'synthetic-settlement',
      'synthetic-settlement-v1',
      [
        {
          ...report('large-settlement-' + i, max, 'large-transfer-' + i, [
            'large-capture-' + i,
          ]),
          gross: money(max),
          fees: money('0'),
        },
      ],
    );
  }
  const run = await recon.run(f.command);
  await exceptions.generate(run.id, 'system');
  assert.equal(
    (await exceptions.summary(f.mappingId)).exposure[0]!.amountMinor,
    '18446744073709551614',
  );
});
