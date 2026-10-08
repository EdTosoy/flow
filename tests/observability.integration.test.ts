import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { Pool } from 'pg';
import {
  PostgresOperations,
  ReadUnavailable,
  type ReadObservation,
} from '@flow/operations-read-postgres';
import { PostgresReconciliation } from '@flow/reconciliation-postgres';
import { PostgresControls } from '@flow/control-postgres';
import {
  fixture,
  importEvidence,
  entry,
} from './helpers/reconciliation-fixture';
import { readDelayProxy } from './helpers/read-delay-proxy';
import { witness, clean } from './helpers/resilience';
import { previousReadDefinitions } from './helpers/previous-read-definitions';
const pools = [
  'ADMIN',
  'INGESTION',
  'PROCESSOR',
  'BANK',
  'RECONCILIATION',
  'CONTROL',
  'OPERATIONS',
].map(
  (key) =>
    new Pool({ connectionString: process.env['FLOW_TEST_' + key + '_URL'] }),
);
const [admin, ingestion, processor, bank, recon, controls, operations] =
  pools as [Pool, Pool, Pool, Pool, Pool, Pool, Pool];
if (!process.env['FLOW_TEST_OPERATIONS_URL'])
  throw new Error('Use pnpm test:integration');
after(async () => {
  await Promise.all(pools.map((p) => p.end()));
});
test('batched proofs and revision aggregate exactly preserve original frozen/current domain reads', async () => {
  const f = await fixture(admin, ingestion, processor, bank);
  const run = await new PostgresReconciliation(recon).run(f.command);
  const evaluation = await new PostgresControls(controls).run({
    bookId: f.book,
    runKey: 'phase13-equivalence',
    actorId: 'test',
    reconciliationRunIds: [run.id],
    createCases: false,
  });
  const retained = await witness(admin);
  async function compare() {
    const client = await admin.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      const sql = `SELECT controls.snapshot(command,frozen_at) AS snapshot,controls.exposure($2) AS exposure,
      reconciliation.summary($2) AS reconciliation,
      (SELECT jsonb_agg(to_jsonb(f) ORDER BY f.id) FROM ingestion.fact_status f JOIN ingestion.source_account a ON a.id=f.source_account_id WHERE a.book_id=$3) AS facts
      FROM controls.run WHERE id=$1`;
      const optimized = (
        await client.query(sql, [evaluation.id, run.id, f.book])
      ).rows;
      const ids = (
        await client.query(
          'SELECT id FROM reconciliation.match_group WHERE run_id=$1',
          [run.id],
        )
      ).rows.map((x: { id: string }) => x.id);
      const batched = (
        await client.query(
          'SELECT * FROM reconciliation.current_valid_many($1::uuid[]) ORDER BY id',
          [ids],
        )
      ).rows;
      const individual = (
        await client.query(
          'SELECT id,reconciliation.current_valid(id) AS valid FROM reconciliation.match_group WHERE id=ANY($1::uuid[]) ORDER BY id',
          [ids],
        )
      ).rows;
      assert.deepEqual(batched, individual);
      await previousReadDefinitions(client);
      const previous = (
        await client.query(sql, [evaluation.id, run.id, f.book])
      ).rows;
      assert.deepEqual(
        optimized,
        previous,
        'same full canonical evidence, exposure and current/historical summary',
      );
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }
  await compare();
  await new PostgresReconciliation(recon).run({
    ...f.command,
    runKey: 'phase13-successor',
  });
  await compare(); // Superseded history and genuinely current successor allocations.
  await importEvidence(
    f.ingestion,
    f.bank,
    f.bankSource,
    'synthetic-bank-entry',
    'synthetic-bank-entry-v1',
    [entry('bank', '970001')],
  );
  await compare(); // New unordered revision makes historical proof unavailable; never select the latest arrival.
  await retained();
  await clean(admin, f.book, [run.id]);
});
test('readiness and reads bound a stalled real PostgreSQL response and discard the client', async () => {
  const proxy = await readDelayProxy(process.env['FLOW_TEST_OPERATIONS_URL']!);
  const pool = new Pool({
    connectionString: proxy.url,
    max: 1,
    connectionTimeoutMillis: 1000,
  });
  const observations: ReadObservation[] = [];
  try {
    const reader = new PostgresOperations(
      pool,
      (o) => observations.push(o),
      20,
    );
    await assert.rejects(
      reader.ready(),
      (e: unknown) =>
        e instanceof ReadUnavailable && e.classification === 'TIMEOUT',
    );
    assert.equal(observations.at(-1)!.queryCount, 1);
    await assert.rejects(
      reader.read('books', null),
      (e: unknown) =>
        e instanceof ReadUnavailable && e.classification === 'TIMEOUT',
    );
    assert.equal(pool.waitingCount, 0);
    assert.equal(pool.idleCount, 0);
    assert.equal(observations.at(-1)!.outcome, 'FAILURE');
  } finally {
    await pool.end();
    await proxy.close();
  }
});
test('query counts, timeout taxonomy, readiness capability and failed-client cleanup remain bounded', async () => {
  const f = await fixture(admin, ingestion, processor, bank);
  const observations: ReadObservation[] = [];
  const reads = new PostgresOperations(operations, (o) => observations.push(o));
  await reads.ready();
  await reads.read('exceptions', f.book);
  assert.equal(observations[0]!.operation, 'ready');
  assert.equal(observations[0]!.queryCount, 5);
  assert.equal(observations[1]!.queryCount, 5);
  await new PostgresOperations(operations, () => {
    throw new Error('Broken observer');
  }).read('exceptions', f.book);
  await assert.rejects(
    new PostgresOperations(admin).ready(),
    (e: unknown) =>
      e instanceof ReadUnavailable && e.classification === 'PERMISSION_DENIED',
  );
  // Actual statement timeout on the existing approved read function; never manufacture healthy emptiness.
  const lock = await admin.connect();
  try {
    await lock.query('BEGIN');
    await lock.query(
      'LOCK TABLE exceptions.case_record IN ACCESS EXCLUSIVE MODE',
    );
    await assert.rejects(
      new PostgresOperations(operations, (o) => observations.push(o), 20).read(
        'exceptions',
        f.book,
      ),
      (e: unknown) =>
        e instanceof ReadUnavailable && e.classification === 'TIMEOUT',
    );
  } finally {
    await lock.query('ROLLBACK');
    lock.release();
  }
  assert.equal(observations.at(-1)!.outcome, 'FAILURE');
  assert.equal(observations.at(-1)!.queryCount, 5); // BEGIN, timeout, capability, blocked read, rollback.
  await reads.read('exceptions', f.book);
  assert.equal(operations.waitingCount, 0);
  assert.equal(operations.totalCount, operations.idleCount);
  await assert.rejects(
    operations.query('SELECT reconciliation.current_valid_many($1::uuid[])', [
      [],
    ]),
    { code: '42501' },
  );
  await clean(admin, f.book);
});
