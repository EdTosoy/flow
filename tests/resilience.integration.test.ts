import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { Pool } from 'pg';
import fc from 'fast-check';
import {
  PostgresLedger,
  ledgerCommandsInTransaction,
} from '@flow/ledger-postgres';
import type { PostJournalCommand } from '@flow/ledger-domain';
import { Money } from '@flow/money';
import { PostgresIngestion } from '@flow/ingestion-postgres';
import { PostgresProcessor } from '@flow/processor-postgres';
import { PostgresBank } from '@flow/bank-postgres';
import { PostgresReconciliation } from '@flow/reconciliation-postgres';
import { PostgresExceptions } from '@flow/exception-postgres';
import type { CaseCommand, CaseView } from '@flow/exception-domain';
import { PostgresControls } from '@flow/control-postgres';
import { PostgresWorker } from '@flow/worker-postgres';
import {
  PostgresIntegrity,
  type IntegritySummary,
} from '@flow/integrity-postgres';
import {
  fixture,
  entry,
  report,
  money,
  importEvidence,
} from './helpers/reconciliation-fixture';
import {
  clean,
  contend,
  failOnce,
  intercepted,
  waitForLocks,
  waitDue,
  witness,
  type Boundary,
} from './helpers/resilience';
import { commitDropProxy } from './helpers/commit-proxy';

const urls = Object.fromEntries(
  [
    'ADMIN',
    'WRITER',
    'INGESTION',
    'PROCESSOR',
    'BANK',
    'RECONCILIATION',
    'EXCEPTION',
    'CONTROL',
    'WORKER',
    'INTEGRITY',
  ].map((k) => [k, process.env['FLOW_TEST_' + k + '_URL']!]),
);
if (!urls['ADMIN']) throw new Error('Run pnpm test:integration');
const pools = Object.fromEntries(
  Object.entries(urls).map(([k, url]) => [
    k,
    new Pool({ connectionString: url, max: 20 }),
  ]),
);
const admin = pools['ADMIN']!,
  ip = pools['INGESTION']!,
  pp = pools['PROCESSOR']!,
  bp = pools['BANK']!,
  rp = pools['RECONCILIATION']!,
  ep = pools['EXCEPTION']!,
  cp = pools['CONTROL']!,
  wp = pools['WORKER']!,
  lp = pools['WRITER']!;
const recon = new PostgresReconciliation(rp),
  exceptions = new PostgresExceptions(ep),
  controls = new PostgresControls(cp);
after(async () => {
  await Promise.all(Object.values(pools).map((p) => p.end()));
});
const movement = (id: string, amount = '100') => ({
  id,
  kind: 'capture',
  paymentReference: id,
  parentCaptureId: null,
  amount: money(amount),
  occurredAt: '2026-01-01T00:00:00.000Z',
});
async function pending(
  f: Awaited<ReturnType<typeof fixture>>,
  body = movement(randomUUID()),
  kind = 'synthetic-movement',
) {
  return f.ingestion.ingest({
    sourceAccountId: kind === 'synthetic-bank-entry' ? f.bankSource : f.source,
    batchKey: randomUUID(),
    actorId: 'resilience',
    provenance: { adapterVersion: 'resilience-v1' },
    records: [
      {
        locator: '0',
        objectKind: kind,
        externalId: body.id,
        sourceRevision: null,
        sequence: null,
        sourceObservedAt: null,
        bytes: Buffer.from(JSON.stringify(body)),
      },
    ],
  });
}
const caseCommand = (
  view: CaseView,
  action: CaseCommand['action'],
  extra: Partial<CaseCommand> = {},
): CaseCommand => ({
  caseId: view.id,
  commandKey: randomUUID(),
  expectedVersion: view.version,
  actorId: 'resilience-reviewer',
  reason: 'Controlled synthetic failure scenario',
  action,
  ...extra,
});
async function journal(book: string): Promise<PostJournalCommand> {
  const ledger = new PostgresLedger(lp),
    ids: string[] = [];
  for (const [code, classification, normalSide] of [
    ['asset', 'asset', 'debit'],
    ['equity', 'equity', 'credit'],
  ] as const)
    ids.push(
      (
        await ledger.createAccount({
          bookId: book,
          code,
          classification,
          normalSide,
          currency: 'PHP',
          commandKey: randomUUID(),
          actorId: 'resilience',
          reason: 'Synthetic test accounts',
        })
      ).id,
    );
  return {
    bookId: book,
    commandKey: randomUUID(),
    actorId: 'resilience',
    reason: 'Synthetic resilient journal',
    effectNamespace: 'phase11',
    businessEffectKey: randomUUID(),
    currency: 'PHP',
    effectiveAt: '2026-01-01T00:00:00.000Z',
    policyVersion: 'generic-mechanics-v1',
    entries: [
      { accountId: ids[0]!, side: 'debit', money: Money.of(100n, 'PHP') },
      { accountId: ids[1]!, side: 'credit', money: Money.of(100n, 'PHP') },
    ],
  };
}
type Kind =
  | 'ledger'
  | 'ingestion'
  | 'normalization'
  | 'processor'
  | 'bank'
  | 'reconciliation'
  | 'exception'
  | 'control';
async function operation(kind: Kind) {
  const f = await fixture(
    admin,
    ip,
    pp,
    bp,
    kind === 'exception' ? { banks: [] } : {},
  );
  let pool: Pool, table: string, runId: string | undefined;
  let execute: (pool: Pool) => Promise<unknown>, count: () => Promise<number>;
  const n = async (sql: string, values: unknown[]) =>
    Number((await admin.query<{ n: string }>(sql, values)).rows[0]!.n);
  if (kind === 'ledger') {
    const c = await journal(f.book);
    pool = lp;
    table = 'ledger.ledger_entry';
    execute = (p) => new PostgresLedger(p).post(c);
    count = () =>
      n(
        'SELECT count(*) n FROM ledger.ledger_transaction WHERE book_id=$1 AND business_effect_key=$2',
        [f.book, c.businessEffectKey],
      );
  } else if (kind === 'ingestion') {
    const body = movement(randomUUID()),
      c = {
        sourceAccountId: f.source,
        batchKey: randomUUID(),
        actorId: 'resilience',
        provenance: { adapterVersion: 'resilience-v1' },
        records: [
          {
            locator: '0',
            objectKind: 'synthetic-movement',
            externalId: body.id,
            sourceRevision: null,
            sequence: null,
            sourceObservedAt: null,
            bytes: Buffer.from(JSON.stringify(body)),
          },
        ],
      };
    pool = ip;
    table = 'ingestion.raw_record';
    execute = (p) => new PostgresIngestion(p, ip).ingest(c);
    count = () =>
      n(
        'SELECT count(*) n FROM ingestion.batch WHERE source_account_id=$1 AND batch_key=$2',
        [f.source, c.batchKey],
      );
  } else if (['normalization', 'processor', 'bank'].includes(kind)) {
    const body = kind === 'bank' ? entry(randomUUID()) : movement(randomUUID());
    const b = await pending(
      f,
      body as ReturnType<typeof movement>,
      kind === 'bank' ? 'synthetic-bank-entry' : 'synthetic-movement',
    );
    const raw = (
      await admin.query<{ id: string; revision_id: string }>(
        'SELECT id,revision_id FROM ingestion.raw_record WHERE batch_id=$1',
        [b.id],
      )
    ).rows[0]!;
    if (kind === 'normalization') {
      pool = ip;
      table = 'ingestion.processing';
      execute = (p) => new PostgresIngestion(p, ip).normalizeRaw(raw.id);
      count = () =>
        n(
          "SELECT count(*) n FROM ingestion.interpretation WHERE revision_id=$1 AND normalizer_version='synthetic-movement-v1'",
          [raw.revision_id],
        );
    } else {
      const version =
        kind === 'bank' ? 'synthetic-bank-entry-v1' : 'synthetic-movement-v1';
      if (kind === 'bank')
        await f.ingestion.requestNormalization(b.id, version, 'resilience');
      await f.ingestion.normalizeBatch(b.id, version);
      pool = kind === 'bank' ? bp : pp;
      table = kind === 'bank' ? 'bank.entry' : 'processor.activity';
      execute = (p) =>
        kind === 'bank'
          ? new PostgresBank(p, bp).derive(raw.revision_id, version)
          : new PostgresProcessor(p, pp).derive(raw.revision_id, version);
      count = () =>
        n(`SELECT count(*) n FROM ${kind}.derivation WHERE revision_id=$1`, [
          raw.revision_id,
        ]);
    }
  } else if (kind === 'reconciliation') {
    pool = rp;
    table = 'reconciliation.match_group_member';
    runId = await recon.create(f.command);
    await recon.seal(runId);
    await recon.plan(runId);
    const id = runId;
    execute = (p) => new PostgresReconciliation(p).advance(id);
    count = () =>
      n('SELECT count(*) n FROM reconciliation.match_group WHERE run_id=$1', [
        id,
      ]);
  } else if (kind === 'exception') {
    pool = ep;
    table = 'exceptions.event';
    runId = (await recon.run(f.command)).id;
    const ids = await exceptions.generate(runId, 'resilience');
    const v = await exceptions.apply(
      caseCommand(await exceptions.get(ids[0]!), 'START_REVIEW'),
    );
    const c = caseCommand(v, 'RESOLVE', { resolution: 'ACCEPTED_RISK' });
    execute = (p) => new PostgresExceptions(p, ep).apply(c);
    count = () =>
      n(
        'SELECT count(*) n FROM exceptions.event WHERE case_id=$1 AND command_key=$2',
        [v.id, c.commandKey],
      );
  } else {
    pool = cp;
    table = 'outbox.outbox_event';
    runId = (await recon.run(f.command)).id;
    const id = await controls.create({
      bookId: f.book,
      runKey: randomUUID(),
      actorId: 'resilience',
      reconciliationRunIds: [runId],
    });
    await controls.freeze(id);
    while (await controls.evaluate(id)) {}
    execute = (p) => new PostgresControls(p, cp).complete(id);
    count = () =>
      n(
        "SELECT count(*) n FROM controls.run WHERE id=$1 AND state='COMPLETED'",
        [id],
      );
  }
  return { f, pool, table, execute, count, runId };
}

for (const kind of [
  'ledger',
  'ingestion',
  'normalization',
  'processor',
  'bank',
  'reconciliation',
  'exception',
  'control',
] as const) {
  test(
    kind +
      ': whole-command crash matrix, partial-write failure, actual lost COMMIT ack and unchanged retry',
    async () => {
      const op = await operation(kind),
        preserved = await witness(admin);
      for (const boundary of [
        'beforeBegin',
        'afterBegin',
        'beforeCommand',
        'afterCommand',
        'beforeCommit',
      ] as Boundary[]) {
        const fault = failOnce(op.pool, boundary);
        await assert.rejects(op.execute(fault.pool));
        assert(fault.fired());
        assert.equal(await op.count(), 0);
        await clean(admin, op.f.book);
        await preserved();
      }
      // A real SQL trigger aborts inside the domain routine after earlier writes, not a mocked database result.
      const t = 'resilience_fault_' + kind;
      await admin.query(
        `CREATE FUNCTION public.${t}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION USING ERRCODE='57014',MESSAGE='Test-only partial-write failure'; END $$`,
      );
      try {
        await admin.query(
          `CREATE TRIGGER ${t} AFTER ${kind === 'normalization' ? 'UPDATE' : 'INSERT'} ON ${op.table} FOR EACH ROW EXECUTE FUNCTION public.${t}()`,
        );
        await assert.rejects(op.execute(op.pool));
        assert.equal(await op.count(), 0);
        await clean(admin, op.f.book);
        await preserved();
      } finally {
        await admin.query(
          `DROP TRIGGER IF EXISTS ${t} ON ${op.table}; DROP FUNCTION public.${t}()`,
        );
      }
      const url = Object.entries(pools).find(([, p]) => p === op.pool)![0],
        proxy = await commitDropProxy(urls[url]!);
      const proxied = new Pool({ connectionString: proxy.url });
      try {
        await assert.rejects(op.execute(proxied));
        await proxy.dropped;
        assert.equal(await op.count(), 1);
        await clean(admin, op.f.book);
      } finally {
        await proxied.end();
        await proxy.close();
      }
      await op.execute(op.pool);
      assert.equal(await op.count(), 1);
      if (kind === 'reconciliation') await recon.complete(op.runId!);
      await new PostgresWorker(wp).processBatch(
        'matrix-recovery',
        100,
        op.f.book,
      );
      const recovered = await clean(
        admin,
        op.f.book,
        op.runId ? [op.runId] : [],
      );
      assert.equal(
        recovered.work.pending +
          recovered.work.processing +
          recovered.work.retryable,
        0,
      );
      await preserved();
    },
  );
}

for (const kind of ['ledger', 'reconciliation', 'control'] as const)
  test(
    kind +
      ': actual backend termination after writes rolls back truth and companions',
    async () => {
      const op = await operation(kind),
        preserved = await witness(admin);
      let killed = false;
      const fault = intercepted(op.pool, async (text, client, execute) => {
        const result = await execute();
        if (!killed && text.startsWith('SELECT ')) {
          killed = true;
          const pid = (
            await client.query<{ pid: number }>('SELECT pg_backend_pid() pid')
          ).rows[0]!.pid;
          await admin.query('SELECT pg_terminate_backend($1::integer)', [pid]);
        }
        return result;
      });
      await assert.rejects(op.execute(fault));
      assert(killed);
      assert.equal(await op.count(), 0);
      await clean(admin, op.f.book);
      await preserved();
      await op.execute(op.pool);
      assert.equal(await op.count(), 1);
      if (kind === 'reconciliation') await recon.complete(op.runId!);
      await new PostgresWorker(wp).processBatch(
        'backend-recovery',
        100,
        op.f.book,
      );
      const recovered = await clean(admin, op.f.book);
      assert.equal(
        recovered.work.pending +
          recovered.work.processing +
          recovered.work.retryable,
        0,
      );
      await preserved();
    },
  );

test('real deadlock aborts one entire financial command; unchanged bounded replay retains one effect and companions', async () => {
  const f = await fixture(admin, ip, pp, bp),
    a = await journal(f.book),
    b = { ...a, commandKey: randomUUID(), businessEffectKey: randomUUID() },
    preserved = await witness(admin);
  const barrier = await admin.connect(),
    other = await lp.connect();
  const key = 71101;
  let retries = 0,
    deadlocks = 0;
  try {
    await barrier.query('SELECT pg_advisory_lock($1)', [key]);
    await other.query('BEGIN');
    await other.query('SELECT pg_advisory_xact_lock($1)', [key + 1]);
    const pid = (
      await other.query<{ pid: number }>('SELECT pg_backend_pid() pid')
    ).rows[0]!.pid;
    let first = true,
      actorPid = 0;
    const adapted = intercepted(lp, async (text, client, execute) => {
      if (text.startsWith('BEGIN')) {
        retries++;
        const result = await execute();
        actorPid = (
          await client.query<{ pid: number }>('SELECT pg_backend_pid() pid')
        ).rows[0]!.pid;
        await client.query('SELECT pg_advisory_xact_lock($1)', [key]);
        return result;
      }
      const result = await execute();
      if (first && text.startsWith('SELECT ledger.post_journal')) {
        first = false;
        await client.query('SELECT pg_advisory_xact_lock($1)', [key + 1]);
      }
      return result;
    });
    const posting = new PostgresLedger(adapted).post(a);
    while (!actorPid) await admin.query('SELECT 1');
    await waitForLocks(admin, [actorPid]);
    await barrier.query('SELECT pg_advisory_unlock($1)', [key]);
    await waitForLocks(admin, [actorPid]);
    const competing = (async () => {
      try {
        await ledgerCommandsInTransaction(other).post(b);
        await other.query('SELECT pg_advisory_xact_lock($1)', [key]);
        await other.query('COMMIT');
      } catch (error) {
        if ((error as { code?: string }).code === '40P01') deadlocks++;
        else throw error;
        await other.query('ROLLBACK');
      }
    })();
    await Promise.all([posting, competing]);
    assert.equal(pid > 0, true);
    // Victim selection is deliberately not assumed. Either adapter retried or caller-owned command was aborted.
    assert(retries > 1 || deadlocks === 1);
    assert(retries <= 5);
    await new PostgresLedger(lp).post(a);
    await new PostgresLedger(lp).post(b);
    assert.equal(
      (
        await admin.query(
          'SELECT count(*)::int n FROM ledger.ledger_transaction WHERE book_id=$1',
          [f.book],
        )
      ).rows[0].n,
      2,
    );
    await clean(admin, f.book);
    await preserved();
  } finally {
    await other.query('ROLLBACK').catch(() => {});
    other.release();
    await barrier.query('SELECT pg_advisory_unlock_all()');
    barrier.release();
  }
});

test('genuine REPEATABLE READ concurrent update triggers whole-stage 40001 retry with unchanged run identity', async () => {
  const f = await fixture(admin, ip, pp, bp),
    id = await recon.create(f.command),
    lock = await admin.connect();
  let tries = 0,
    pid = 0;
  try {
    await lock.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await lock.query(
      'SELECT id FROM ledger.book WHERE id=$1 FOR NO KEY UPDATE',
      [f.book],
    );
    await lock.query(
      'SELECT id FROM reconciliation.run WHERE id=$1 FOR UPDATE',
      [id],
    );
    const modified = intercepted(rp, async (text, client, execute) => {
      if (text.startsWith('BEGIN')) {
        tries++;
        const result = await execute();
        pid = (
          await client.query<{ pid: number }>('SELECT pg_backend_pid() pid')
        ).rows[0]!.pid;
        return result;
      }
      return execute();
    });
    const freeze = new PostgresReconciliation(modified).seal(id);
    while (!pid) await admin.query('SELECT 1');
    await waitForLocks(admin, [pid]);
    await lock.query('SELECT reconciliation.seal($1::uuid)', [id]);
    await lock.query('COMMIT');
    await freeze;
    assert.equal(tries, 2);
    await recon.plan(id);
    while (await recon.advance(id)) {}
    await recon.complete(id);
    assert.equal((await recon.run(f.command)).id, id);
    await clean(admin, f.book, [id]);
  } finally {
    await lock.query('ROLLBACK').catch(() => {});
    lock.release();
  }
});

test('concurrent duplicate/corrected ingestion and normalization retain immutable provenance and unordered ambiguity', async () => {
  const f = await fixture(admin, ip, pp, bp),
    original = movement('contended'),
    changed = movement('contended', '101'),
    hold = await admin.connect(),
    pids: number[] = [];
  const preserved = await witness(admin);
  const observed = intercepted(ip, async (text, c, execute) => {
    if (text.startsWith('BEGIN'))
      pids.push(
        (await c.query<{ pid: number }>('SELECT pg_backend_pid() pid')).rows[0]!
          .pid,
      );
    return execute();
  });
  try {
    await hold.query('BEGIN');
    await hold.query(
      'SELECT id FROM ingestion.source_account WHERE id=$1 FOR UPDATE',
      [f.source],
    );
    const writes = Array.from({ length: 8 }, (_, i) =>
      pending(
        { ...f, ingestion: new PostgresIngestion(observed, ip) },
        i % 2 ? original : changed,
      ),
    );
    while (pids.length < 8) await admin.query('SELECT 1');
    await waitForLocks(admin, pids);
    await hold.query('COMMIT');
    const batches = await Promise.all(writes);
    await Promise.all(batches.map((b) => f.ingestion.normalizeBatch(b.id)));
    await Promise.all(
      batches.map((b) =>
        f.processor.deriveBatch(b.id, 'synthetic-movement-v1'),
      ),
    );
    const data = (
      await admin.query(
        "SELECT count(DISTINCT raw.id)::int receipts,count(DISTINCT raw.revision_id)::int revisions,count(DISTINCT i.revision_id)::int interpretations FROM ingestion.raw_record raw JOIN ingestion.revision rev ON rev.id=raw.revision_id JOIN ingestion.source_fact fact ON fact.id=rev.fact_id LEFT JOIN ingestion.interpretation i ON i.revision_id=rev.id WHERE fact.source_account_id=$1 AND fact.external_id='contended'",
        [f.source],
      )
    ).rows[0];
    assert.deepEqual(data, { receipts: 8, revisions: 2, interpretations: 2 });
    assert.equal(
      (
        await admin.query(
          "SELECT count(*)::int n FROM ingestion.fact_status WHERE external_id='contended' AND source_account_id=$1 AND active_revision_id IS NOT NULL",
          [f.source],
        )
      ).rows[0].n,
      0,
    );
    await clean(admin, f.book);
    await preserved();
  } finally {
    await hold.query('ROLLBACK').catch(() => {});
    hold.release();
  }
});

for (const side of ['processor', 'bank'] as const)
  test(
    side +
      ' arrival after snapshot cannot rewrite frozen reconciliation; later run explicitly includes it',
    async () => {
      const f = await fixture(admin, ip, pp, bp),
        id = await recon.create(f.command),
        c = await admin.connect();
      try {
        await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        await c.query('SELECT id FROM reconciliation.run WHERE id=$1', [id]);
        if (side === 'bank')
          await importEvidence(
            f.ingestion,
            f.bank,
            f.bankSource,
            'synthetic-bank-entry',
            'synthetic-bank-entry-v1',
            [entry('late')],
          );
        else
          await importEvidence(
            f.ingestion,
            f.processor,
            f.source,
            'synthetic-settlement',
            'synthetic-settlement-v1',
            [report('late')],
          );
        await c.query('SELECT reconciliation.seal($1::uuid)', [id]);
        await c.query('COMMIT');
        await recon.plan(id);
        while (await recon.advance(id)) {}
        await recon.complete(id);
        const old = await recon.summary(id),
          preserved = await witness(admin);
        assert.equal(
          side === 'bank' ? old.bankPopulation : old.processorPopulation,
          1,
        );
        const later = await recon.run({ ...f.command, runKey: 'later' });
        assert.equal(
          side === 'bank' ? later.bankPopulation : later.processorPopulation,
          2,
        );
        assert.equal(later.matchedGroups, 0);
        await preserved();
        await clean(admin, f.book, [later.id]);
      } finally {
        await c.query('ROLLBACK').catch(() => {});
        c.release();
      }
    },
  );

test('correction races current reconciliation and controls without rewriting proof or inventing authoritative revisions', async () => {
  const f = await fixture(admin, ip, pp, bp),
    old = await recon.run(f.command),
    preserved = await witness(admin),
    hold = await admin.connect();
  let pid = 0;
  try {
    await hold.query('BEGIN');
    await hold.query(
      'SELECT id FROM ledger.book WHERE id=$1 FOR NO KEY UPDATE',
      [f.book],
    );
    const observed = intercepted(rp, async (text, c, execute) => {
      if (text.startsWith('BEGIN'))
        pid = (await c.query<{ pid: number }>('SELECT pg_backend_pid() pid'))
          .rows[0]!.pid;
      return execute();
    });
    const next = new PostgresReconciliation(observed).run({
      ...f.command,
      runKey: 'concurrent-correction',
    });
    while (!pid) await admin.query('SELECT 1');
    await waitForLocks(admin, [pid]);
    await importEvidence(
      f.ingestion,
      f.bank,
      f.bankSource,
      'synthetic-bank-entry',
      'synthetic-bank-entry-v1',
      [entry('bank', '970001')],
    );
    await hold.query('COMMIT');
    const later = await next;
    assert.equal(later.matchedGroups, 0);
    assert.equal(
      (await recon.summary(old.id)).current[0]!.status,
      'INVALIDATED',
    );
    const cs = await controls.run({
      bookId: f.book,
      runKey: 'after-correction',
      actorId: 'resilience',
      reconciliationRunIds: [later.id],
    });
    assert.notEqual(cs.assurance, 'PASS');
    await clean(admin, f.book, [later.id]);
    await preserved();
  } finally {
    await hold.query('ROLLBACK').catch(() => {});
    hold.release();
  }
});

test('worker handler backend death, repeated lease churn, stale wake-up and post-handler crash recover exactly one interpretation', async () => {
  const f = await fixture(admin, ip, pp, bp, { reports: [], banks: [] }),
    worker = new PostgresWorker(wp);
  await worker.processBatch('fixture-drain', 100, f.book);
  await admin.query(
    'UPDATE worker.policy SET max_attempts=8,lease_ms=100,timeout_ms=80 WHERE id=1',
  );
  const b = await pending(f),
    preserved = await witness(admin);
  const old = [];
  try {
    let claim = await worker.claim('churn-0', f.book);
    assert(claim);
    const kill = intercepted(wp, async (text, c, execute) => {
      const result = await execute();
      if (text.startsWith('SELECT worker.complete_normalization')) {
        const pid = (
          await c.query<{ pid: number }>('SELECT pg_backend_pid() pid')
        ).rows[0]!.pid;
        await admin.query('SELECT pg_terminate_backend($1)', [pid]);
      }
      return result;
    });
    await assert.rejects(new PostgresWorker(kill).handle(claim));
    await clean(admin, f.book);
    for (let i = 1; i <= 3; i++) {
      old.push(claim);
      await waitDue(admin, f.book);
      const replacement = await worker.claim('churn-' + i, f.book);
      assert(replacement);
      assert.equal(replacement.attempt, claim.attempt + 1);
      assert.notEqual(replacement.token, claim.token);
      claim = replacement;
    }
    await worker.handle(claim); // Deliberately omit success acknowledgement after the domain COMMIT.
    old.push(claim);
    await waitDue(admin, f.book);
    const final = await worker.claim('restart-owner', f.book);
    assert(final);
    await worker.handle(final);
    assert(await worker.finish(final));
    for (const stale of old) {
      assert.equal(await worker.finish(stale), false);
      assert.equal(
        (
          await wp.query(
            'SELECT worker.complete_normalization($1::uuid,$2::uuid,$3::uuid,$4::jsonb) accepted',
            [
              stale.id,
              stale.token,
              (
                await admin.query(
                  'SELECT id FROM ingestion.raw_record WHERE batch_id=$1',
                  [b.id],
                )
              ).rows[0].id,
              JSON.stringify({ state: 'FAILED', code: 'INVALID_JSON' }),
            ],
          )
        ).rows[0].accepted,
        false,
      );
    }
    assert.equal(
      (
        await admin.query(
          'SELECT count(*)::int n FROM ingestion.interpretation i JOIN ingestion.raw_record raw ON raw.revision_id=i.revision_id WHERE raw.batch_id=$1',
          [b.id],
        )
      ).rows[0].n,
      1,
    );
    const health = await clean(admin, f.book);
    assert.equal(health.work.processing, 0);
    assert.equal(health.work.expiredRecoverable, 0);
    await preserved();
  } finally {
    await admin.query(
      'UPDATE worker.policy SET max_attempts=5,lease_ms=30000,timeout_ms=10000 WHERE id=1',
    );
  }
});

test('independent health surface uses narrow role, distinguishes financial UNKNOWN from structural PASS and supports CLI', async () => {
  const f = await fixture(admin, ip, pp, bp),
    r = await recon.run(f.command),
    before = await witness(admin),
    integrity = new PostgresIntegrity(pools['INTEGRITY']!);
  const s = await integrity.sweep(f.book, [r.id]);
  assert.equal(s.integrity, 'PASS');
  assert.equal(s.financialAssurance, 'UNKNOWN');
  assert(s.open.unknownControls > 0);
  await before();
  for (const sql of [
    'UPDATE ledger.ledger_entry SET amount_minor=1',
    'DELETE FROM ingestion.raw_record',
    "SELECT worker.claim('unauthorized',NULL)",
    'SELECT controls.complete(NULL)',
    'SELECT * FROM ingestion.raw_record',
  ])
    await assert.rejects(pools['INTEGRITY']!.query(sql), { code: '42501' });
  await assert.rejects(integrity.sweep(f.book, [r.id, r.id]));
  await clean(admin, f.book, [r.id]);
});

test('rollback-only corruption is detected by the independent sweep and cannot alter retained history', async () => {
  const f = await fixture(admin, ip, pp, bp),
    r = await recon.run(f.command),
    j = await journal(f.book);
  await new PostgresLedger(lp).post(j);
  const preserve = await witness(admin);
  const probes: [string, string, unknown[], string][] = [
    [
      'ledger.ledger_entry',
      "UPDATE ledger.ledger_entry SET amount_minor=amount_minor+1 WHERE journal_id IN(SELECT id FROM ledger.ledger_transaction WHERE book_id=$1) AND side='debit'",
      [f.book],
      'INTEGRITY_LEDGER',
    ],
    [
      'reconciliation.outcome',
      'DELETE FROM reconciliation.outcome WHERE run_id=$1',
      [r.id],
      'INTEGRITY_RECONCILIATION',
    ],
    [
      'reconciliation.match_group_member',
      "UPDATE reconciliation.match_group_member SET signed_amount_minor=signed_amount_minor+1 WHERE run_id=$1 AND role='PROCESSOR_SETTLEMENT'",
      [r.id],
      'ALLOCATION_CONSERVATION',
    ],
    [
      'worker.attempt_event',
      'DELETE FROM worker.attempt_event WHERE work_id IN(SELECT id FROM worker.status WHERE book_id=$1)',
      [f.book],
      'WORK_STATE_HISTORY',
    ],
  ];
  await new PostgresWorker(wp).processBatch('corruption-fixture', 100, f.book);
  for (const [table, sql, args, expected] of probes) {
    const c = await admin.connect();
    try {
      await c.query('BEGIN');
      await c.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
      await c.query(sql, args);
      const s = (
        await c.query<{ s: IntegritySummary }>(
          'SELECT integrity.sweep($1::uuid,$2::uuid[]) s',
          [f.book, [r.id]],
        )
      ).rows[0]!.s;
      assert(
        s.violations.some((v) => v.invariant === expected),
        expected + JSON.stringify(s.violations),
      );
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
    await clean(admin, f.book, [r.id]);
    await preserve();
  }
});

test('owner SQL and runtime capability attacks cannot rewrite cross-domain immutable history', async () => {
  const f = await fixture(admin, ip, pp, bp, { banks: [] }),
    r = await recon.run(f.command),
    ids = await exceptions.generate(r.id, 'resilience'),
    cs = await controls.run({
      bookId: f.book,
      runKey: 'attack-fixture',
      actorId: 'resilience',
      reconciliationRunIds: [r.id],
    }),
    j = await journal(f.book);
  await new PostgresLedger(lp).post(j);
  const preserve = await witness(admin);
  for (const [table, sql] of [
    [
      'ledger.ledger_entry',
      'UPDATE ledger.ledger_entry SET amount_minor=amount_minor+1 WHERE book_id=$1',
    ],
    [
      'ingestion.raw_record',
      'DELETE FROM ingestion.raw_record WHERE source_account_id IN(SELECT id FROM ingestion.source_account WHERE book_id=$1)',
    ],
    [
      'reconciliation.outcome',
      'DELETE FROM reconciliation.outcome WHERE run_id IN(SELECT rr.id FROM reconciliation.run rr JOIN reconciliation.account_mapping m ON m.id=rr.mapping_id WHERE m.book_id=$1)',
    ],
    [
      'exceptions.event',
      'DELETE FROM exceptions.event WHERE case_id IN(SELECT c.id FROM exceptions.case_record c JOIN reconciliation.account_mapping m ON m.id=c.mapping_id WHERE m.book_id=$1)',
    ],
    [
      'controls.result',
      "UPDATE controls.result SET status='PASS' WHERE run_id IN(SELECT id FROM controls.run WHERE book_id=$1)",
    ],
    [
      'outbox.outbox_event',
      "UPDATE outbox.outbox_event SET payload='{}'::jsonb WHERE book_id=$1",
    ],
  ] as const) {
    await assert.rejects(admin.query(sql, [f.book]), table);
    for (const p of [wp, rp, ep, cp])
      await assert.rejects(p.query(`DELETE FROM ${table}`), { code: '42501' });
  }
  assert(ids.length > 0);
  assert.equal((await controls.summary(cs.id)).state, 'COMPLETED');
  await preserve();
  await clean(admin, f.book, [r.id]);
});

for (const action of ['RESOLVE', 'CLASSIFY', 'ASSIGN'] as const)
  test(
    'accepted-risk resolution vs ' +
      action +
      ' preserves expected-version history and canonical unreconciled exposure',
    async () => {
      const f = await fixture(admin, ip, pp, bp, { banks: [] }),
        run = await recon.run(f.command),
        ids = await exceptions.generate(run.id, 'resilience');
      const view = await exceptions.apply(
          caseCommand(await exceptions.get(ids[0]!), 'START_REVIEW'),
        ),
        preserved = await witness(admin);
      const a = caseCommand(view, 'RESOLVE', { resolution: 'ACCEPTED_RISK' }),
        b = caseCommand(
          view,
          action,
          action === 'RESOLVE'
            ? { resolution: 'NOT_RECONCILED' }
            : action === 'ASSIGN'
              ? { assigneeId: 'other-reviewer' }
              : { classification: 'TIMING_LATE_ARRIVAL' },
        );
      const results = await contend(
        admin,
        f.book,
        [a, b].map((command) => ({
          pool: ep,
          run: (p) => new PostgresExceptions(p, ep).apply(command),
        })),
      );
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
      assert.equal((await exceptions.get(view.id)).version, view.version + 1);
      const health = await clean(admin, f.book, [run.id]);
      assert.equal(
        health.controls.find((c) => c.type === 'EXPOSURE')!.observed,
        '970000',
      );
      assert.equal((await recon.summary(run.id)).matchedGroups, 0);
      await preserved();
    },
  );

test('resolve vs reopen and supersession enforce explicit preconditions instead of scheduling away evidence', async () => {
  const f = await fixture(admin, ip, pp, bp, { banks: [] }),
    run = await recon.run(f.command),
    ids = await exceptions.generate(run.id, 'resilience');
  let view = await exceptions.apply(
    caseCommand(await exceptions.get(ids[0]!), 'START_REVIEW'),
  );
  view = await exceptions.apply(
    caseCommand(view, 'RESOLVE', { resolution: 'ACCEPTED_RISK' }),
  );
  const preserve = await witness(admin);
  await importEvidence(
    f.ingestion,
    f.processor,
    f.source,
    'synthetic-settlement',
    'synthetic-settlement-v1',
    [report('settlement', '970001')],
  );
  const changed = await recon.run({ ...f.command, runKey: 'changed' });
  const reopen = caseCommand(view, 'REOPEN', { evidenceRunId: changed.id }),
    invalidResolve = caseCommand(view, 'RESOLVE', {
      resolution: 'ACCEPTED_RISK',
    });
  const results = await contend(
    admin,
    f.book,
    [reopen, invalidResolve].map((command) => ({
      pool: ep,
      run: (p) => new PostgresExceptions(p, ep).apply(command),
    })),
  );
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal((await exceptions.get(view.id)).state, 'UNDER_REVIEW');
  await preserve();
  await clean(admin, f.book, [changed.id]);
  const g = await fixture(admin, ip, pp, bp, { banks: [] }),
    old = await recon.run(g.command),
    cids = await exceptions.generate(old.id, 'resilience');
  let c = await exceptions.apply(
    caseCommand(await exceptions.get(cids[0]!), 'START_REVIEW'),
  );
  c = await exceptions.apply(
    caseCommand(c, 'RESOLVE', { resolution: 'ACCEPTED_RISK' }),
  );
  const retained = await witness(admin);
  await importEvidence(
    g.ingestion,
    g.bank,
    g.bankSource,
    'synthetic-bank-entry',
    'synthetic-bank-entry-v1',
    [entry()],
  );
  const later = await recon.run({ ...g.command, runKey: 'verified' });
  const commands = [
    caseCommand(c, 'SUPERSEDE', { evidenceRunId: later.id }),
    caseCommand(c, 'RESOLVE', { resolution: 'NOT_RECONCILED' }),
  ];
  const superseded = await contend(
    admin,
    g.book,
    commands.map((command) => ({
      pool: ep,
      run: (p) => new PostgresExceptions(p, ep).apply(command),
    })),
  );
  assert.equal(superseded.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal((await exceptions.get(c.id)).resolution, 'FIXED_AND_VERIFIED');
  await retained();
  await clean(admin, g.book, [later.id]);
});

test('accepted risk vs reconciliation and control freeze keeps one canonical exposure and coherent immutable inputs', async () => {
  const f = await fixture(admin, ip, pp, bp, { banks: [] }),
    old = await recon.run(f.command),
    ids = await exceptions.generate(old.id, 'resilience');
  const view = await exceptions.apply(
    caseCommand(await exceptions.get(ids[0]!), 'START_REVIEW'),
  );
  await importEvidence(
    f.ingestion,
    f.bank,
    f.bankSource,
    'synthetic-bank-entry',
    'synthetic-bank-entry-v1',
    [entry()],
  );
  const next = await recon.create({ ...f.command, runKey: 'race' });
  await recon.seal(next);
  await recon.plan(next);
  while (await recon.advance(next)) {}
  const cid = await controls.create({
      bookId: f.book,
      runKey: 'race',
      actorId: 'resilience',
      reconciliationRunIds: [next],
    }),
    preserve = await witness(admin);
  const results = await contend(admin, f.book, [
    { pool: rp, run: (p) => new PostgresReconciliation(p).complete(next) },
    {
      pool: ep,
      run: (p) =>
        new PostgresExceptions(p, ep).apply(
          caseCommand(view, 'RESOLVE', { resolution: 'ACCEPTED_RISK' }),
        ),
    },
    { pool: cp, run: (p) => new PostgresControls(p).freeze(cid) },
  ]);
  assert(results.every((r) => r.status === 'fulfilled'));
  while (await controls.evaluate(cid)) {}
  await controls.complete(cid);
  const c = await controls.summary(cid);
  assert(
    c.results
      .filter((r) => r.type === 'PROCESSING_PARTITION')
      .every((r) => r.status === 'PASS'),
  );
  const exposure = c.results.find((r) => r.type === 'EXPOSURE')!;
  assert(['0', null].includes(exposure.observed));
  assert.equal((await exceptions.get(view.id)).resolution, 'ACCEPTED_RISK');
  assert.equal((await exceptions.get(view.id)).currentlyReconciled, true);
  assert.equal(
    (
      await admin.query(
        'SELECT count(*)::int n FROM reconciliation.active_allocation a JOIN reconciliation.match_group g ON g.id=a.group_id WHERE g.run_id=$1',
        [next],
      )
    ).rows[0].n,
    2,
  );
  await clean(admin, f.book, [next]);
  await preserve();
});

test('worker normalization racing control freeze cannot produce a mixed snapshot or turn UNKNOWN source closure into PASS', async () => {
  const f = await fixture(admin, ip, pp, bp, { reports: [], banks: [] }),
    worker = new PostgresWorker(wp);
  await worker.processBatch('drain-fixture', 100, f.book);
  const b = await pending(f),
    claim = await worker.claim('snapshot-handler', f.book);
  assert(claim);
  const cid = await controls.create({
    bookId: f.book,
    runKey: 'normalization-race',
    actorId: 'resilience',
    reconciliationRunIds: [],
  });
  const holder = await admin.connect();
  let pid = 0;
  try {
    await holder.query('BEGIN');
    await holder.query(
      'SELECT id FROM ingestion.source_account WHERE id=$1 FOR UPDATE',
      [f.source],
    );
    const blocked = intercepted(cp, async (text, c, execute) => {
      if (text.startsWith('BEGIN'))
        pid = (await c.query<{ pid: number }>('SELECT pg_backend_pid() pid'))
          .rows[0]!.pid;
      return execute();
    });
    const freeze = new PostgresControls(blocked).freeze(cid);
    while (!pid) await admin.query('SELECT 1');
    await waitForLocks(admin, [pid]);
    await worker.handle(claim);
    await worker.finish(claim);
    await holder.query('COMMIT');
    await freeze;
    while (await controls.evaluate(cid)) {}
    await controls.complete(cid);
    const s = await controls.summary(cid),
      partition = s.results.find(
        (r) => r.key === 'partition:' + b.id + ':synthetic-movement-v1',
      )!;
    assert.equal(partition.details['pending'], 1);
    assert.equal(partition.details['normalized'], 0);
    assert.equal(s.current, false);
    await f.processor.deriveBatch(b.id, 'synthetic-movement-v1');
    const health = await clean(admin, f.book);
    assert.equal(
      health.work.pending + health.work.processing + health.work.retryable,
      0,
    );
    assert.equal(health.financialAssurance, 'UNKNOWN');
    assert(
      health.controls
        .filter((control) => control.type === 'SOURCE_PERIOD')
        .every((control) => control.status === 'UNKNOWN'),
    );
  } finally {
    await holder.query('ROLLBACK').catch(() => {});
    holder.release();
  }
});

test('rollback-only exposure corruption reports stable identities without leaking payload and restores the original evaluator', async () => {
  const f = await fixture(admin, ip, pp, bp, { banks: [] }),
    run = await recon.run(f.command),
    preserve = await witness(admin),
    c = await admin.connect();
  try {
    await c.query('BEGIN');
    await c.query(
      `CREATE OR REPLACE FUNCTION controls.exposure(rid uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog,pg_temp AS $$ BEGIN RETURN '{"state":"COMPLETED","components":[{"identity":"duplicate","amountMinor":"1","acceptedRisk":true},{"identity":"duplicate","amountMinor":"1","acceptedRisk":true}],"unreconciledMinor":"1","acceptedRiskMinor":"2","knownUnreconciledMinor":"1","knownAcceptedRiskMinor":"2","unknownCount":0}'::jsonb; END $$`,
    );
    const s = (
      await c.query<{ s: IntegritySummary }>(
        'SELECT integrity.sweep($1::uuid,$2::uuid[]) s',
        [f.book, [run.id]],
      )
    ).rows[0]!.s;
    assert(s.violations.some((v) => v.invariant === 'EXPOSURE_CANONICAL'));
    assert(
      s.violations.every((v) => !JSON.stringify(v).includes('payload_bytes')),
    );
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
  await clean(admin, f.book, [run.id]);
  await preserve();
});

test('30 deterministic replay schedules preserve monotonic work attempts, one semantic output and independent integrity', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.boolean(), { minLength: 1, maxLength: 3 }),
      async (schedule) => {
        const f = await fixture(admin, ip, pp, bp, { reports: [], banks: [] }),
          worker = new PostgresWorker(wp);
        await worker.processBatch('fixture-drain', 100, f.book);
        await admin.query(
          'UPDATE worker.policy SET base_delay_ms=5,max_delay_ms=20 WHERE id=1',
        );
        try {
          const b = await pending(f);
          let attempt = 0;
          for (const replay of schedule) {
            const c = await worker.claim('property', f.book);
            assert(c);
            assert.equal(c.attempt, attempt + 1);
            attempt = c.attempt;
            await worker.handle(c);
            if (replay) await worker.handle(c);
            assert(
              await worker.finish(c, {
                classification: 'TRANSIENT',
                code: '08006',
              }),
            );
            await waitDue(admin, f.book);
          }
          await worker.processBatch('property-drain', 100, f.book);
          const s = await clean(admin, f.book);
          assert.equal(
            s.work.pending + s.work.processing + s.work.retryable,
            0,
          );
          assert.equal(
            (
              await admin.query(
                'SELECT count(*)::int n FROM ingestion.interpretation i JOIN ingestion.raw_record raw ON raw.revision_id=i.revision_id WHERE raw.batch_id=$1',
                [b.id],
              )
            ).rows[0].n,
            1,
          );
        } finally {
          await admin.query(
            'UPDATE worker.policy SET base_delay_ms=100,max_delay_ms=30000 WHERE id=1',
          );
        }
      },
    ),
    { numRuns: 30, seed: 71111 },
  );
});
