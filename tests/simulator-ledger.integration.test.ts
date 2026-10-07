import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Pool } from 'pg';
import { generateSimulation } from '@flow/simulator-oracle';
import { captureCommand } from '@flow/simulator';
import { PostgresLedger } from '@flow/ledger-postgres';

/** Independent verifier owns oracle; execute receives only public command attempts. */
test('simulated omissions/duplicate attempts use real public ledger commands and recover exactly once', async () => {
  const adminUrl = process.env['FLOW_TEST_ADMIN_URL'];
  const writerUrl = process.env['FLOW_TEST_WRITER_URL'];
  const readerUrl = process.env['FLOW_TEST_READER_URL'];
  if (!adminUrl || !writerUrl || !readerUrl)
    throw new Error('Run pnpm test:integration');
  const admin = new Pool({ connectionString: adminUrl });
  const writer = new Pool({ connectionString: writerUrl });
  const reader = new Pool({ connectionString: readerUrl });
  const ledger = new PostgresLedger(writer, reader);
  const bookId = '00000000-0000-0000-0000-000000000202';
  try {
    // Book bootstrap only. All authoritative account/journal activity uses public commands.
    await admin.query(
      'INSERT INTO ledger.book(id,code,environment) VALUES($1,$2,$3)',
      [bookId, 'phase2-synthetic-test', 'synthetic'],
    );
    const identity = {
      bookId,
      actorId: 'phase2-test',
      reason: 'synthetic merchant fixture',
    };
    const receivable = await ledger.createAccount({
      ...identity,
      commandKey: 'phase2-receivable',
      code: 'processor-receivable',
      currency: 'PHP',
      classification: 'asset',
      normalSide: 'debit',
    });
    const sales = await ledger.createAccount({
      ...identity,
      commandKey: 'phase2-sales',
      code: 'sales',
      currency: 'PHP',
      classification: 'income',
      normalSide: 'credit',
    });
    const context = {
      bookId,
      receivableAccountId: receivable.id,
      salesAccountId: sales.id,
    };
    const config = { seed: 828192, paymentCount: 20 };
    const s = generateSimulation({
      ...config,
      anomalies: {
        'duplicate-ledger-command': { count: 4 },
        'missing-ledger-posting': { count: 3 },
        'incorrect-amount': { count: 2 },
      },
    });
    let replayed = 0;
    for (const attempt of s.input.captureAttempts)
      if ((await ledger.post(captureCommand(attempt, context))).replayed)
        replayed++;
    assert.equal(replayed, 4);
    const facts = await reader.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM ledger.ledger_transaction WHERE book_id=$1',
      [bookId],
    );
    assert.equal(facts.rows[0]!.count, '17');
    const expected = s.oracle.expectedCaptureEffects.reduce(
      (sum, e) => sum + BigInt(e.amount.amountMinor),
      0n,
    );
    const missing = s.oracle.anomalies
      .filter((a) => a.kind === 'missing-ledger-posting')
      .reduce(
        (sum, a) =>
          sum +
          BigInt(
            (a.before as { expectation: { amount: { amountMinor: string } } })
              .expectation.amount.amountMinor,
          ),
        0n,
      );
    assert.equal(await ledger.accountDelta(receivable.id), expected - missing);
    // Reproduce normal independent internal source to recover omitted commands; retry all originals.
    const recovered = generateSimulation(config).input;
    for (const attempt of recovered.captureAttempts)
      await ledger.post(captureCommand(attempt, context));
    for (const attempt of s.input.captureAttempts)
      assert((await ledger.post(captureCommand(attempt, context))).replayed);
    assert.equal(await ledger.accountDelta(receivable.id), expected);
    assert.equal(await ledger.accountDelta(sales.id), -expected);
    const companions = await reader.query<{
      journals: string;
      audit: string;
      outbox: string;
    }>(
      `SELECT (SELECT count(*) FROM ledger.ledger_transaction WHERE book_id=$1)::text AS journals,
       (SELECT count(*) FROM audit.audit_event WHERE book_id=$1)::text AS audit,
       (SELECT count(*) FROM outbox.outbox_event WHERE book_id=$1)::text AS outbox`,
      [bookId],
    );
    assert.deepEqual(companions.rows[0], {
      journals: '20',
      audit: '22',
      outbox: '22',
    });
  } finally {
    await Promise.all([admin.end(), writer.end(), reader.end()]);
  }
});
