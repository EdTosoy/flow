import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { Pool } from 'pg';
import fc from 'fast-check';
import { Money } from '@flow/money';
import { PostgresControls, UnknownControlCommit } from '@flow/control-postgres';
import {
  serializeControl,
  type ControlCommand,
  type ControlSummary,
} from '@flow/control-domain';
import { PostgresReconciliation } from '@flow/reconciliation-postgres';
import { PostgresExceptions } from '@flow/exception-postgres';
import { PostgresLedger } from '@flow/ledger-postgres';
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
const cu = process.env['FLOW_TEST_CONTROL_URL']!;
if (!cu) throw new Error('Run pnpm test:integration');
const admin = new Pool({
    connectionString: process.env['FLOW_TEST_ADMIN_URL'],
  }),
  cp = new Pool({ connectionString: cu, max: 16 }),
  ip = new Pool({ connectionString: process.env['FLOW_TEST_INGESTION_URL'] }),
  pp = new Pool({ connectionString: process.env['FLOW_TEST_PROCESSOR_URL'] }),
  bp = new Pool({ connectionString: process.env['FLOW_TEST_BANK_URL'] }),
  rp = new Pool({
    connectionString: process.env['FLOW_TEST_RECONCILIATION_URL'],
  }),
  ep = new Pool({ connectionString: process.env['FLOW_TEST_EXCEPTION_URL'] }),
  lp = new Pool({ connectionString: process.env['FLOW_TEST_WRITER_URL'] });
const controls = new PostgresControls(cp),
  recon = new PostgresReconciliation(rp),
  exceptions = new PostgresExceptions(ep);
after(async () => {
  await Promise.all([admin, cp, ip, pp, bp, rp, ep, lp].map((p) => p.end()));
});
const command = (
  book: string,
  runs: readonly string[],
  extra: Partial<ControlCommand> = {},
): ControlCommand => ({
  bookId: book,
  runKey: randomUUID(),
  actorId: 'phase9-controller',
  reconciliationRunIds: runs,
  ...extra,
});
const result = (s: ControlSummary, type: string) =>
  s.results.filter((r) => r.type === type);
async function setup(options: Parameters<typeof fixture>[4] = {}) {
  const f = await fixture(admin, ip, pp, bp, options),
    run = await recon.run(f.command);
  return { ...f, run };
}
test('an empty book without configured source scopes cannot claim proven completeness', async () => {
  const book = randomUUID();
  await admin.query(
    "INSERT INTO ledger.book(id,code,environment) VALUES($1,$2,'synthetic')",
    [book, 'unconfigured-' + book],
  );
  const c = command(book, []),
    s = await controls.run(c);
  assert.equal(s.state, 'COMPLETED');
  assert.equal(s.current, true);
  assert.equal(s.assurance, 'UNKNOWN');
  assert.equal(result(s, 'SOURCE_PERIOD').length, 1);
  const unknown = result(s, 'SOURCE_PERIOD')[0]!;
  assert.equal(unknown.status, 'UNKNOWN');
  assert.equal(unknown.expected, null);
  assert.equal(unknown.observed, null);
  assert.equal(
    unknown.details['reason'],
    'NO_CONFIGURED_SOURCE_SCOPE_OR_INDEPENDENT_PERIOD_CLOSURE',
  );
  assert.equal((await controls.run(c)).id, s.id);
});
test('frozen versioned controls expose unknown source closure alongside valid matches, exact totals and partitions', async () => {
  const f = await setup(),
    c = command(f.book, [f.run.id]),
    s = await controls.run(c);
  assert.equal(s.state, 'COMPLETED');
  assert.equal(s.assurance, 'UNKNOWN');
  assert.equal(s.current, true);
  assert(result(s, 'SOURCE').every((r) => r.status === 'UNKNOWN'));
  assert(result(s, 'RECONCILIATION').every((r) => r.status === 'PASS'));
  assert(result(s, 'ALLOCATION').every((r) => r.status === 'PASS'));
  assert(
    result(s, 'PROCESSOR_TOTAL').every(
      (r) =>
        r.status === 'PASS' &&
        r.expected === '970000' &&
        r.observed === '970000' &&
        r.discrepancy === '0',
    ),
  );
  assert.equal(result(s, 'EXPOSURE')[0]!.observed, '0');
  assert.equal((await controls.run(c)).id, s.id);
  assert.equal(
    (
      await admin.query(
        'SELECT count(*)::integer AS n FROM audit.audit_event WHERE control_run_id=$1',
        [s.id],
      )
    ).rows[0].n,
    1,
  );
});
test('dangerous false green: 10000 independently expected, 9998 received and fully normalized still FAIL', async () => {
  const f = await setup();
  const body = {
    id: 'delivered-activity',
    kind: 'capture',
    paymentReference: 'separate-payment',
    parentCaptureId: null,
    amount: money('1'),
    occurredAt: '2026-01-01T00:00:00.000Z',
  };
  const b = await f.ingestion.ingest({
    sourceAccountId: f.source,
    batchKey: randomUUID(),
    actorId: 'independent-manifest',
    provenance: { adapterVersion: 'phase9-source-v1' },
    expectedCount: 10000,
    records: Array.from({ length: 9998 }, (_, i) => ({
      locator: String(i),
      objectKind: 'synthetic-movement',
      externalId: body.id + '-' + i,
      sourceRevision: null,
      sequence: null,
      sourceObservedAt: null,
      bytes: Buffer.from(JSON.stringify({ ...body, id: body.id + '-' + i })),
    })),
  });
  const rawIds = (
    await admin.query<{ id: string }>(
      'SELECT id FROM ingestion.raw_record WHERE batch_id=$1 ORDER BY receipt_order',
      [b.id],
    )
  ).rows;
  for (let offset = 0; offset < rawIds.length; offset += 32)
    await Promise.all(
      rawIds
        .slice(offset, offset + 32)
        .map((r) => f.ingestion.normalizeRaw(r.id, 'synthetic-movement-v1')),
    );
  const s = await controls.run(command(f.book, [f.run.id]));
  const source = s.results.find((r) => r.key === 'source:' + b.id)!;
  assert.equal(source.status, 'FAIL');
  assert.equal(source.expected, '10000');
  assert.equal(source.observed, '9998');
  assert.equal(source.discrepancy, '-2');
  assert.equal(s.assurance, 'FAIL');
  const partition = s.results.find(
    (r) => r.key === 'partition:' + b.id + ':synthetic-movement-v1',
  )!;
  assert.equal(partition.status, 'PASS');
  assert.equal(partition.details['normalized'], 9998);
  assert.equal(partition.details['failed'], 0);
  assert.equal(partition.details['pending'], 0);
});
test('all individual matches valid, independent unrelated bank closing disagrees: aggregate FAIL stays visible', async () => {
  const f = await setup();
  await importEvidence(
    f.ingestion,
    f.bank,
    f.bankSource,
    'synthetic-bank-entry',
    'synthetic-bank-entry-v1',
    [
      entry('statement-line', '100', 'unrelated', {
        statementReference: 'statement',
        lineIdentity: 'line-1',
        sequence: 1,
      }),
    ],
  );
  const st = await importEvidence(
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
        opening: money('9007199254740993'),
        closing: money('9007199254741094'),
        expectedLineCount: 1,
        lineIds: ['line-1'],
        sequenceRange: { from: 1, to: 1 },
      },
    ],
  );
  const s = await controls.run(command(f.book, [f.run.id]));
  assert.equal(
    f.run.outcomes
      .filter((c) => c.outcome === 'MATCHED')
      .reduce((n, c) => n + c.count, 0),
    2,
  );
  assert.equal(
    result(s, 'BANK_TOTAL').find(
      (r) => r.scope['bankStatementId'] === st[0]!.id,
    )!.discrepancy,
    '1',
  );
  assert.equal(result(s, 'BANK_TOTAL')[0]!.status, 'FAIL');
  assert.equal(s.assurance, 'FAIL');
  assert.equal(
    (await recon.summary(f.run.id)).current.find((g) => g.status === 'ACTIVE')
      ?.count,
    1,
  );
});
test('canonical mismatch counts one residual despite two cases; accepted risk is a subset of unreconciled value', async () => {
  const f = await setup({ banks: [entry('bank', '970017')] });
  const ids = await exceptions.generate(f.run.id, 'system');
  assert.equal(ids.length, 2);
  let c = await exceptions.get(ids[0]!);
  c = await exceptions.apply({
    caseId: c.id,
    commandKey: 'review',
    expectedVersion: c.version,
    action: 'START_REVIEW',
    actorId: 'reviewer',
    reason: 'Synthetic review',
  });
  await exceptions.apply({
    caseId: c.id,
    commandKey: 'risk',
    expectedVersion: c.version,
    action: 'RESOLVE',
    resolution: 'ACCEPTED_RISK',
    actorId: 'reviewer',
    reason: 'Documented discrepancy accepted operationally',
  });
  const s = await controls.run(
      command(f.book, [f.run.id], { createCases: true }),
    ),
    ex = result(s, 'EXPOSURE')[0]!;
  assert.equal(ex.observed, '17');
  assert.equal(ex.details['acceptedRiskMinor'], '17');
  assert.equal((ex.details['components'] as unknown[]).length, 1);
  assert.equal(s.exposure[0]!['unreconciledMinor'], '17');
  assert.equal(
    (
      await admin.query(
        'SELECT count(*)::integer AS n FROM reconciliation.current_allocation ca JOIN reconciliation.match_group g ON g.id=ca.group_id JOIN reconciliation.run r ON r.id=g.run_id WHERE r.mapping_id=$1',
        [f.mappingId],
      )
    ).rows[0].n,
    0,
  );
});
test('ambiguous grouped/pair and ineligible evidence have unknown exposure, never invented zero assurance', async () => {
  for (const options of [
    { banks: [entry('bank'), entry('bank-2')] },
    { reports: [report('settlement', '970017')] },
  ]) {
    const f = await setup(options),
      s = await controls.run(command(f.book, [f.run.id]));
    const ex = result(s, 'EXPOSURE')[0]!;
    assert.equal(ex.status, 'UNKNOWN');
    assert(Number(ex.details['unknownCount']) > 0);
    assert.equal(ex.observed, null);
  }
});
test('processing backlog/failure and missing domain derivation are independently visible', async () => {
  const f = await setup();
  const b = await f.ingestion.ingest({
    sourceAccountId: f.source,
    batchKey: randomUUID(),
    actorId: 'source',
    provenance: { adapterVersion: 'v1' },
    expectedCount: 2,
    records: [
      {
        locator: 'bad',
        objectKind: 'synthetic-movement',
        externalId: 'bad',
        sourceRevision: null,
        sequence: null,
        sourceObservedAt: null,
        bytes: Buffer.from('{broken'),
      },
      {
        locator: 'good',
        objectKind: 'synthetic-movement',
        externalId: 'good',
        sourceRevision: null,
        sequence: null,
        sourceObservedAt: null,
        bytes: Buffer.from(
          JSON.stringify({
            id: 'good',
            kind: 'capture',
            paymentReference: 'new-payment',
            parentCaptureId: null,
            amount: money('9007199254740993'),
            occurredAt: '2026-01-01T00:00:00.000Z',
          }),
        ),
      },
    ],
  });
  const pending = await controls.run(command(f.book, [f.run.id]));
  assert.equal(
    pending.results.find((r) => r.key === 'source:' + b.id)!.status,
    'PASS',
  );
  assert.equal(
    pending.results.find(
      (r) => r.key === 'processing:' + b.id + ':synthetic-movement-v1',
    )!.status,
    'UNKNOWN',
  );
  await f.ingestion.normalizeBatch(b.id);
  const processed = await controls.run(command(f.book, [f.run.id]));
  assert.equal(
    processed.results.find(
      (r) => r.key === 'partition:' + b.id + ':synthetic-movement-v1',
    )!.status,
    'PASS',
  );
  assert.equal(
    processed.results.find(
      (r) => r.key === 'processing:' + b.id + ':synthetic-movement-v1',
    )!.status,
    'FAIL',
  );
  assert(
    result(processed, 'PROCESSOR_COVERAGE').some((r) => r.status === 'FAIL'),
  );
  assert.equal((await controls.summary(pending.id)).current, false);
});
test('completed history remains immutable through late arrivals, correction, new runs and stale selection', async () => {
  const f = await setup({ banks: [] }),
    s = await controls.run(command(f.book, [f.run.id]));
  const before = JSON.stringify(s.results);
  await importEvidence(
    f.ingestion,
    f.bank,
    f.bankSource,
    'synthetic-bank-entry',
    'synthetic-bank-entry-v1',
    [entry()],
  );
  const old = await controls.summary(s.id);
  assert.equal(JSON.stringify(old.results), before);
  assert.equal(old.current, false);
  const stale = await controls.run(command(f.book, [f.run.id]));
  assert.equal(stale.exposure[0]!['unreconciledMinor'], null);
  assert.equal(stale.exposure[0]!['selectionStale'], true);
  const newRun = await recon.run({ ...f.command, runKey: 'late' }),
    fresh = await controls.run(command(f.book, [newRun.id]));
  assert.equal(fresh.exposure[0]!['unreconciledMinor'], '0');
  await importEvidence(
    f.ingestion,
    f.bank,
    f.bankSource,
    'synthetic-bank-entry',
    'synthetic-bank-entry-v1',
    [entry('bank', '970001')],
  );
  const corrected = await controls.run(command(f.book, [newRun.id]));
  assert(result(corrected, 'ALLOCATION').some((r) => r.status === 'FAIL'));
  assert(result(corrected, 'FRESHNESS').some((r) => r.status === 'FAIL'));
  assert.equal(JSON.stringify((await controls.summary(s.id)).results), before);
});
test('real ledger integrity retains separate debit and credit exact totals for each journal/currency', async () => {
  const f = await setup(),
    ledger = new PostgresLedger(lp);
  for (const currency of ['PHP', 'USD'] as const) {
    const accounts = await Promise.all([
      ledger.createAccount({
        bookId: f.book,
        code: currency + '-asset',
        currency,
        classification: 'asset',
        normalSide: 'debit',
        commandKey: randomUUID(),
        actorId: 'system',
        reason: 'synthetic account',
      }),
      ledger.createAccount({
        bookId: f.book,
        code: currency + '-equity',
        currency,
        classification: 'equity',
        normalSide: 'credit',
        commandKey: randomUUID(),
        actorId: 'system',
        reason: 'synthetic account',
      }),
    ]);
    await ledger.post({
      bookId: f.book,
      currency,
      commandKey: randomUUID(),
      effectNamespace: 'phase9',
      businessEffectKey: currency,
      effectiveAt: '2026-01-01T00:00:00.000Z',
      policyVersion: 'phase9-generic',
      actorId: 'system',
      reason: 'synthetic balanced journal',
      entries: [
        {
          accountId: accounts[0]!.id,
          side: 'debit',
          money: Money.of(9007199254740993n, currency),
        },
        {
          accountId: accounts[1]!.id,
          side: 'credit',
          money: Money.of(9007199254740993n, currency),
        },
      ],
    });
  }
  const s = await controls.run(command(f.book, [f.run.id])),
    totals = result(s, 'LEDGER').filter((r) => r.currency !== null);
  assert.equal(totals.length, 2);
  assert(
    totals.every(
      (r) =>
        r.status === 'PASS' &&
        r.expected === '9007199254740993' &&
        r.observed === '9007199254740993',
    ),
  );
});
async function blocked<T>(book: string, tasks: readonly (() => Promise<T>)[]) {
  const holder = await admin.connect();
  await holder.query('BEGIN');
  await holder.query('SELECT FROM ledger.book WHERE id=$1 FOR NO KEY UPDATE', [
    book,
  ]);
  const promises = tasks.map((t) => t());
  try {
    let waiting = 0;
    for (let i = 0; i < 200; i++) {
      waiting = (
        await admin.query(
          "SELECT count(*)::integer AS n FROM pg_stat_activity WHERE wait_event_type='Lock' AND (query LIKE '%controls.%' OR query LIKE '%exceptions.%' OR query LIKE '%reconciliation.%')",
        )
      ).rows[0].n;
      if (waiting >= tasks.length) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert(waiting >= tasks.length, 'All competitors observed blocked');
    await holder.query('COMMIT');
    return await Promise.allSettled(promises);
  } finally {
    await holder.query('ROLLBACK');
    holder.release();
  }
}
test('eight observed blocked duplicate run/case evaluations converge to one historical result and companions', async () => {
  const f = await setup({ banks: [] }),
    c = command(f.book, [f.run.id], { createCases: true });
  const outcomes = await blocked(
    f.book,
    Array.from({ length: 8 }, () => () => controls.run(c)),
  );
  assert(outcomes.every((o) => o.status === 'fulfilled'));
  const ids = outcomes.map(
    (o) => (o as PromiseFulfilledResult<ControlSummary>).value.id,
  );
  assert.equal(new Set(ids).size, 1);
  const s = await controls.summary(ids[0]!);
  assert.equal(s.cases.length, 1);
  assert.equal(
    (
      await admin.query(
        'SELECT count(*)::integer AS n FROM exceptions.case_record WHERE mapping_id=$1',
        [f.mappingId],
      )
    ).rows[0].n,
    1,
  );
  assert.equal(
    (
      await admin.query(
        'SELECT count(*)::integer AS n FROM outbox.outbox_event WHERE control_run_id=$1',
        [s.id],
      )
    ).rows[0].n,
    1,
  );
});
test('concurrent different control histories associate one unresolved case without duplicate creation', async () => {
  const f = await setup({ banks: [] });
  const outcomes = await blocked(f.book, [
    () => controls.run(command(f.book, [f.run.id], { createCases: true })),
    () => controls.run(command(f.book, [f.run.id], { createCases: true })),
  ]);
  assert(outcomes.every((o) => o.status === 'fulfilled'));
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
test('accepted-risk resolution racing freeze records a coherent before/after event without changing financial exposure', async () => {
  const f = await setup({ banks: [] }),
    ids = await exceptions.generate(f.run.id, 'system');
  let c = await exceptions.get(ids[0]!);
  c = await exceptions.apply({
    caseId: c.id,
    commandKey: 'start',
    expectedVersion: c.version,
    action: 'START_REVIEW',
    actorId: 'reviewer',
    reason: 'Synthetic review',
  });
  const id = await controls.create(command(f.book, [f.run.id]));
  const race = await blocked(f.book, [
    () => controls.freeze(id),
    () =>
      exceptions
        .apply({
          caseId: c.id,
          commandKey: 'resolve',
          expectedVersion: c.version,
          action: 'RESOLVE',
          resolution: 'ACCEPTED_RISK',
          actorId: 'reviewer',
          reason: 'Accepted synthetic risk',
        })
        .then(() => {}),
  ]);
  assert(race.every((r) => r.status === 'fulfilled'));
  while (await controls.evaluate(id)) {}
  await controls.complete(id);
  const ex = result(await controls.summary(id), 'EXPOSURE')[0]!;
  assert.equal(ex.observed, '970000');
  assert(['0', '970000'].includes(String(ex.details['acceptedRiskMinor'])));
  const components = ex.details['components'] as {
    caseEvents: { state: string; resolution: string | null }[];
    acceptedRisk: boolean;
  }[];
  assert.equal(
    components[0]!.acceptedRisk,
    components[0]!.caseEvents[0]!.resolution === 'ACCEPTED_RISK',
  );
});
test('source ingestion racing freeze cannot mix record populations and dispositions', async () => {
  const f = await setup({ banks: [] }),
    id = await controls.create(command(f.book, [f.run.id])),
    holder = await admin.connect();
  await holder.query('BEGIN');
  await holder.query(
    'SELECT FROM ingestion.source_account WHERE id=$1 FOR UPDATE',
    [f.bankSource],
  );
  const freeze = controls.freeze(id),
    arrival = importEvidence(
      f.ingestion,
      f.bank,
      f.bankSource,
      'synthetic-bank-entry',
      'synthetic-bank-entry-v1',
      [entry()],
    );
  let n = 0;
  for (let i = 0; i < 200; i++) {
    n = (
      await admin.query(
        "SELECT count(*)::integer AS n FROM pg_stat_activity WHERE wait_event_type='Lock'",
      )
    ).rows[0].n;
    if (n >= 2) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert(n >= 2);
  await holder.query('COMMIT');
  holder.release();
  await Promise.all([freeze, arrival]);
  while (await controls.evaluate(id)) {}
  await controls.complete(id);
  const s = await controls.summary(id);
  assert(result(s, 'PROCESSING_PARTITION').every((r) => r.status === 'PASS'));
  assert.equal(s.exposure[0]!['unreconciledMinor'], '970000');
  assert.equal(s.current, false);
});
test('reconciliation completion racing freeze preserves incomplete UNKNOWN until a fresh evaluation', async () => {
  const f = await fixture(admin, ip, pp, bp),
    rr = await recon.create(f.command);
  await recon.seal(rr);
  await recon.plan(rr);
  while (await recon.advance(rr)) {}
  const id = await controls.create(command(f.book, [rr])),
    holder = await admin.connect();
  await holder.query('BEGIN');
  await holder.query(
    'SELECT FROM ingestion.source_account WHERE id=$1 FOR UPDATE',
    [f.source],
  );
  const freezing = controls.freeze(id);
  try {
    let waiting = 0;
    for (let i = 0; i < 200; i++) {
      waiting = (
        await admin.query(
          "SELECT count(*)::integer AS n FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%controls.freeze%'",
        )
      ).rows[0].n;
      if (waiting) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert(waiting);
    const completion = recon.complete(rr);
    await holder.query('COMMIT');
    await Promise.all([freezing, completion]);
  } finally {
    await holder.query('ROLLBACK');
    holder.release();
  }
  while (await controls.evaluate(id)) {}
  await controls.complete(id);
  const s = await controls.summary(id);
  assert(
    result(s, 'RECONCILIATION')
      .filter((r) => r.key.startsWith('reconciliation:'))
      .every((r) => r.status === 'UNKNOWN'),
  );
  const fresh = await controls.run(command(f.book, [rr]));
  assert(result(fresh, 'RECONCILIATION').every((r) => r.status === 'PASS'));
});
test('durable DRAFT, SEALED and partial EVALUATING runs cannot falsely complete and retries resume', async () => {
  const f = await setup(),
    c = command(f.book, [f.run.id]),
    id = await controls.create(c);
  assert.equal((await controls.summary(id)).state, 'DRAFT');
  await assert.rejects(() => controls.complete(id));
  await controls.freeze(id);
  assert.equal((await controls.summary(id)).state, 'SEALED');
  await controls.evaluate(id, 1);
  await assert.rejects(() => controls.complete(id));
  assert.equal((await controls.summary(id)).state, 'EVALUATING');
  const recovered = await controls.run(c);
  assert.equal(recovered.id, id);
  assert.equal(recovered.state, 'COMPLETED');
});
test('critical database history, result forgery, capability and identity controls reject bypasses', async () => {
  const f = await setup(),
    c = command(f.book, [f.run.id]),
    s = await controls.run(c);
  await assert.rejects(
    () => controls.create({ ...c, maxAgeSeconds: 42 }),
    (e) => (e as { code: string }).code === 'P9001',
  );
  await assert.rejects(() =>
    controls.create({ ...c, reconciliationRunIds: [f.run.id, f.run.id] }),
  );
  const foreign = await setup();
  await assert.rejects(() =>
    controls.create(command(f.book, [foreign.run.id])),
  );
  for (const q of [
    'UPDATE controls.run SET actor_id=actor_id WHERE id=$1',
    'DELETE FROM controls.run WHERE id=$1',
    'UPDATE controls.result SET expected=0 WHERE run_id=$1',
    'DELETE FROM controls.input WHERE run_id=$1',
  ])
    await assert.rejects(() => admin.query(q, [s.id]));
  await assert.rejects(() => admin.query('TRUNCATE controls.result'));
  await assert.rejects(() =>
    cp.query('DELETE FROM controls.run WHERE id=$1', [s.id]),
  );
  await assert.rejects(() =>
    cp.query("SELECT ledger.post_journal('{}'::jsonb)"),
  );
  await assert.rejects(() => cp.query("SELECT exceptions.apply('{}'::jsonb)"));
  const id = await controls.create(command(f.book, [f.run.id]));
  await controls.freeze(id);
  await controls.evaluate(id, 1);
  const input = (
    await admin.query(
      'SELECT key,payload FROM controls.input i WHERE run_id=$1 AND NOT EXISTS(SELECT FROM controls.result r WHERE r.run_id=i.run_id AND r.key=i.key) LIMIT 1',
      [id],
    )
  ).rows[0];
  await assert.rejects(() =>
    admin.query(
      "INSERT INTO controls.result(run_id,key,result,status,severity) VALUES($1,$2,$3,'PASS','ERROR')",
      [id, input.key, { ...input.payload, status: 'PASS' }],
    ),
  );
});
test('audit/outbox and optional case-link failures roll back completion, keeping retryable durable progress', async () => {
  const f = await setup({ banks: [] }),
    c = command(f.book, [f.run.id], { createCases: true }),
    id = await controls.create(c);
  await controls.freeze(id);
  while (await controls.evaluate(id)) {}
  for (const table of [
    'audit.audit_event',
    'outbox.outbox_event',
    'controls.case_link',
  ]) {
    await admin.query(
      "CREATE FUNCTION public.phase9_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION USING ERRCODE='P9004',MESSAGE='Synthetic failure'; END $$",
    );
    await admin.query(
      `CREATE TRIGGER phase9_fail BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION public.phase9_fail()`,
    );
    try {
      await assert.rejects(() => controls.complete(id));
      assert.equal((await controls.summary(id)).state, 'EVALUATING');
      assert.equal(
        (
          await admin.query(
            'SELECT count(*)::integer AS n FROM exceptions.case_record WHERE mapping_id=$1',
            [f.mappingId],
          )
        ).rows[0].n,
        0,
      );
    } finally {
      await admin.query(`DROP TRIGGER phase9_fail ON ${table}`);
      await admin.query('DROP FUNCTION public.phase9_fail()');
    }
  }
  await controls.complete(id);
  assert.equal((await controls.summary(id)).state, 'COMPLETED');
});
test('missing deferred audit companion cannot commit completed state', async () => {
  const f = await setup(),
    id = await controls.create(command(f.book, [f.run.id]));
  await controls.freeze(id);
  while (await controls.evaluate(id)) {}
  await admin.query(
    'CREATE FUNCTION public.phase9_skip() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.control_run_id IS NOT NULL THEN RETURN NULL; END IF; RETURN NEW; END $$',
  );
  await admin.query(
    'CREATE TRIGGER phase9_skip BEFORE INSERT ON audit.audit_event FOR EACH ROW EXECUTE FUNCTION public.phase9_skip()',
  );
  try {
    await assert.rejects(
      () => controls.complete(id),
      (e) => (e as { code: string }).code === 'P9004',
    );
    assert.equal((await controls.summary(id)).state, 'EVALUATING');
  } finally {
    await admin.query('DROP TRIGGER phase9_skip ON audit.audit_event');
    await admin.query('DROP FUNCTION public.phase9_skip()');
  }
  await controls.complete(id);
});
test('actual lost successful COMMIT acknowledgements recover create, freeze, partial results and completed cases once', async () => {
  const f = await setup({ banks: [] }),
    c = command(f.book, [f.run.id], { createCases: true });
  for (const stage of ['create', 'freeze', 'evaluate', 'complete']) {
    let id =
      stage === 'create'
        ? ''
        : await controls.create({ ...c, runKey: c.runKey + ':' + stage });
    if (stage === 'evaluate' || stage === 'complete') await controls.freeze(id);
    if (stage === 'complete') while (await controls.evaluate(id)) {}
    const proxy = await commitDropProxy(cu),
      pool = new Pool({ connectionString: proxy.url });
    pool.on('error', () => {});
    const lost = new PostgresControls(pool);
    try {
      const op =
        stage === 'create'
          ? () => lost.create({ ...c, runKey: c.runKey + ':' + stage })
          : stage === 'freeze'
            ? () => lost.freeze(id)
            : stage === 'evaluate'
              ? () => lost.evaluate(id, 1)
              : () => lost.complete(id);
      await assert.rejects(op, UnknownControlCommit);
      await proxy.dropped;
      const s = await controls.run({ ...c, runKey: c.runKey + ':' + stage });
      id = s.id;
      assert.equal(s.state, 'COMPLETED');
      assert.equal(
        (
          await admin.query(
            'SELECT count(*)::integer AS n FROM outbox.outbox_event WHERE control_run_id=$1',
            [id],
          )
        ).rows[0].n,
        1,
      );
    } finally {
      await pool.end();
      await proxy.close();
    }
  }
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
test('20 real database trials preserve exact exposure, retry identity, partitions and immutable results', async () => {
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 1, max: 100000 }), async (n) => {
      const f = await setup({ banks: [entry('bank', String(970000 + n))] }),
        c = command(f.book, [f.run.id]),
        s = await controls.run(c);
      assert.equal(result(s, 'EXPOSURE')[0]!.observed, String(n));
      assert(result(s, 'RECONCILIATION').every((r) => r.status === 'PASS'));
      assert.equal(
        JSON.stringify((await controls.run(c)).results),
        JSON.stringify(s.results),
      );
    }),
    { numRuns: 20, seed: 70904 },
  );
});
test('unproven cross-side overlap retains separate claims and unknown aggregate rather than adding two descriptions of money', async () => {
  const f = await setup({
      banks: [entry('bank', '970000', 'different-reference')],
    }),
    s = await controls.run(command(f.book, [f.run.id]));
  const ex = s.exposure[0]!;
  assert.equal(ex['unreconciledMinor'], null);
  assert.equal(ex['processorClaimMinor'], '970000');
  assert.equal(ex['bankClaimMinor'], '970000');
  assert.equal(ex['status'], 'UNKNOWN');
});
test('failures within freeze/evaluation roll back every new child; previous durable partial results survive retry', async () => {
  const f = await setup(),
    c = command(f.book, [f.run.id]),
    id = await controls.create(c);
  for (const table of ['controls.input', 'controls.result']) {
    await admin.query(
      "CREATE FUNCTION public.phase9_stage_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION USING ERRCODE='P9004',MESSAGE='Synthetic stage crash'; END $$",
    );
    await admin.query(
      `CREATE TRIGGER phase9_stage_fail BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION public.phase9_stage_fail()`,
    );
    try {
      await assert.rejects(
        table === 'controls.input'
          ? () => controls.freeze(id)
          : () => controls.evaluate(id),
      );
      assert.equal(
        (await controls.summary(id)).state,
        table === 'controls.input' ? 'DRAFT' : 'SEALED',
      );
      assert.equal(
        (
          await admin.query(
            'SELECT count(*)::integer AS n FROM controls.result WHERE run_id=$1',
            [id],
          )
        ).rows[0].n,
        0,
      );
    } finally {
      await admin.query(`DROP TRIGGER phase9_stage_fail ON ${table}`);
      await admin.query('DROP FUNCTION public.phase9_stage_fail()');
    }
    if (table === 'controls.input') await controls.freeze(id);
  }
  await controls.evaluate(id, 1);
  const before = (await controls.summary(id)).results;
  await controls.run(c);
  assert.deepEqual(
    (await controls.summary(id)).results.find((r) => r.key === before[0]!.key),
    before[0],
  );
});
test('actual backend death before completion commit rolls back cases/companions and recovery commits once', async () => {
  const f = await setup({ banks: [] }),
    c = command(f.book, [f.run.id], { createCases: true }),
    id = await controls.create(c);
  await controls.freeze(id);
  while (await controls.evaluate(id)) {}
  await admin.query(
    'CREATE FUNCTION public.phase9_pause() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.control_run_id IS NOT NULL THEN PERFORM pg_sleep(20); END IF; RETURN NEW; END $$',
  );
  await admin.query(
    'CREATE TRIGGER phase9_pause BEFORE INSERT ON outbox.outbox_event FOR EACH ROW EXECUTE FUNCTION public.phase9_pause()',
  );
  const pending = controls.complete(id);
  const caught = pending.catch((e) => e);
  try {
    let pid: number | undefined;
    for (let i = 0; i < 200; i++) {
      pid = (
        await admin.query<{ pid: number }>(
          "SELECT pid FROM pg_stat_activity WHERE usename='flow_test_control' AND wait_event='PgSleep'",
        )
      ).rows[0]?.pid;
      if (pid) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert(pid);
    await admin.query('SELECT pg_terminate_backend($1)', [pid]);
    assert((await caught) instanceof Error);
    assert.equal((await controls.summary(id)).state, 'EVALUATING');
    assert.equal(
      (
        await admin.query(
          'SELECT count(*)::integer AS n FROM exceptions.case_record WHERE mapping_id=$1',
          [f.mappingId],
        )
      ).rows[0].n,
      0,
    );
  } finally {
    await admin.query('DROP TRIGGER phase9_pause ON outbox.outbox_event');
    await admin.query('DROP FUNCTION public.phase9_pause()');
  }
  await controls.complete(id);
  assert.equal((await controls.summary(id)).cases.length, 1);
});
test('independent controls detect rollback-only administrator-injected missing outcomes and broken allocation/ledger totals', async () => {
  // Test-only owner bypass stays inside a transaction that ALWAYS rolls back.
  const inspect = async (
    book: string,
    runs: readonly string[],
    table: string,
    sql: string,
    args: readonly unknown[],
  ) => {
    const c = await admin.connect();
    try {
      await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await c.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
      await c.query(sql, [...args]);
      await c.query(`ALTER TABLE ${table} ENABLE TRIGGER USER`);
      const id = (
        await c.query<{ id: string }>(
          'SELECT controls.create_run($1::jsonb) AS id',
          [serializeControl(command(book, runs))],
        )
      ).rows[0]!.id;
      await c.query('SELECT controls.freeze($1::uuid)', [id]);
      while (
        (
          await c.query<{ n: number }>(
            'SELECT controls.evaluate($1::uuid,1000) AS n',
            [id],
          )
        ).rows[0]!.n
      ) {}
      await c.query('SELECT controls.complete($1::uuid)', [id]);
      return (
        await c.query<{ result: ControlSummary }>(
          'SELECT controls.summary($1::uuid) AS result',
          [id],
        )
      ).rows[0]!.result;
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  };
  const missing = await setup({ banks: [] });
  const incomplete = await inspect(
    missing.book,
    [],
    'reconciliation.outcome',
    'DELETE FROM reconciliation.outcome WHERE run_id=$1',
    [missing.run.id],
  );
  assert(
    result(incomplete, 'RECONCILIATION').some(
      (r) => r.key.startsWith('reconciliation:') && r.status === 'FAIL',
    ),
  );
  assert.equal((await recon.summary(missing.run.id)).outcomes[0]!.count, 1);
  const allocated = await setup(),
    g = (
      await admin.query(
        'SELECT id FROM reconciliation.match_group WHERE run_id=$1',
        [allocated.run.id],
      )
    ).rows[0].id;
  const broken = await inspect(
    allocated.book,
    [allocated.run.id],
    'reconciliation.match_group_member',
    "UPDATE reconciliation.match_group_member SET signed_amount_minor=signed_amount_minor+1 WHERE group_id=$1 AND role='PROCESSOR_SETTLEMENT'",
    [g],
  );
  assert(
    result(broken, 'ALLOCATION').some(
      (r) => r.status === 'FAIL' && r.discrepancy === '-1',
    ),
  );
  const ledger = new PostgresLedger(lp),
    a = await ledger.createAccount({
      bookId: allocated.book,
      code: 'corrupt-debit',
      currency: 'PHP',
      classification: 'asset',
      normalSide: 'debit',
      commandKey: randomUUID(),
      actorId: 'system',
      reason: 'synthetic corruption fixture',
    }),
    b = await ledger.createAccount({
      bookId: allocated.book,
      code: 'corrupt-credit',
      currency: 'PHP',
      classification: 'equity',
      normalSide: 'credit',
      commandKey: randomUUID(),
      actorId: 'system',
      reason: 'synthetic corruption fixture',
    });
  const journal = await ledger.post({
    bookId: allocated.book,
    currency: 'PHP',
    commandKey: randomUUID(),
    effectNamespace: 'corruption-fixture',
    businessEffectKey: 'journal',
    effectiveAt: '2026-01-01T00:00:00.000Z',
    policyVersion: 'generic-v1',
    actorId: 'system',
    reason: 'synthetic corruption fixture',
    entries: [
      { accountId: a.id, side: 'debit', money: Money.of(10n, 'PHP') },
      { accountId: b.id, side: 'credit', money: Money.of(10n, 'PHP') },
    ],
  });
  const last = await inspect(
    allocated.book,
    [allocated.run.id],
    'ledger.ledger_entry',
    "UPDATE ledger.ledger_entry SET amount_minor=11 WHERE journal_id=$1 AND side='debit'",
    [journal.id],
  );
  assert(
    result(last, 'LEDGER').some(
      (r) => r.status === 'FAIL' && r.discrepancy === '-1',
    ),
  );
  assert(
    (
      await admin.query<{ amount: string }>(
        'SELECT amount_minor::text AS amount FROM ledger.ledger_entry WHERE journal_id=$1',
        [journal.id],
      )
    ).rows.every((r) => r.amount === '10'),
  );
});
test('queued commands and whole 40001/40P01 retries preserve the original semantic payload', async () => {
  const f = await setup(),
    c = command(f.book, [f.run.id]);
  await admin.query('CREATE SEQUENCE public.phase9_retry');
  await admin.query(
    'GRANT USAGE ON SEQUENCE public.phase9_retry TO flow_ledger_owner',
  );
  await admin.query(
    "CREATE FUNCTION public.phase9_retry() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE n bigint:=nextval('public.phase9_retry'); BEGIN IF n=1 THEN RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='Synthetic retry'; ELSIF n=2 THEN RAISE EXCEPTION USING ERRCODE='40P01',MESSAGE='Synthetic retry'; END IF; RETURN NEW; END $$",
  );
  await admin.query(
    'CREATE TRIGGER phase9_retry BEFORE INSERT ON controls.run FOR EACH ROW EXECUTE FUNCTION public.phase9_retry()',
  );
  const tiny = new Pool({ connectionString: cu, max: 1 }),
    held = await tiny.connect(),
    adapter = new PostgresControls(tiny);
  const queued = adapter.create(c);
  (c as { actorId: string }).actorId = 'changed-after-call';
  held.release();
  try {
    const id = await queued;
    assert.equal(
      (await admin.query('SELECT actor_id FROM controls.run WHERE id=$1', [id]))
        .rows[0].actor_id,
      'phase9-controller',
    );
    assert.equal(
      (
        await admin.query(
          'SELECT last_value::integer AS n FROM public.phase9_retry',
        )
      ).rows[0].n,
      3,
    );
    await adapter.freeze(id);
    while (await adapter.evaluate(id)) {}
    await adapter.complete(id);
    assert.equal((await adapter.summary(id)).state, 'COMPLETED');
  } finally {
    await tiny.end();
    await admin.query('DROP TRIGGER phase9_retry ON controls.run');
    await admin.query('DROP FUNCTION public.phase9_retry()');
    await admin.query('DROP SEQUENCE public.phase9_retry');
  }
});
test('aging and expired current assurance remain visible without closing cases or creating allocation', async () => {
  const f = await setup({ banks: [] }),
    ids = await exceptions.generate(f.run.id, 'age-system');
  await admin.query('SELECT pg_sleep(2.1)');
  const s = await controls.run(
    command(f.book, [f.run.id], { maxAgeSeconds: 1 }),
  );
  assert(
    result(s, 'FRESHNESS').some(
      (r) => r.key.startsWith('aging:') && r.status === 'FAIL',
    ),
  );
  await admin.query('SELECT pg_sleep(1.1)');
  const old = await controls.summary(s.id);
  assert.equal(old.current, false);
  assert.equal(old.currentReason, 'EVALUATION_EXPIRED');
  assert.equal((await exceptions.get(ids[0]!)).state, 'OPEN');
  assert.equal(old.exposure[0]!['unreconciledMinor'], '970000');
});
test('processor coverage includes the existing alternate supported movement normalizer without adding its values as another financial component', async () => {
  const f = await setup(),
    body = {
      id: 'seconds-activity',
      kind: 'capture',
      paymentReference: 'independent-v2-payment',
      parentCaptureId: null,
      amount: money('17'),
      occurredAt: '2026-01-01T00:00:00Z',
    };
  const b = await f.ingestion.ingest({
    sourceAccountId: f.source,
    batchKey: randomUUID(),
    actorId: 'v2-source',
    provenance: { adapterVersion: 'synthetic-seconds' },
    expectedCount: 1,
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
  });
  await f.ingestion.requestNormalization(
    b.id,
    'synthetic-movement-v2',
    'v2-controller',
  );
  await f.ingestion.normalizeBatch(b.id, 'synthetic-movement-v2');
  const pending = await controls.run(command(f.book, [f.run.id]));
  assert(
    pending.results.some(
      (r) =>
        r.type === 'PROCESSOR_COVERAGE' &&
        r.scope['sourceAccountId'] === f.source &&
        r.status === 'FAIL',
    ),
  );
  await f.processor.deriveBatch(b.id, 'synthetic-movement-v2');
  const derived = await controls.run(command(f.book, [f.run.id]));
  assert(
    derived.results
      .filter((r) => r.type === 'PROCESSOR_COVERAGE')
      .every((r) => r.status === 'PASS'),
  );
  assert(
    result(derived, 'PROCESSOR_TOTAL').every(
      (r) => r.expected === '970000' && r.observed === '970000',
    ),
  );
});
