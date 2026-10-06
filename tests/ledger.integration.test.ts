import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, after, test } from 'node:test';
import { Pool, type PoolClient } from 'pg';
import fc from 'fast-check';
import { Money, MAX_MINOR_UNITS, MIN_MINOR_UNITS } from '@flow/money';
import {
  PostgresLedger,
  LedgerDatabaseError,
  UnknownCommitOutcome,
  ledgerCommandsInTransaction,
} from '@flow/ledger-postgres';
import type {
  PostJournalCommand,
  ReverseJournalCommand,
  CommandResult,
} from '@flow/ledger-domain';
import { migrate } from '../tools/migrations';
import { commitDropProxy } from './helpers/commit-proxy';

const adminURL = process.env['FLOW_TEST_ADMIN_URL'];
const writerURL = process.env['FLOW_TEST_WRITER_URL'];
const readerURL = process.env['FLOW_TEST_READER_URL'];
if (!adminURL || !writerURL || !readerURL)
  throw new Error(
    'Run pnpm test:integration; this suite requires its disposable PostgreSQL',
  );
const admin = new Pool({ connectionString: adminURL });
const writer = new Pool({ connectionString: writerURL, max: 110 });
const reader = new Pool({ connectionString: readerURL });
const ledger = new PostgresLedger(writer, reader);
const bookId = randomUUID();
const otherBook = randomUUID();
let debitAccount: string;
let creditAccount: string;
let usdAccount: string;
let foreignAccount: string;

before(async () => {
  await admin.query(
    'INSERT INTO ledger.book(id,code,environment) VALUES($1,$2,$3),($4,$5,$3)',
    [bookId, `book-${bookId}`, 'synthetic', otherBook, `book-${otherBook}`],
  );
  async function account(
    code: string,
    classification: 'asset' | 'equity',
    normalSide: 'debit' | 'credit',
    currency: 'PHP' | 'USD' = 'PHP',
    bid = bookId,
  ): Promise<string> {
    return (
      await ledger.createAccount({
        bookId: bid,
        code,
        currency,
        classification,
        normalSide,
        commandKey: randomUUID(),
        actorId: 'test-system',
        reason: 'synthetic generic accounts',
      })
    ).id;
  }
  debitAccount = await account('asset', 'asset', 'debit');
  creditAccount = await account('equity', 'equity', 'credit');
  usdAccount = await account('usd', 'asset', 'debit', 'USD');
  foreignAccount = await account('foreign', 'asset', 'debit', 'PHP', otherBook);
});
after(async () => {
  await Promise.all([admin.end(), writer.end(), reader.end()]);
});

function command(amount = 100n): PostJournalCommand {
  return {
    bookId,
    commandKey: randomUUID(),
    actorId: 'test-system',
    reason: 'synthetic generic journal',
    effectNamespace: 'phase1.fixture',
    businessEffectKey: randomUUID(),
    currency: 'PHP',
    effectiveAt: '2026-10-07T00:00:00.000Z',
    policyVersion: 'generic-mechanics-v1',
    entries: [
      {
        accountId: debitAccount,
        side: 'debit',
        money: Money.of(amount, 'PHP'),
      },
      {
        accountId: creditAccount,
        side: 'credit',
        money: Money.of(amount, 'PHP'),
      },
    ],
  };
}
function wire(c: PostJournalCommand): Record<string, unknown> {
  return {
    ...c,
    entries: c.entries.map((e) => ({
      accountId: e.accountId,
      side: e.side,
      amountMinor: e.money.amountMinor.toString(),
    })),
  };
}
function reversal(originalJournalId: string): ReverseJournalCommand {
  return {
    bookId,
    commandKey: randomUUID(),
    originalJournalId,
    actorId: 'test-system',
    reason: 'full synthetic reversal',
    policyVersion: 'generic-mechanics-v1',
    effectiveAt: '2026-10-07T01:00:00.000Z',
  };
}
async function invoke(
  client: Pool | PoolClient,
  routine: 'post_journal' | 'reverse_journal',
  payload: unknown,
): Promise<CommandResult> {
  const result = await client.query<{ result: CommandResult }>(
    `SELECT ledger.${routine}($1::jsonb) AS result`,
    [JSON.stringify(payload)],
  );
  return result.rows[0]!.result;
}
function hasCode(code: string): (error: unknown) => boolean {
  return (error) =>
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code;
}
async function effectCount(c: PostJournalCommand): Promise<bigint> {
  const result = await admin.query<{ count: string }>(
    'SELECT count(*)::text FROM ledger.ledger_transaction WHERE book_id=$1 AND effect_namespace=$2 AND business_effect_key=$3',
    [c.bookId, c.effectNamespace, c.businessEffectKey],
  );
  return BigInt(result.rows[0]!.count);
}
async function noCommittedOperation(c: PostJournalCommand): Promise<void> {
  assert.equal(await effectCount(c), 0n);
  for (const table of [
    'ledger.command_receipt',
    'audit.audit_event',
    'outbox.outbox_event',
  ]) {
    const result = await admin.query<{ count: string }>(
      `SELECT count(*)::text FROM ${table} WHERE book_id=$1 AND command_key=$2`,
      [c.bookId, c.commandKey],
    );
    assert.equal(result.rows[0]!.count, '0');
  }
}
async function transactionRejects(
  operation: (client: PoolClient) => Promise<void>,
  code: string,
): Promise<void> {
  const client = await admin.connect();
  try {
    await client.query('BEGIN');
    await assert.rejects(async () => {
      await operation(client);
      await client.query('COMMIT');
    }, hasCode(code));
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}
async function blockedCount(name: string, count: number): Promise<void> {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    const r = await admin.query<{ count: string }>(
      "SELECT count(*)::text FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'",
      [name],
    );
    if (BigInt(r.rows[0]!.count) >= BigInt(count)) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(
    `Failed to establish ${count} genuinely blocked concurrent callers`,
  );
}

test('real PostgreSQL durable settings, owner/roles and runtime grants', async () => {
  const r = await admin.query<{
    fsync: string;
    synchronous_commit: string;
    version: string;
  }>(
    "SELECT current_setting('fsync') AS fsync,current_setting('synchronous_commit') AS synchronous_commit,current_setting('server_version') AS version",
  );
  assert.equal(r.rows[0]!.fsync, 'on');
  assert.equal(r.rows[0]!.synchronous_commit, 'on');
  assert.match(r.rows[0]!.version, /^18[.]/);
  const roles = await admin.query<{
    rolname: string;
    rolsuper: boolean;
    rolcanlogin: boolean;
  }>(
    'SELECT rolname,rolsuper,rolcanlogin FROM pg_roles WHERE rolname LIKE $1',
    ['flow_ledger_%'],
  );
  assert.equal(roles.rows.length, 3);
  assert(roles.rows.every((r) => !r.rolsuper && !r.rolcanlogin));
  await assert.rejects(
    reader.query('SELECT ledger.post_journal($1::jsonb)', [
      JSON.stringify(wire(command())),
    ]),
    hasCode('42501'),
  );
  await assert.rejects(
    writer.query('SELECT ledger.post_internal($1::jsonb,NULL)', [
      JSON.stringify(wire(command())),
    ]),
    hasCode('42501'),
  );
  await assert.rejects(
    writer.query('SET ROLE flow_ledger_owner'),
    hasCode('42501'),
  );
  await assert.rejects(
    writer.query('ALTER TABLE ledger.ledger_entry DISABLE TRIGGER ALL'),
    hasCode('42501'),
  );
  await assert.rejects(
    writer.query("SET session_replication_role = 'replica'"),
    hasCode('42501'),
  );
  const tables = await admin.query<{ owner: string }>(
    "SELECT tableowner AS owner FROM pg_tables WHERE schemaname IN ('ledger','audit','outbox')",
  );
  assert(tables.rows.every((r) => r.owner === 'flow_ledger_owner'));
});

test('BIGINT string mapping preserves zero, negative bounds, maximum and above safe Number range', async () => {
  await assert.rejects(ledger.accountDelta(randomUUID()), hasCode('P1002'));
  for (const amount of [
    0n,
    -1n,
    MIN_MINOR_UNITS,
    MAX_MINOR_UNITS,
    9007199254740993n,
  ]) {
    const r = await writer.query<{ value: string }>(
      'SELECT $1::bigint::text AS value',
      [amount.toString()],
    );
    assert(
      Money.parse(r.rows[0]!.value, 'PHP').equals(Money.of(amount, 'PHP')),
    );
  }
  const c = command(MAX_MINOR_UNITS);
  const posted = await ledger.post(c);
  assert(
    (await ledger.journal(posted.id))!.entries.every(
      (e) => e.money.amountMinor === MAX_MINOR_UNITS,
    ),
  );
  const twice = command(MAX_MINOR_UNITS);
  const j = await ledger.post(twice);
  const r = await reader.query<{ value: string }>(
    "SELECT sum(amount_minor)::text AS value FROM ledger.ledger_entry WHERE journal_id IN ($1,$2) AND side='debit'",
    [posted.id, j.id],
  );
  assert.equal(BigInt(r.rows[0]!.value), 2n * MAX_MINOR_UNITS);
});

test('SECURITY DEFINER routines cannot be hijacked by a caller temporary UUID domain', async () => {
  const pool = new Pool({ connectionString: writerURL, max: 1 });
  const client = await pool.connect();
  try {
    // Harmless probe: would throw if a lazy routine cast resolved this caller-owned type.
    await client.query(`CREATE TEMP TABLE create_temp_namespace(id integer);
      CREATE FUNCTION pg_temp.shadow_probe(text) RETURNS boolean LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Caller-owned temporary type entered privileged routine'; END $$;
      CREATE DOMAIN pg_temp.uuid AS text CHECK(pg_temp.shadow_probe(VALUE))`);
    const c = command();
    const result = await invoke(client, 'post_journal', wire(c));
    assert.equal((await ledger.journal(result.id))!.state, 'posted');
    const configs = await admin.query<{ proconfig: string[] }>(
      "SELECT proconfig FROM pg_proc WHERE pronamespace='ledger'::regnamespace AND prosecdef",
    );
    assert.equal(configs.rowCount, 3);
    assert(
      configs.rows.every((r) =>
        r.proconfig.includes('search_path=pg_catalog, pg_temp'),
      ),
    );
  } finally {
    client.release(true);
    await pool.end();
  }
});

test('account creation is semantic/idempotent and carries durable audit/outbox', async () => {
  const c = {
    bookId,
    commandKey: randomUUID(),
    actorId: 'test-system',
    reason: 'synthetic new account',
    code: randomUUID(),
    currency: 'PHP' as const,
    classification: 'expense' as const,
    normalSide: 'debit' as const,
  };
  const first = await ledger.createAccount(c);
  assert.equal(first.replayed, false);
  assert.deepEqual(await ledger.createAccount(c), {
    id: first.id,
    replayed: true,
  });
  assert.deepEqual(
    await ledger.createAccount({ ...c, commandKey: randomUUID() }),
    { id: first.id, replayed: true },
  );
  await assert.rejects(
    ledger.createAccount({ ...c, normalSide: 'credit' }),
    hasCode('P1001'),
  );
  const result = await reader.query<{
    actor_id: string;
    database_principal: string;
  }>(
    'SELECT actor_id,database_principal FROM audit.audit_event WHERE account_id=$1',
    [first.id],
  );
  assert.deepEqual(result.rows, [
    { actor_id: 'test-system', database_principal: 'flow_test_writer' },
  ]);
  const events = await reader.query(
    'SELECT id FROM outbox.outbox_event WHERE account_id=$1',
    [first.id],
  );
  assert.equal(events.rowCount, 1);
});

test('posting is complete, balanced and invisible until atomic commit with audit/outbox', async () => {
  const c = command();
  const client = await writer.connect();
  try {
    await client.query('BEGIN');
    const result = await invoke(client, 'post_journal', wire(c));
    assert.equal(await ledger.journal(result.id), null);
    assert.equal(await effectCount(c), 0n);
    await client.query('COMMIT');
    const j = (await ledger.journal(result.id))!;
    assert.equal(j.state, 'posted');
    assert.equal(j.entries.length, 2);
    assert.equal(
      j.entries.reduce(
        (s, e) =>
          s + (e.side === 'debit' ? e.money.amountMinor : -e.money.amountMinor),
        0n,
      ),
      0n,
    );
    for (const table of ['audit.audit_event', 'outbox.outbox_event']) {
      const r = await reader.query(
        `SELECT * FROM ${table} WHERE journal_id=$1`,
        [result.id],
      );
      assert.equal(r.rowCount, 1);
    }
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});

test('raw routine rejects unbalanced posting at COMMIT and rolls back audit/outbox/receipt', async () => {
  const c = command();
  const bad = wire(c);
  bad['entries'] = [
    { accountId: debitAccount, side: 'debit', amountMinor: '100' },
    { accountId: creditAccount, side: 'credit', amountMinor: '99' },
  ];
  await assert.rejects(invoke(writer, 'post_journal', bad), hasCode('P1004'));
  await noCommittedOperation(c);
});

test('administrative SQL cannot commit header-only, constructing or one-entry journals', async () => {
  for (const kind of ['empty', 'one-entry', 'constructing']) {
    const c = command();
    const id = randomUUID();
    await transactionRejects(async (client) => {
      await client.query(
        `INSERT INTO ledger.ledger_transaction(id,book_id,currency,effect_namespace,business_effect_key,command_key,request_payload,request_hash,effective_at,policy_version,actor_id,reason)
        VALUES($1,$2,'PHP',$3,$4,$5,'{}',repeat('0',64),'2026-10-07T00:00:00Z','test','test','test')`,
        [id, bookId, c.effectNamespace, c.businessEffectKey, c.commandKey],
      );
      if (kind === 'one-entry')
        await client.query(
          "INSERT INTO ledger.ledger_entry(book_id,journal_id,line_number,account_id,currency,side,amount_minor) VALUES($1,$2,1,$3,'PHP','debit',1)",
          [bookId, id, debitAccount],
        );
      if (kind !== 'constructing')
        await client.query(
          "UPDATE ledger.ledger_transaction SET state='posted',posted_at=now() WHERE id=$1",
          [id],
        );
    }, 'P1004');
    await noCommittedOperation(c);
  }
});

test('balanced direct SQL still needs atomic receipt/audit/outbox and cannot insert posted header', async () => {
  const c = command();
  const id = randomUUID();
  await transactionRejects(async (client) => {
    await client.query(
      `INSERT INTO ledger.ledger_transaction(id,book_id,currency,effect_namespace,business_effect_key,command_key,request_payload,request_hash,effective_at,policy_version,actor_id,reason)
      VALUES($1,$2,'PHP',$3,$4,$5,'{}',repeat('0',64),'2026-10-07T00:00:00Z','test','test','test')`,
      [id, bookId, c.effectNamespace, c.businessEffectKey, c.commandKey],
    );
    await client.query(
      "INSERT INTO ledger.ledger_entry(book_id,journal_id,line_number,account_id,currency,side,amount_minor) VALUES($1,$2,1,$3,'PHP','debit',1),($1,$2,2,$4,'PHP','credit',1)",
      [bookId, id, debitAccount, creditAccount],
    );
    await client.query(
      "UPDATE ledger.ledger_transaction SET state='posted',posted_at=now() WHERE id=$1",
      [id],
    );
  }, 'P1004');
  await transactionRejects(async (client) => {
    await client.query(
      `INSERT INTO ledger.ledger_transaction(book_id,currency,effect_namespace,business_effect_key,command_key,request_payload,request_hash,effective_at,policy_version,actor_id,reason,state,posted_at)
      VALUES($1,'PHP','raw','raw','raw','{}',repeat('0',64),now(),'test','test','test','posted',now())`,
      [bookId],
    );
  }, 'P1003');
});

test('DB rejects malformed amount, side, account, currency and cross-book commands without effects', async () => {
  const variants: ((p: Record<string, unknown>) => void)[] = [
    (p) => {
      p['entries'] = [
        { accountId: debitAccount, side: 'debit', amountMinor: 100 },
        { accountId: creditAccount, side: 'credit', amountMinor: 100 },
      ];
    },
    (p) => {
      p['entries'] = [
        { accountId: debitAccount, side: 'debit', amountMinor: '0' },
        { accountId: creditAccount, side: 'credit', amountMinor: '0' },
      ];
    },
    (p) => {
      p['entries'] = [
        { accountId: debitAccount, side: 'debit', amountMinor: '-1' },
        { accountId: creditAccount, side: 'credit', amountMinor: '-1' },
      ];
    },
    (p) => {
      p['entries'] = [
        {
          accountId: debitAccount,
          side: 'debit',
          amountMinor: '9223372036854775808',
        },
        {
          accountId: creditAccount,
          side: 'credit',
          amountMinor: '9223372036854775808',
        },
      ];
    },
    (p) => {
      p['entries'] = [
        { accountId: debitAccount, side: 'debit', amountMinor: '1.0' },
        { accountId: creditAccount, side: 'credit', amountMinor: '1.0' },
      ];
    },
    (p) => {
      p['entries'] = [
        { accountId: debitAccount, side: 'other', amountMinor: '100' },
        { accountId: creditAccount, side: 'credit', amountMinor: '100' },
      ];
    },
    (p) => {
      p['entries'] = [
        { accountId: usdAccount, side: 'debit', amountMinor: '100' },
        { accountId: creditAccount, side: 'credit', amountMinor: '100' },
      ];
    },
    (p) => {
      p['entries'] = [
        { accountId: foreignAccount, side: 'debit', amountMinor: '100' },
        { accountId: creditAccount, side: 'credit', amountMinor: '100' },
      ];
    },
    (p) => {
      p['entries'] = [
        { accountId: randomUUID(), side: 'debit', amountMinor: '100' },
        { accountId: creditAccount, side: 'credit', amountMinor: '100' },
      ];
    },
    (p) => {
      p['currency'] = 'XXX';
    },
    (p) => {
      p['entries'] = [];
    },
    (p) => {
      p['extra'] = 'unexpected';
    },
    (p) => {
      p['effectiveAt'] = '2026-10-07T00:00:60.000Z';
    },
  ];
  for (const change of variants) {
    const c = command();
    const payload = wire(c);
    change(payload);
    await assert.rejects(invoke(writer, 'post_journal', payload));
    await noCommittedOperation(c);
  }
});

test('composite foreign keys and entry CHECKs reject adversarial SQL during construction', async () => {
  for (const [account, code, amount, side, error] of [
    [usdAccount, 'PHP', '1', 'debit', '23503'],
    [foreignAccount, 'PHP', '1', 'debit', '23503'],
    [debitAccount, 'USD', '1', 'debit', '23503'],
    [debitAccount, 'PHP', '0', 'debit', '23514'],
    [debitAccount, 'PHP', '-1', 'debit', '23514'],
    [debitAccount, 'PHP', '1', 'wrong', '23514'],
  ]) {
    await transactionRejects(async (client) => {
      const jid = randomUUID();
      await client.query(
        `INSERT INTO ledger.ledger_transaction(id,book_id,currency,effect_namespace,business_effect_key,command_key,request_payload,request_hash,effective_at,policy_version,actor_id,reason)
        VALUES($1,$2,'PHP','raw',$3,$3,'{}',repeat('0',64),now(),'test','test','test')`,
        [jid, bookId, randomUUID()],
      );
      await client.query(
        'INSERT INTO ledger.ledger_entry(book_id,journal_id,line_number,account_id,currency,side,amount_minor) VALUES($1,$2,1,$3,$4,$5,$6)',
        [bookId, jid, account, code, side, amount],
      );
    }, error!);
  }
});

test('every posted journal/entry field, audit/outbox and receipt are append-only, including admin SQL', async () => {
  const posted = await ledger.post(command());
  const attempts = [
    'UPDATE ledger.ledger_entry SET amount_minor=amount_minor+1 WHERE journal_id=$1',
    "UPDATE ledger.ledger_entry SET side=CASE side WHEN 'debit' THEN 'credit' ELSE 'debit' END WHERE journal_id=$1",
    'UPDATE ledger.ledger_entry SET account_id=$2 WHERE journal_id=$1',
    "UPDATE ledger.ledger_entry SET currency='USD' WHERE journal_id=$1",
    'DELETE FROM ledger.ledger_entry WHERE journal_id=$1',
    "UPDATE ledger.ledger_transaction SET reason='changed' WHERE id=$1",
    "UPDATE ledger.ledger_transaction SET business_effect_key='changed' WHERE id=$1",
    'UPDATE ledger.ledger_transaction SET effective_at=now() WHERE id=$1',
    "UPDATE ledger.ledger_transaction SET state='constructing',posted_at=NULL WHERE id=$1",
    'DELETE FROM ledger.ledger_transaction WHERE id=$1',
    "UPDATE audit.audit_event SET reason='changed' WHERE journal_id=$1",
    'DELETE FROM audit.audit_event WHERE journal_id=$1',
    "UPDATE outbox.outbox_event SET payload='{}' WHERE journal_id=$1",
    'DELETE FROM outbox.outbox_event WHERE journal_id=$1',
    'DELETE FROM ledger.command_receipt WHERE journal_id=$1',
  ];
  const original = await ledger.journal(posted.id);
  for (const sql of attempts) {
    const values = sql.includes('$2')
      ? [posted.id, creditAccount]
      : [posted.id];
    await assert.rejects(admin.query(sql, values), hasCode('P1003'));
    await assert.rejects(writer.query(sql, values), hasCode('42501'));
  }
  for (const table of [
    'ledger.ledger_account',
    'ledger.ledger_transaction',
    'ledger.ledger_entry',
    'ledger.command_receipt',
    'audit.audit_event',
    'outbox.outbox_event',
  ])
    await assert.rejects(
      admin.query(`TRUNCATE ${table} CASCADE`),
      hasCode('P1003'),
    );
  await assert.rejects(
    admin.query(
      "UPDATE ledger.ledger_account SET classification='expense' WHERE id=$1",
      [debitAccount],
    ),
    hasCode('P1003'),
  );
  await assert.rejects(
    admin.query(
      "UPDATE ledger.currency_definition SET minor_unit_scale=3 WHERE code='PHP'",
    ),
    hasCode('P1003'),
  );
  await assert.rejects(
    admin.query(
      "INSERT INTO ledger.ledger_entry(book_id,journal_id,line_number,account_id,currency,side,amount_minor) VALUES($1,$2,3,$3,'PHP','debit',1)",
      [bookId, posted.id, debitAccount],
    ),
    hasCode('P1003'),
  );
  assert.deepEqual(await ledger.journal(posted.id), original);
});

test('same command and same business effect replay; conflicting payload/key semantics fail', async () => {
  const c = command();
  const first = await ledger.post(c);
  assert.deepEqual(await ledger.post(c), { id: first.id, replayed: true });
  assert.deepEqual(
    await ledger.post({ ...c, entries: [...c.entries].reverse() }),
    { id: first.id, replayed: true },
  );
  assert.deepEqual(
    await ledger.post({
      ...c,
      commandKey: randomUUID(),
      actorId: 'another-trusted-caller',
    }),
    { id: first.id, replayed: true },
  );
  const changed = {
    ...c,
    entries: c.entries.map((e) => ({ ...e, money: Money.of(101n, 'PHP') })),
  };
  await assert.rejects(ledger.post(changed), hasCode('P1001'));
  await assert.rejects(
    ledger.post({ ...changed, commandKey: randomUUID() }),
    hasCode('P1001'),
  );
  await assert.rejects(
    ledger.post({ ...c, businessEffectKey: randomUUID() }),
    hasCode('P1001'),
  );
  assert.equal(await effectCount(c), 1n);
  const genuinelyDifferent = await ledger.post({
    ...c,
    commandKey: randomUUID(),
    businessEffectKey: randomUUID(),
  });
  assert.notEqual(genuinelyDifferent.id, first.id);
  for (const table of ['audit.audit_event', 'outbox.outbox_event'])
    assert.equal(
      (
        await reader.query(`SELECT id FROM ${table} WHERE journal_id=$1`, [
          first.id,
        ])
      ).rowCount,
      1,
    );
});

test(
  '100 synchronized duplicate callers: 99 proven blocked, exactly one committed effect',
  { timeout: 30000 },
  async () => {
    const c = command();
    const first = await writer.connect();
    const racePool = new Pool({
      connectionString: writerURL,
      max: 99,
      application_name: 'duplicate-race',
    });
    const raceLedger = new PostgresLedger(racePool, reader);
    let pending: Promise<CommandResult[]> | undefined;
    try {
      await first.query('BEGIN');
      const winner = await invoke(first, 'post_journal', wire(c));
      pending = Promise.all(
        Array.from({ length: 99 }, () => raceLedger.post(c)),
      );
      await blockedCount('duplicate-race', 99);
      assert.equal(await effectCount(c), 0n);
      await first.query('COMMIT');
      const results = [winner, ...(await pending)];
      assert.equal(results.length, 100);
      assert(results.every((r) => r.id === winner.id));
      assert.equal(results.filter((r) => !r.replayed).length, 1);
      assert.equal(await effectCount(c), 1n);
      const entries = await reader.query(
        'SELECT id FROM ledger.ledger_entry WHERE journal_id=$1',
        [winner.id],
      );
      assert.equal(entries.rowCount, 2);
    } finally {
      await first.query('ROLLBACK');
      first.release();
      await pending?.catch(() => {});
      await racePool.end();
    }
  },
);

test('same effect through concurrent different command aliases still produces one effect', async () => {
  const c = command();
  const first = await writer.connect();
  const pool = new Pool({
    connectionString: writerURL,
    max: 15,
    application_name: 'effect-race',
  });
  let pending: Promise<CommandResult[]> | undefined;
  try {
    await first.query('BEGIN');
    const winner = await invoke(first, 'post_journal', wire(c));
    const api = new PostgresLedger(pool);
    pending = Promise.all(
      Array.from({ length: 15 }, () =>
        api.post({ ...c, commandKey: randomUUID() }),
      ),
    );
    await blockedCount('effect-race', 15);
    await first.query('COMMIT');
    assert((await pending).every((r) => r.id === winner.id && r.replayed));
    assert.equal(await effectCount(c), 1n);
  } finally {
    await first.query('ROLLBACK');
    first.release();
    await pending?.catch(() => {});
    await pool.end();
  }
});

test('conflicting concurrent reuse waits then explicitly rejects, never posts twice', async () => {
  const c = command();
  const first = await writer.connect();
  const pool = new Pool({
    connectionString: writerURL,
    max: 1,
    application_name: 'conflict-race',
  });
  let pending: Promise<PromiseSettledResult<CommandResult>[]> | undefined;
  try {
    await first.query('BEGIN');
    await invoke(first, 'post_journal', wire(c));
    const bad = {
      ...c,
      entries: c.entries.map((e) => ({ ...e, money: Money.of(200n, 'PHP') })),
    };
    pending = Promise.allSettled([new PostgresLedger(pool).post(bad)]);
    await blockedCount('conflict-race', 1);
    await first.query('COMMIT');
    const result = (await pending)[0]!;
    assert.equal(result.status, 'rejected');
    if (result.status === 'rejected')
      assert(
        result.reason instanceof LedgerDatabaseError &&
          result.reason.code === 'P1001',
      );
    assert.equal(await effectCount(c), 1n);
  } finally {
    await first.query('ROLLBACK');
    first.release();
    await pending;
    await pool.end();
  }
});

test('full reversal preserves originals, neutralizes account effects and defers reversal-of-reversal', async () => {
  const c = command(54321n);
  const beforeDebit = await ledger.accountDelta(debitAccount);
  const beforeCredit = await ledger.accountDelta(creditAccount);
  const original = await ledger.post(c);
  const snapshot = await ledger.journal(original.id);
  const r = reversal(original.id);
  const reversed = await ledger.reverse(r);
  assert.deepEqual(await ledger.journal(original.id), snapshot);
  assert.equal((await ledger.journal(reversed.id))!.reversalOf, original.id);
  assert.equal(await ledger.accountDelta(debitAccount), beforeDebit);
  assert.equal(await ledger.accountDelta(creditAccount), beforeCredit);
  assert.deepEqual(await ledger.reverse(r), {
    id: reversed.id,
    replayed: true,
  });
  assert.deepEqual(await ledger.reverse({ ...r, commandKey: randomUUID() }), {
    id: reversed.id,
    replayed: true,
  });
  await assert.rejects(
    ledger.reverse({
      ...r,
      commandKey: randomUUID(),
      reason: 'different correction',
    }),
    hasCode('P1001'),
  );
  await assert.rejects(ledger.reverse(reversal(reversed.id)), hasCode('P1005'));
  assert.equal(
    (
      await reader.query(
        'SELECT id FROM ledger.ledger_transaction WHERE reversal_of=$1',
        [original.id],
      )
    ).rowCount,
    1,
  );
  const audit = await reader.query<{ reversal_of: string }>(
    'SELECT reversal_of FROM audit.audit_event WHERE journal_id=$1',
    [reversed.id],
  );
  assert.equal(audit.rows[0]!.reversal_of, original.id);
});

test('20 competing reversal commands: original row lock and unique reversal permit one full reversal', async () => {
  const original = await ledger.post(command());
  const r = reversal(original.id);
  const first = await writer.connect();
  const pool = new Pool({
    connectionString: writerURL,
    max: 19,
    application_name: 'reversal-race',
  });
  let pending: Promise<CommandResult[]> | undefined;
  try {
    await first.query('BEGIN');
    const winner = await invoke(first, 'reverse_journal', r);
    const api = new PostgresLedger(pool);
    pending = Promise.all(
      Array.from({ length: 19 }, () =>
        api.reverse({ ...r, commandKey: randomUUID() }),
      ),
    );
    await blockedCount('reversal-race', 19);
    await first.query('COMMIT');
    assert((await pending).every((x) => x.id === winner.id && x.replayed));
    assert.equal(
      (
        await reader.query(
          'SELECT id FROM ledger.ledger_transaction WHERE reversal_of=$1',
          [original.id],
        )
      ).rowCount,
      1,
    );
  } finally {
    await first.query('ROLLBACK');
    first.release();
    await pending?.catch(() => {});
    await pool.end();
  }
});

test('privileged malformed balanced reversal is rejected by exact inversion guard', async () => {
  const original = await ledger.post(command());
  const c = command(200n);
  const p = wire({
    ...c,
    effectNamespace: 'ledger.reversal',
    businessEffectKey: original.id,
  });
  await assert.rejects(
    admin.query('SELECT ledger.post_internal($1::jsonb,$2::uuid)', [
      JSON.stringify(p),
      original.id,
    ]),
    hasCode('P1005'),
  );
  assert.equal(
    (
      await reader.query(
        'SELECT id FROM ledger.ledger_transaction WHERE reversal_of=$1',
        [original.id],
      )
    ).rowCount,
    0,
  );
});

test('rollback before commit loses no partial financial truth; retry uses same semantic identity', async () => {
  const c = command();
  const client = await writer.connect();
  try {
    await client.query('BEGIN');
    await invoke(client, 'post_journal', wire(c));
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
  await noCommittedOperation(c);
  const posted = await ledger.post(c);
  assert.equal(posted.replayed, false);
  assert.equal(await effectCount(c), 1n);
});

test('caller-owned transaction composes multiple typed ledger commands without nested commits', async () => {
  const a = command();
  const b = command();
  const client = await writer.connect();
  try {
    await client.query('BEGIN');
    const commands = ledgerCommandsInTransaction(client);
    const first = await commands.post(a);
    const second = await commands.post(b);
    assert.equal(await ledger.journal(first.id), null);
    assert.equal(await ledger.journal(second.id), null);
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
  await noCommittedOperation(a);
  await noCommittedOperation(b);
});

test('commands retain their semantic snapshot while waiting for a database connection', async () => {
  const pool = new Pool({ connectionString: writerURL, max: 1 });
  const queuedLedger = new PostgresLedger(pool, reader);
  async function queued<T>(
    submit: () => Promise<T>,
    mutate: () => void,
  ): Promise<T> {
    const held = await pool.connect();
    let pending: Promise<T>;
    try {
      pending = submit();
      assert.equal(
        pool.waitingCount,
        1,
        'command must actually wait for a connection',
      );
      mutate();
    } finally {
      held.release();
    }
    return pending;
  }
  try {
    const account = {
      bookId,
      commandKey: randomUUID(),
      actorId: 'test-system',
      reason: 'original account meaning',
      code: randomUUID(),
      currency: 'PHP' as const,
      classification: 'asset' as const,
      normalSide: 'debit' as const,
    };
    const originalAccount = { ...account };
    const created = await queued(
      () => queuedLedger.createAccount(account),
      () => {
        account.code = randomUUID();
        account.commandKey = randomUUID();
        account.reason = 'mutated after submission';
      },
    );
    assert.deepEqual(await queuedLedger.createAccount(originalAccount), {
      id: created.id,
      replayed: true,
    });
    const row = await admin.query<{ code: string }>(
      'SELECT code FROM ledger.ledger_account WHERE id=$1',
      [created.id],
    );
    assert.equal(row.rows[0]!.code, originalAccount.code);

    const posted = await ledger.post(command(37n));
    const reverse = { ...reversal(posted.id) };
    const originalReverse = { ...reverse };
    const reversed = await queued(
      () => queuedLedger.reverse(reverse),
      () => {
        reverse.originalJournalId = randomUUID();
        reverse.commandKey = randomUUID();
        reverse.reason = 'mutated after submission';
      },
    );
    assert.equal(
      (await queuedLedger.journal(reversed.id))!.reversalOf,
      posted.id,
    );
    assert.deepEqual(await queuedLedger.reverse(originalReverse), {
      id: reversed.id,
      replayed: true,
    });
  } finally {
    await pool.end();
  }
});

test('pre-transaction validation failure leaves no database writes', async () => {
  const c = command();
  const bad = {
    ...c,
    entries: [c.entries[0]!, { ...c.entries[1]!, money: Money.of(99n, 'PHP') }],
  };
  await assert.rejects(ledger.post(bad), /balance/);
  await noCommittedOperation(c);
});

test('real PostgreSQL transient SQLSTATE failures retry whole unchanged commands', async () => {
  await admin.query(`CREATE SEQUENCE public.phase1_retry_seq;
    GRANT USAGE ON SEQUENCE public.phase1_retry_seq TO flow_ledger_owner;
    CREATE FUNCTION public.phase1_transient_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.command_key LIKE 'retry-%' AND nextval('public.phase1_retry_seq') % 2 = 1 THEN
        IF NEW.command_key LIKE 'retry-deadlock-%' THEN RAISE EXCEPTION USING ERRCODE='40P01', MESSAGE='Injected deadlock victim';
        ELSE RAISE EXCEPTION USING ERRCODE='40001', MESSAGE='Injected serialization victim'; END IF;
      END IF; RETURN NEW; END $$;
    CREATE TRIGGER phase1_transient BEFORE INSERT ON outbox.outbox_event FOR EACH ROW EXECUTE FUNCTION public.phase1_transient_insert()`);
  try {
    for (const category of ['deadlock', 'serialization']) {
      const c = {
        ...command(),
        commandKey: `retry-${category}-${randomUUID()}`,
      };
      assert.equal((await ledger.post(c)).replayed, false);
      assert.equal(await effectCount(c), 1n);
      for (const table of ['audit.audit_event', 'outbox.outbox_event'])
        assert.equal(
          (
            await reader.query(`SELECT id FROM ${table} WHERE command_key=$1`, [
              c.commandKey,
            ])
          ).rowCount,
          1,
        );
    }
  } finally {
    await admin.query(
      'DROP TRIGGER phase1_transient ON outbox.outbox_event; DROP FUNCTION public.phase1_transient_insert(); DROP SEQUENCE public.phase1_retry_seq',
    );
  }
});

test('actual multi-command deadlock rolls back its victim; retrying both keys cannot duplicate effects', async () => {
  const a = command();
  const b = command();
  const left = await writer.connect();
  const right = await writer.connect();
  try {
    await left.query('BEGIN');
    await right.query('BEGIN');
    await invoke(left, 'post_journal', wire(a));
    await invoke(right, 'post_journal', wire(b));
    async function contender(
      client: PoolClient,
      c: PostJournalCommand,
    ): Promise<string> {
      try {
        await invoke(client, 'post_journal', wire(c));
        await client.query('COMMIT');
        return 'committed';
      } catch (error) {
        await client.query('ROLLBACK');
        assert(hasCode('40P01')(error));
        return 'deadlock_victim';
      }
    }
    const results = await Promise.all([
      contender(left, b),
      contender(right, a),
    ]);
    assert.equal(results.filter((x) => x === 'deadlock_victim').length, 1);
    assert.equal(results.filter((x) => x === 'committed').length, 1);
  } finally {
    await left.query('ROLLBACK');
    await right.query('ROLLBACK');
    left.release();
    right.release();
  }
  assert.equal((await ledger.post(a)).replayed, true);
  assert.equal((await ledger.post(b)).replayed, true);
  assert.equal(await effectCount(a), 1n);
  assert.equal(await effectCount(b), 1n);
});

test('targeted test-only failures before audit and before outbox roll back all prior writes', async () => {
  await admin.query(
    `CREATE FUNCTION public.phase1_fail_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.command_key LIKE 'injected-%' THEN RAISE EXCEPTION 'Injected failure before durable companion record'; END IF; RETURN NEW; END $$`,
  );
  try {
    for (const table of ['audit.audit_event', 'outbox.outbox_event']) {
      await admin.query(
        `CREATE TRIGGER phase1_fail BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION public.phase1_fail_insert()`,
      );
      try {
        const c = { ...command(), commandKey: `injected-${randomUUID()}` };
        await assert.rejects(
          invoke(writer, 'post_journal', wire(c)),
          hasCode('P0001'),
        );
        await noCommittedOperation(c);
      } finally {
        await admin.query(`DROP TRIGGER phase1_fail ON ${table}`);
      }
    }
  } finally {
    await admin.query('DROP FUNCTION public.phase1_fail_insert()');
  }
});

test('backend crash with uncommitted posting rolls back, unchanged command retry succeeds', async () => {
  const c = command();
  const client = await writer.connect();
  client.on('error', () => {});
  try {
    const pid = await client.query<{ pid: number }>(
      'SELECT pg_backend_pid() AS pid',
    );
    await client.query('BEGIN');
    await invoke(client, 'post_journal', wire(c));
    await admin.query('SELECT pg_terminate_backend($1)', [pid.rows[0]!.pid]);
    await assert.rejects(client.query('COMMIT'));
  } finally {
    client.release(true);
  }
  await noCommittedOperation(c);
  assert.equal((await ledger.post(c)).replayed, false);
  assert.equal(await effectCount(c), 1n);
});

test('actual lost COMMIT acknowledgement raises unknown outcome; unchanged retry finds one effect and durable intent', async () => {
  const proxy = await commitDropProxy(writerURL);
  const pool = new Pool({ connectionString: proxy.url, max: 1 });
  const api = new PostgresLedger(pool);
  const c = command();
  try {
    await assert.rejects(api.post(c), UnknownCommitOutcome);
    await proxy.dropped;
    assert.equal(await effectCount(c), 1n);
    const replay = await ledger.post(c);
    assert.equal(replay.replayed, true);
    assert.equal(await effectCount(c), 1n);
    for (const table of ['audit.audit_event', 'outbox.outbox_event'])
      assert.equal(
        (
          await reader.query(`SELECT id FROM ${table} WHERE journal_id=$1`, [
            replay.id,
          ])
        ).rowCount,
        1,
      );
  } finally {
    await pool.end();
    await proxy.close();
  }
});

test('disconnect after commit before publication retains outbox without any publisher', async () => {
  const c = command();
  const client = await writer.connect();
  let id: string;
  try {
    await client.query('BEGIN');
    id = (await invoke(client, 'post_journal', wire(c))).id;
    await client.query('COMMIT');
  } finally {
    client.release(true);
  }
  const r = await reader.query<{
    payload: { journalId: string };
    schema_version: number;
    aggregate_version: number;
  }>(
    'SELECT payload,schema_version,aggregate_version FROM outbox.outbox_event WHERE journal_id=$1',
    [id!],
  );
  assert.equal(r.rowCount, 1);
  assert.equal(r.rows[0]!.payload.journalId, id!);
  assert.equal(r.rows[0]!.schema_version, 1);
  assert.equal(r.rows[0]!.aggregate_version, 1);
  assert.equal((await ledger.post(c)).id, id!);
});

test('property: generated multi-entry journals, reorder/repeat, reversal and wide account aggregates', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.bigInt({ min: 1n, max: MAX_MINOR_UNITS }), {
        minLength: 1,
        maxLength: 6,
      }),
      fc.integer({ min: 1, max: 5 }),
      async (amounts, repeats) => {
        const c = command();
        const entries = amounts.flatMap((amount) => [
          {
            accountId: debitAccount,
            side: 'debit' as const,
            money: Money.of(amount, 'PHP'),
          },
          {
            accountId: creditAccount,
            side: 'credit' as const,
            money: Money.of(amount, 'PHP'),
          },
        ]);
        const input = { ...c, entries };
        const beforeD = await ledger.accountDelta(debitAccount);
        const beforeC = await ledger.accountDelta(creditAccount);
        const first = await ledger.post(input);
        for (let i = 0; i < repeats; i++)
          assert.deepEqual(
            await ledger.post({ ...input, entries: [...entries].reverse() }),
            { id: first.id, replayed: true },
          );
        assert.equal(await effectCount(input), 1n);
        const original = (await ledger.journal(first.id))!;
        assert.equal(
          original.entries.reduce(
            (s, e) =>
              s +
              (e.side === 'debit' ? e.money.amountMinor : -e.money.amountMinor),
            0n,
          ),
          0n,
        );
        const reverse = await ledger.reverse(reversal(first.id));
        assert.notEqual(reverse.id, first.id);
        assert.deepEqual(await ledger.journal(first.id), original);
        assert.equal(await ledger.accountDelta(debitAccount), beforeD);
        assert.equal(await ledger.accountDelta(creditAccount), beforeC);
      },
    ),
    { numRuns: 50, seed: 70104 },
  );
});

test('migration hash consistency rejects edited history', async () => {
  const original = await admin.query<{ checksum: string }>(
    'SELECT checksum FROM public.flow_schema_migration WHERE name=$1',
    ['001_financial_core.sql'],
  );
  try {
    await admin.query(
      "UPDATE public.flow_schema_migration SET checksum=repeat('0',64) WHERE name=$1",
      ['001_financial_core.sql'],
    );
    await assert.rejects(migrate(admin), /checksum changed/);
  } finally {
    await admin.query(
      'UPDATE public.flow_schema_migration SET checksum=$1 WHERE name=$2',
      [original.rows[0]!.checksum, '001_financial_core.sql'],
    );
  }
});

test('independent final sweep: every journal balances, is immutable posted truth and has companions', async () => {
  const bad =
    await reader.query(`SELECT j.id FROM ledger.ledger_transaction j LEFT JOIN ledger.ledger_entry e ON e.journal_id=j.id
    GROUP BY j.id HAVING j.state <> 'posted' OR count(e.id)<2 OR sum(CASE e.side WHEN 'debit' THEN e.amount_minor::numeric ELSE -e.amount_minor::numeric END)<>0`);
  assert.equal(bad.rowCount, 0);
  const missing =
    await reader.query(`SELECT j.id FROM ledger.ledger_transaction j
    WHERE NOT EXISTS(SELECT FROM audit.audit_event a WHERE a.journal_id=j.id)
       OR NOT EXISTS(SELECT FROM outbox.outbox_event o WHERE o.journal_id=j.id)
       OR NOT EXISTS(SELECT FROM ledger.command_receipt c WHERE c.journal_id=j.id)`);
  assert.equal(missing.rowCount, 0);
});
