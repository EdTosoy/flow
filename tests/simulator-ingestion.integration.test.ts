import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, after, test } from 'node:test';
import { Pool } from 'pg';
import { generateSimulation } from '@flow/simulator-oracle';
import { stableJson } from '@flow/simulator';
import { PostgresIngestion } from '@flow/ingestion-postgres';
import { simulatorBatch } from '../tools/ingestion-input';
const adminURL = process.env['FLOW_TEST_ADMIN_URL'];
const url = process.env['FLOW_TEST_INGESTION_URL'];
if (!adminURL || !url) throw new Error('Run pnpm test:integration');
const admin = new Pool({ connectionString: adminURL });
const pool = new Pool({ connectionString: url });
const api = new PostgresIngestion(pool);
const bookId = randomUUID();
before(async () => {
  await admin.query(
    'INSERT INTO ledger.book(id,code,environment) VALUES($1,$2,$3)',
    [bookId, `sim-ingestion-${bookId}`, 'synthetic'],
  );
});
after(async () => {
  await Promise.all([admin.end(), pool.end()]);
});
test('public simulator anomalies: duplicates/malformed retained; missing coverage unknown; wrong valid amounts accepted', async () => {
  const simulation = generateSimulation({
    seed: 70304,
    paymentCount: 20,
    anomalies: {
      'duplicate-source-event': { count: 2 },
      'corrupted-source-record': { count: 1 },
      'missing-source-event': { count: 1 },
      'incorrect-amount': { count: 1 },
      'delayed-event': { count: 1 },
      'out-of-order-event': { count: 1 },
    },
  });
  const input = simulation.input;
  const account = await api.registerSource({
    bookId,
    environment: 'synthetic',
    provider: 'synthetic-simulator',
    externalAccountId: input.scope.processorAccountId,
  });
  const c = simulatorBatch(input, account, 'public-artifact');
  const b = await api.ingest(c);
  const s = await api.normalizeBatch(b.id);
  assert.equal(s.received, input.processorEvents.length);
  assert.equal(s.failed, 1);
  assert.equal(s.normalized, s.received - 1);
  assert.equal(s.distinctRevisions, s.received - 2);
  assert.equal(s.completeness, 'UNKNOWN');
  const mismatched = simulation.oracle.anomalies.find(
    (a) => a.kind === 'incorrect-amount',
  );
  assert(mismatched);
  // Oracle stays in this verification harness; SUT saw only input. All syntactically valid movements pass.
  const observations = await pool.query<{
    result: {
      observation: { externalId: string; amount: { amountMinor: string } };
    };
  }>(
    "SELECT i.result FROM ingestion.interpretation i JOIN ingestion.raw_record r ON r.revision_id=i.revision_id WHERE r.batch_id=$1 AND i.state='NORMALIZED'",
    [b.id],
  );
  for (const e of input.processorEvents) {
    try {
      const payload = JSON.parse(e.payload);
      assert(
        observations.rows.some(
          (r) =>
            r.result.observation.externalId === payload.id &&
            r.result.observation.amount.amountMinor ===
              payload.amount.amountMinor,
        ),
      );
    } catch (error) {
      if (error instanceof SyntaxError) continue;
      throw error;
    }
  }
  assert.equal(
    (
      await pool.query(
        'SELECT count(*)::text AS n FROM ingestion.raw_record WHERE batch_id=$1',
        [b.id],
      )
    ).rows[0].n,
    String(input.processorEvents.length),
  );
  assert.deepEqual(await api.ingest(c), { id: b.id, replayed: true });
  assert.deepEqual(await api.normalizeBatch(b.id), s);
  assert.equal(
    (
      await admin.query(
        'SELECT count(*)::text AS n FROM ledger.ledger_transaction WHERE book_id=$1',
        [bookId],
      )
    ).rows[0].n,
    '0',
  );
});
test('independent 10,000 source sequence manifest detects one missing item and duplicate masking', async () => {
  const simulation = generateSimulation({ seed: 70305, paymentCount: 5000 });
  const input = simulation.input;
  assert.equal(input.processorEvents.length, 10000);
  const account = await api.registerSource({
    bookId,
    environment: 'synthetic',
    provider: 'independent-test-source',
    externalAccountId: input.scope.processorAccountId,
  });
  const publicBatch = simulatorBatch(input, account, 'full');
  // Separate source fixture supplies explicit sequence evidence; it is not derived from hidden oracle.
  const records = publicBatch.records.map((r, i) => ({
    ...r,
    sequence: i + 1,
  }));
  const manifestBytes = Buffer.from(
    'Independent synthetic source fixture: count=10000; sequence=1..10000',
  );
  const complete = await api.ingest({
    ...publicBatch,
    records,
    expectedCount: 10000,
    expectedSequence: { from: 1, to: 10000 },
    manifestBytes,
  });
  assert.equal(
    (await api.summary(complete.id)).completeness,
    'PROVEN_COMPLETE',
  );
  const missing = await api.ingest({
    ...publicBatch,
    batchKey: 'missing',
    records: records.slice(0, -1),
    expectedCount: 10000,
    expectedSequence: { from: 1, to: 10000 },
    manifestBytes,
  });
  assert.equal(
    (await api.summary(missing.id)).completeness,
    'PROVEN_INCOMPLETE',
  );
  const masked = await api.ingest({
    ...publicBatch,
    batchKey: 'masked',
    records: [
      ...records.slice(0, -1),
      { ...records[0]!, locator: 'duplicate' },
    ],
    expectedCount: 10000,
    expectedSequence: { from: 1, to: 10000 },
    manifestBytes,
  });
  assert.equal(
    (await api.summary(masked.id)).completeness,
    'PROVEN_INCOMPLETE',
  );
});
test('CLI receives only public artifact and outputs safe processing summary; repeat invocation replays', async () => {
  const input = generateSimulation({ seed: 70306, paymentCount: 3 }).input;
  const dir = await mkdtemp(join(tmpdir(), 'flow-ingestion-cli-'));
  const file = join(dir, 'input.json');
  await writeFile(file, stableJson(input) + '\n');
  const run = async () =>
    promisify(execFile)(
      process.execPath,
      [
        '--import',
        'tsx',
        'tools/ingestion.ts',
        'simulator',
        file,
        bookId,
        'cli-replay',
      ],
      { env: { ...process.env, DATABASE_INGESTION_URL: url } },
    );
  const first = await run();
  const second = await run();
  assert.equal(first.stdout, second.stdout);
  const summary = JSON.parse(first.stdout);
  assert.equal(summary.normalized, 6);
  assert.equal(summary.completeness, 'UNKNOWN');
  assert.equal(summary.failed, 0);
  assert(!first.stdout.includes('oracle'));
});
