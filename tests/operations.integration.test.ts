import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { Pool } from 'pg';
import {
  PostgresOperations,
  ReadUnavailable,
  InvalidRead,
  type RecordJson,
} from '@flow/operations-read-postgres';
import { PostgresReconciliation } from '@flow/reconciliation-postgres';
import { PostgresControls } from '@flow/control-postgres';
import { PostgresExceptions } from '@flow/exception-postgres';
import { fixture, entry } from './helpers/reconciliation-fixture';
import { witness, clean } from './helpers/resilience';
const pool = (key: string) =>
  new Pool({ connectionString: process.env['FLOW_TEST_' + key + '_URL'] });
const admin = pool('ADMIN'),
  ip = pool('INGESTION'),
  pp = pool('PROCESSOR'),
  bp = pool('BANK'),
  rp = pool('RECONCILIATION'),
  cp = pool('CONTROL'),
  ep = pool('EXCEPTION'),
  op = pool('OPERATIONS');
if (!process.env['FLOW_TEST_OPERATIONS_URL'])
  throw new Error('Run pnpm test:integration');
const reads = new PostgresOperations(op),
  recon = new PostgresReconciliation(rp),
  controls = new PostgresControls(cp),
  exceptions = new PostgresExceptions(ep);
after(async () => {
  await Promise.all([admin, ip, pp, bp, rp, cp, ep, op].map((p) => p.end()));
});
const object = (v: unknown) => v as RecordJson;
test('operations reads preserve canonical pair exposure, accepted risk, unknowns, counts and immutable detail', async () => {
  const f = await fixture(admin, ip, pp, bp, {
    banks: [entry('bank', '969999')],
  });
  const run = await recon.run(f.command);
  const cases = await exceptions.generate(run.id, 'operations-test');
  let c = await exceptions.get(cases[0]!);
  c = await exceptions.apply({
    caseId: c.id,
    commandKey: 'review',
    expectedVersion: c.version,
    actorId: 'reviewer',
    reason: 'Test case operations distinction',
    action: 'START_REVIEW',
  });
  await exceptions.apply({
    caseId: c.id,
    commandKey: 'risk',
    expectedVersion: c.version,
    actorId: 'reviewer',
    reason: 'Test accepted risk is not allocation',
    action: 'RESOLVE',
    resolution: 'ACCEPTED_RISK',
  });
  const evaluation = await controls.run({
    bookId: f.book,
    runKey: 'read-test',
    actorId: 'operator-test',
    reconciliationRunIds: [run.id],
    createCases: true,
  });
  const retain = await witness(admin);
  const overview = await reads.read('overview', f.book, {
    evaluation: evaluation.id,
  });
  const ev = object(overview.data!['evaluation']);
  const exposure = (ev['exposure'] as RecordJson[])[0]!;
  assert.equal(exposure['unreconciledMinor'], '1');
  assert.equal(exposure['acceptedRiskMinor'], '1');
  assert.equal(exposure['pairResidualMinor'], '1');
  assert.notEqual(
    object(overview.data!['integrity'])['financialAssurance'],
    'PASS',
  );
  const list = await reads.read('exceptions', f.book, {
    status: 'RESOLVED',
    limit: '1',
  });
  assert.equal(list.items!.length, 1);
  assert.equal(list.items![0]!['currentlyReconciled'], false);
  assert.equal(list.items![0]!['resolution'], 'ACCEPTED_RISK');
  const detail = await reads.read('case', f.book, { id: c.id, limit: '1' });
  assert(detail.nextCursor);
  const page2 = await reads.read('case', f.book, {
    id: c.id,
    limit: '1',
    cursor: detail.nextCursor,
  });
  assert.equal(page2.items![0]!['version'], 2);
  const runDetail = await reads.read('run', f.book, { id: run.id, limit: '1' });
  assert.equal(runDetail.data!['ruleVersion'], 'settlement-bank-exact-v1');
  assert.equal(runDetail.items!.length, 1);
  assert(runDetail.nextCursor);
  const second = await reads.read('run', f.book, {
    id: run.id,
    limit: '1',
    cursor: runDetail.nextCursor,
  });
  assert.notEqual(second.items![0]!['id'], runDetail.items![0]!['id']);
  assert.equal(second.nextCursor, null);
  const unknown = await reads.read('controls', f.book, {
    evaluation: evaluation.id,
    status: 'UNKNOWN',
    category: 'SOURCE_PERIOD',
  });
  assert(unknown.items!.length > 0);
  assert.equal(unknown.items![0]!['expected'], null);
  const control = await reads.read('control', f.book, {
    evaluation: evaluation.id,
    key: unknown.items![0]!['key'] as string,
  });
  assert.equal(control.data!['status'], 'UNKNOWN');
  const noMatch = await reads.read('exceptions', f.book, { currency: 'USD' });
  assert.deepEqual(noMatch.items, []);
  await retain();
  await clean(admin, f.book, [run.id]);
});
test('read capability is actual read-only, rejects owners and cannot leak raw data/commands or cross-book details', async () => {
  const f = await fixture(admin, ip, pp, bp),
    run = await recon.run(f.command);
  const other = await fixture(admin, ip, pp, bp);
  await recon.run(other.command);
  await assert.rejects(
    reads.read('run', other.book, { id: run.id }),
    (e) => e instanceof ReadUnavailable && e.category === 'NOT_FOUND',
  );
  await assert.rejects(
    new PostgresOperations(admin).read('overview', f.book),
    ReadUnavailable,
  );
  for (const sql of [
    'SELECT * FROM ingestion.raw_record',
    'SELECT * FROM outbox.outbox_event',
    'SELECT * FROM worker.work_item',
    'DELETE FROM ledger.ledger_entry',
    "UPDATE reconciliation.run SET state='DRAFT'",
    'DELETE FROM exceptions.event',
    'DELETE FROM controls.result',
    "SELECT worker.claim('web',null)",
    'SELECT controls.freeze(null)',
    "SELECT exceptions.apply('{}'::jsonb)",
    'SELECT reconciliation.advance(null,1)',
    "SELECT ledger.post_journal('{}'::jsonb)",
    'CREATE TABLE operations.forbidden(id integer)',
  ]) {
    await assert.rejects(
      op.query(sql),
      (e) =>
        typeof e === 'object' &&
        e !== null &&
        'code' in e &&
        e.code === '42501',
      sql,
    );
  }
  await assert.rejects(
    reads.read('exceptions', f.book, { status: 'PASS' }),
    InvalidRead,
  );
  await assert.rejects(reads.read('overview', 'not-a-uuid'), InvalidRead);
  const result = await reads.read('workers', f.book);
  const serialized = JSON.stringify(result);
  for (const name of [
    'payload',
    'bytes',
    'command_key',
    'lease_token',
    'connectionString',
  ])
    assert(!serialized.includes('"' + name + '"'));
  const item = result.items![0]!;
  await assert.rejects(
    reads.read('work', other.book, { id: item['id'] as string }),
    (e) => e instanceof ReadUnavailable && e.category === 'NOT_FOUND',
  );
  await reads.read('work', f.book, { id: item['id'] as string });
  await reads.read('integrity', f.book);
  await clean(admin, f.book, [run.id]);
});
test('empty book assurance is UNKNOWN and query failure is unavailable rather than an empty healthy result', async () => {
  const book = randomUUID();
  await admin.query(
    "INSERT INTO ledger.book(id,code,environment) VALUES($1,$2,'synthetic')",
    [book, 'empty-ops-' + book],
  );
  const data = await reads.read('overview', book);
  assert.equal(
    object(data.data!['integrity'])['financialAssurance'],
    'UNKNOWN',
  );
  assert.equal(data.data!['evaluation'], null);
  await assert.rejects(reads.read('overview', randomUUID()), ReadUnavailable);
  await clean(admin, book);
});
test('keyset filters and freshness survive later evidence without rewriting historical control results', async () => {
  const f = await fixture(admin, ip, pp, bp),
    run = await recon.run(f.command),
    evaluation = await controls.run({
      bookId: f.book,
      runKey: 'before',
      actorId: 'read-test',
      reconciliationRunIds: [run.id],
    });
  const retain = await witness(admin);
  let cursor: string | null = null;
  const keys: string[] = [];
  do {
    const page = await reads.read('controls', f.book, {
      evaluation: evaluation.id,
      limit: '2',
      ...(cursor ? { cursor } : {}),
    });
    keys.push(...page.items!.map((i) => i['key'] as string));
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(keys.length, evaluation.results.length);
  await f.ingestion.ingest({
    sourceAccountId: f.source,
    batchKey: 'arrival',
    actorId: 'read-test',
    provenance: { adapterVersion: 'public-v1' },
    records: [
      {
        locator: '1',
        objectKind: 'synthetic-movement',
        externalId: 'new',
        sourceRevision: null,
        sequence: null,
        sourceObservedAt: null,
        bytes: Buffer.from('{}'),
      },
    ],
  });
  const after = await reads.read('overview', f.book, {
    evaluation: evaluation.id,
  });
  assert.equal(object(after.data!['evaluation'])['current'], false);
  const unchanged = await controls.summary(evaluation.id);
  assert.deepEqual(unchanged.results, evaluation.results);
  await retain();
  await clean(admin, f.book, [run.id]);
});
