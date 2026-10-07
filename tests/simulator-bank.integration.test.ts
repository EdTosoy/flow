import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, after, test } from 'node:test';
import { Pool } from 'pg';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { generateSimulation } from '@flow/simulator-oracle';
import type { SystemInput } from '@flow/simulator';
import { PostgresIngestion } from '@flow/ingestion-postgres';
import { PostgresBank } from '@flow/bank-postgres';
import { simulatorBankBatch } from '../tools/bank-input';
const au = process.env['FLOW_TEST_ADMIN_URL'],
  bu = process.env['FLOW_TEST_BANK_URL'],
  iu = process.env['FLOW_TEST_INGESTION_URL'];
if (!au || !bu || !iu) throw new Error('Run pnpm test:integration');
const admin = new Pool({ connectionString: au }),
  bp = new Pool({ connectionString: bu }),
  ip = new Pool({ connectionString: iu });
const ingestion = new PostgresIngestion(ip),
  bank = new PostgresBank(bp),
  book = randomUUID();
before(async () => {
  await admin.query(
    "INSERT INTO ledger.book(id,code,environment) VALUES($1,$2,'synthetic')",
    [book, 'sim-bank-' + book],
  );
});
after(async () => {
  await Promise.all([admin.end(), bp.end(), ip.end()]);
});
async function pipeline(input: SystemInput) {
  const account = await ingestion.registerSource({
    bookId: book,
    environment: 'synthetic',
    provider: 'public-simulator-bank',
    externalAccountId: randomUUID(),
  });
  const batch = await ingestion.ingest(
    simulatorBankBatch(input, account, 'bank'),
  );
  await ingestion.requestNormalization(
    batch.id,
    'synthetic-bank-entry-v1',
    'test',
  );
  const normalization = await ingestion.normalizeBatch(
    batch.id,
    'synthetic-bank-entry-v1',
  );
  const entries = await bank.deriveBatch(batch.id, 'synthetic-bank-entry-v1');
  return {
    account,
    batch,
    normalization,
    entries,
    summary: await bank.summary(account),
  };
}
test('public simulator bank artifacts traverse ingestion and normalization; verifier alone compares oracle effects', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 0, max: 4294967295 }),
      fc.integer({ min: 4, max: 16 }),
      async (seed, paymentCount) => {
        const sim = generateSimulation({
          seed,
          paymentCount,
          fullRefundCount: 2,
          partialRefundCount: 1,
          chargebackCount: 1,
          batchSizeRange: [1, 3],
        });
        const result = await pipeline(sim.input);
        assert.equal(result.entries.length, sim.oracle.bank.length);
        const observed = (
          await bp.query(
            'SELECT f.external_id,e.amount_minor::text,e.direction FROM bank.entry e JOIN bank.derivation d ON d.id=e.id JOIN ingestion.source_fact f ON f.id=d.fact_id WHERE e.source_account_id=$1',
            [result.account],
          )
        ).rows;
        let credits = 0n,
          debits = 0n;
        for (const truth of sim.oracle.bank) {
          const r = observed.find((r) => r.external_id === truth.id);
          assert.ok(r);
          const signed = BigInt(truth.amount.amountMinor);
          assert.equal(
            r.amount_minor,
            (signed < 0n ? -signed : signed).toString(),
          );
          assert.equal(r.direction, signed > 0n ? 'CREDIT' : 'DEBIT');
          if (signed > 0n) credits += signed;
          else debits -= signed;
        }
        if (observed.length)
          assert.deepEqual(result.summary.totals, [
            {
              currency: 'PHP',
              creditsMinor: credits.toString(),
              debitsMinor: debits.toString(),
            },
          ]);
        assert.equal(result.normalization.completeness, 'UNKNOWN');
        const replay = await bank.deriveBatch(
          result.batch.id,
          'synthetic-bank-entry-v1',
        );
        assert.deepEqual(
          replay.map((r) => r.id),
          result.entries.map((r) => r.id),
        );
      },
    ),
    { numRuns: 20, seed: 70505 },
  );
  assert.equal(
    (
      await admin.query(
        'SELECT count(*)::integer n FROM ledger.ledger_transaction WHERE book_id=$1',
        [book],
      )
    ).rows[0].n,
    0,
  );
});
test('duplicate/missing bank evidence preserves honest coverage; processor and reference changes never cause matching', async () => {
  const sim = generateSimulation({
    seed: 70506,
    paymentCount: 30,
    batchSizeRange: [3, 3],
    anomalies: {
      'duplicate-bank-observation': { count: 2 },
      'missing-bank-transaction': { count: 2 },
      'wrong-reference': { count: 2 },
    },
  });
  const result = await pipeline(sim.input);
  assert.equal(
    result.entries.length,
    new Set(sim.input.bankObservations.map((b) => b.id)).size,
  );
  assert.equal(
    result.normalization.received,
    sim.input.bankObservations.length,
  );
  assert.equal(result.normalization.completeness, 'UNKNOWN');
  const unrelated = {
    ...sim.input,
    processorEvents: [],
    settlements: [],
    internalExpectations: [],
    captureAttempts: [],
  };
  const second = await pipeline(unrelated);
  assert.deepEqual(second.summary, result.summary);
  // No bank/processor comparison: even the source's wrong-reference claims remain ordinary bank entries.
  for (const anomaly of sim.oracle.anomalies.filter(
    (a) => a.kind === 'wrong-reference',
  )) {
    const source = sim.input.bankObservations.find(
      (b) => b.id === anomaly.canonicalId,
    )!;
    const row = (
      await bp.query(
        'SELECT e.bank_reference FROM bank.entry e JOIN bank.derivation d ON d.id=e.id JOIN ingestion.source_fact f ON f.id=d.fact_id WHERE e.source_account_id=$1 AND f.external_id=$2',
        [result.account, source.id],
      )
    ).rows[0];
    assert.equal(row.bank_reference, source.transferReference);
  }
});
test('developer CLI runs public processor and bank pipelines with repeatable separate summaries and no oracle output', async () => {
  const sim = generateSimulation({
    seed: 70507,
    paymentCount: 12,
    fullRefundCount: 2,
    batchSizeRange: [2, 4],
  });
  const dir = await mkdtemp(join(tmpdir(), 'flow-bank-cli-')),
    path = join(dir, 'input.json');
  await writeFile(path, JSON.stringify(sim.input));
  const invoke = async () =>
    JSON.parse(
      (
        await promisify(execFile)(
          process.execPath,
          ['--import', 'tsx', 'tools/bank.ts', path, book, 'cli-1'],
          {
            env: {
              ...process.env,
              DATABASE_INGESTION_URL: iu!,
              DATABASE_PROCESSOR_URL: process.env['FLOW_TEST_PROCESSOR_URL']!,
              DATABASE_BANK_URL: bu!,
            },
            maxBuffer: 16 * 1024 * 1024,
          },
        )
      ).stdout,
    );
  const first = await invoke(),
    second = await invoke();
  assert.deepEqual(first, second);
  assert.equal(first.bank.entries, sim.oracle.bank.length);
  assert.equal(first.processor.payments, 12);
  assert.equal(first.bank.statementCompleteness, 'UNKNOWN');
  const output = JSON.stringify(first);
  for (const word of [
    'oracle',
    'expectedMatch',
    'reconciled',
    'matchedTo',
    'bankArrival',
  ])
    assert.ok(!output.includes(word));
  assert.deepEqual(Object.keys(first).sort(), ['bank', 'processor']);
});
