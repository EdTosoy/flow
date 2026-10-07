import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, after, test } from 'node:test';
import { Pool, type PoolClient } from 'pg';
import fc from 'fast-check';
import {
  canonicalJson,
  batchPayload,
  normalize,
  type RawInput,
  type NormalizerVersion,
} from '@flow/ingestion-domain';
import { PostgresIngestion } from '@flow/ingestion-postgres';
import { PostgresBank, UnknownBankCommit } from '@flow/bank-postgres';
import { commitDropProxy } from './helpers/commit-proxy';
const au = process.env['FLOW_TEST_ADMIN_URL'],
  bu = process.env['FLOW_TEST_BANK_URL'],
  iu = process.env['FLOW_TEST_INGESTION_URL'];
if (!au || !bu || !iu) throw new Error('Run pnpm test:integration');
const admin = new Pool({ connectionString: au }),
  bp = new Pool({ connectionString: bu, max: 20 }),
  ip = new Pool({ connectionString: iu });
const ingestion = new PostgresIngestion(ip),
  bank = new PostgresBank(bp),
  book = randomUUID();
before(async () => {
  await admin.query(
    "INSERT INTO ledger.book(id,code,environment) VALUES($1,$2,'synthetic')",
    [book, 'bank-' + book],
  );
});
after(async () => {
  await Promise.all([admin.end(), bp.end(), ip.end()]);
});
const money = (amountMinor: string, currency = 'PHP') => ({
  amountMinor,
  currency,
});
const time = '2026-01-02T00:00:00.000Z';
function entry(
  id: string | null,
  amount = '970000',
  extra: Record<string, unknown> = {},
): RawInput {
  return raw(id, 'synthetic-bank-entry', {
    id,
    status: 'booked',
    amount: money(amount),
    bookedAt: time,
    ...extra,
  });
}
function statement(id = 's', extra: Record<string, unknown> = {}): RawInput {
  return raw(id, 'synthetic-bank-statement', {
    id,
    currency: 'PHP',
    reportedAt: '2026-01-04T00:00:00.000Z',
    ...extra,
  });
}
function raw(id: string | null, kind: string, payload: unknown): RawInput {
  return {
    locator: id ?? 'no-id',
    objectKind: kind,
    externalId: id,
    sourceRevision: null,
    sequence: null,
    sourceObservedAt: null,
    bytes: Buffer.from(canonicalJson(payload)),
  };
}
async function account() {
  return ingestion.registerSource({
    bookId: book,
    environment: 'synthetic',
    provider: 'synthetic-bank-test',
    externalAccountId: randomUUID(),
  });
}
async function normalized(
  aid: string,
  records: RawInput[],
  version: NormalizerVersion = 'synthetic-bank-entry-v1',
) {
  const b = await ingestion.ingest({
    sourceAccountId: aid,
    batchKey: randomUUID(),
    actorId: 'bank-test',
    provenance: { adapter: 'test-bank-v1' },
    records,
  });
  await ingestion.requestNormalization(b.id, version, 'bank-test');
  await ingestion.normalizeBatch(b.id, version);
  const revisions = (
    await ip.query<{ revision_id: string }>(
      'SELECT revision_id FROM ingestion.raw_record WHERE batch_id=$1 ORDER BY receipt_order',
      [b.id],
    )
  ).rows.map((r) => r.revision_id);
  return { batchId: b.id, revisions };
}
async function derived(
  aid: string,
  records: RawInput[],
  version: NormalizerVersion = 'synthetic-bank-entry-v1',
) {
  const n = await normalized(aid, records, version);
  const results = [];
  for (const rev of n.revisions) results.push(await bank.derive(rev, version));
  return { ...n, results };
}
const code = (expected: string) => (e: unknown) =>
  typeof e === 'object' && e !== null && 'code' in e && e.code === expected;
async function rejected(
  fn: (c: PoolClient) => Promise<unknown>,
  expected: string,
) {
  const c = await admin.connect();
  try {
    await c.query('BEGIN');
    await assert.rejects(async () => {
      await fn(c);
      await c.query('COMMIT');
    }, code(expected));
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}
async function contend(
  aid: string,
  work: (api: PostgresBank, i: number) => Promise<unknown>,
  n = 12,
  beforeRelease?: (c: PoolClient) => Promise<void>,
) {
  const name = randomUUID(),
    p = new Pool({ connectionString: bu, application_name: name, max: n }),
    api = new PostgresBank(p),
    c = await admin.connect();
  try {
    await c.query('BEGIN');
    await c.query(
      'SELECT FROM ingestion.source_account WHERE id=$1 FOR UPDATE',
      [aid],
    );
    const pending = Promise.allSettled(
      Array.from({ length: n }, (_, i) => work(api, i)),
    );
    let blocked = false;
    const until = Date.now() + 8000;
    while (Date.now() < until) {
      const r = (
        await admin.query(
          "SELECT count(*)::integer n FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'",
          [name],
        )
      ).rows[0];
      if (r.n === n) {
        blocked = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(blocked, 'All bank workers must actually block in PostgreSQL');
    if (beforeRelease) await beforeRelease(c);
    await c.query('COMMIT');
    return await pending;
  } finally {
    await c.query('ROLLBACK');
    c.release();
    await p.end();
  }
}
function values(results: PromiseSettledResult<unknown>[]) {
  return results.map((r) => {
    assert.equal(r.status, 'fulfilled');
    return (r as PromiseFulfilledResult<{ id: string; accountId: string }>)
      .value;
  });
}

test('bank entry exact magnitude, dates, scoped account, provenance and separate stock observations', async () => {
  const aid = await account(),
    d = await derived(aid, [
      entry('e', '-9007199254740993', {
        sourceOccurredAt: '2026-01-01T04:05:06.789Z',
        valueDate: '2026-01-03',
        bankReference: 'source-ref',
        runningBalance: money('-123'),
      }),
    ]);
  const row = (
    await bp.query(
      'SELECT e.*,d.account_id,d.normalizer_version,d.interpreter_version,i.basis_raw_id,r.payload_bytes FROM bank.entry e JOIN bank.derivation d ON d.id=e.id JOIN ingestion.interpretation i ON i.revision_id=d.revision_id AND i.normalizer_version=d.normalizer_version JOIN ingestion.raw_record r ON r.id=i.basis_raw_id WHERE e.id=$1',
      [d.results[0]!.id],
    )
  ).rows[0];
  assert.equal(row.direction, 'DEBIT');
  assert.equal(row.amount_minor, '9007199254740993');
  assert.equal(row.booked_at.toISOString(), time);
  assert.equal(
    row.source_occurred_at.toISOString(),
    '2026-01-01T04:05:06.789Z',
  );
  assert.equal(row.normalizer_version, 'synthetic-bank-entry-v1');
  assert.equal(row.interpreter_version, 'bank-v1');
  assert.deepEqual(
    row.payload_bytes,
    entry('e', '-9007199254740993', {
      sourceOccurredAt: '2026-01-01T04:05:06.789Z',
      valueDate: '2026-01-03',
      bankReference: 'source-ref',
      runningBalance: money('-123'),
    }).bytes,
  );
  const balance = (
    await bp.query(
      'SELECT kind,amount_minor::text FROM bank.balance_observation WHERE derivation_id=$1',
      [row.id],
    )
  ).rows[0];
  assert.deepEqual(balance, { kind: 'RUNNING', amount_minor: '-123' });
  const other = await derived(await account(), [entry('e')]);
  assert.notEqual(other.results[0]!.accountId, d.results[0]!.accountId);
  const usd = await derived(aid, [
    entry('usd', '1', { amount: money('1', 'USD') }),
  ]);
  assert.notEqual(usd.results[0]!.accountId, d.results[0]!.accountId);
  assert.equal(
    (await bank.summary(aid)).totals.find((t) => t.currency === 'PHP')!
      .debitsMinor,
    '9007199254740993',
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

test('statements use independent source line evidence, stock conservation and reported disagreement', async () => {
  const aid = await account();
  await derived(aid, [
    entry('a', '1000', {
      statementReference: 's',
      lineIdentity: 'a',
      sequence: 1,
    }),
    entry('b', '-200', {
      statementReference: 's',
      lineIdentity: 'b',
      sequence: 2,
    }),
  ]);
  const s = await derived(
    aid,
    [
      statement('s', {
        opening: money('100'),
        closing: money('900'),
        expectedLineCount: 2,
        lineIds: ['a', 'b'],
        sequenceRange: { from: 1, to: 2 },
        period: {
          from: '2026-01-01T00:00:00.000Z',
          to: '2026-01-03T00:00:00.000Z',
        },
      }),
    ],
    'synthetic-bank-statement-v1',
  );
  const evaluation = await bank.evaluate(s.results[0]!.id, 'first');
  assert.deepEqual(evaluation.result.controls, []);
  assert.equal(evaluation.result.completeness, 'PROVEN_COMPLETE');
  assert.equal(evaluation.result.calculatedClosingMinor, '900');
  assert.equal(evaluation.result.reportedClosingMinor, '900');
  assert.equal(evaluation.result.arithmeticStatus, 'PASS');
  const mismatchAid = await account();
  await derived(mismatchAid, [
    entry('a', '1000', { statementReference: 's', lineIdentity: 'a' }),
  ]);
  const bad = await derived(
    mismatchAid,
    [
      statement('s', {
        opening: money('0'),
        closing: money('999'),
        lineIds: ['a'],
      }),
    ],
    'synthetic-bank-statement-v1',
  );
  const e = await bank.evaluate(bad.results[0]!.id, 'mismatch');
  assert.equal(e.result.calculatedClosingMinor, '1000');
  assert.equal(e.result.reportedClosingMinor, '999');
  assert.equal(e.result.arithmeticStatus, 'FAIL');
  assert.deepEqual(e.result.controls, ['CLOSING_BALANCE_MISMATCH']);
  assert.equal(
    (
      await bp.query(
        'SELECT count(*)::integer n FROM audit.audit_event WHERE bank_evaluation_id=$1',
        [e.id],
      )
    ).rows[0].n,
    1,
  );
  assert.equal((await bank.evaluate(bad.results[0]!.id, 'mismatch')).id, e.id);
});

test('unknown completeness and missing balances remain null; independently empty statements preserve zero', async () => {
  const aid = await account(),
    s = await derived(aid, [statement()], 'synthetic-bank-statement-v1');
  const e = (await bank.evaluate(s.results[0]!.id, 'unknown')).result;
  assert.equal(e.completeness, 'UNKNOWN');
  assert.equal(e.openingMinor, null);
  assert.equal(e.reportedClosingMinor, null);
  assert.equal(e.calculatedClosingMinor, null);
  assert.equal(e.arithmeticStatus, 'UNVERIFIED');
  const zero = await derived(
    await account(),
    [
      statement('zero', {
        opening: money('0'),
        closing: money('0'),
        expectedLineCount: 0,
        lineIds: [],
      }),
    ],
    'synthetic-bank-statement-v1',
  );
  assert.equal(
    (await bank.evaluate(zero.results[0]!.id, 'zero')).result
      .calculatedClosingMinor,
    '0',
  );
  assert.equal(
    (
      await bp.query(
        'SELECT count(*)::integer n FROM bank.balance_observation WHERE derivation_id=$1',
        [s.results[0]!.id],
      )
    ).rows[0].n,
    0,
  );
});

test('explicit bank controls retain count/reference gaps, duplicates, currency and impossible ordering', async () => {
  const aid = await account();
  await derived(aid, [
    entry('a', '10', {
      statementReference: 's',
      lineIdentity: 'same',
      sequence: 1,
    }),
    entry('b', '20', {
      statementReference: 's',
      lineIdentity: 'same',
      sequence: 1,
    }),
    entry('c', '30', {
      statementReference: 's',
      lineIdentity: 'c',
      sequence: 3,
      amount: money('30', 'USD'),
    }),
  ]);
  const s = await derived(
    aid,
    [
      statement('s', {
        opening: money('0'),
        closing: money('60'),
        expectedLineCount: 4,
        lineIds: ['same', 'same', 'missing'],
        sequenceRange: { from: 1, to: 4 },
        period: {
          from: '2026-01-03T00:00:00.000Z',
          to: '2026-01-01T00:00:00.000Z',
        },
      }),
    ],
    'synthetic-bank-statement-v1',
  );
  const e = (await bank.evaluate(s.results[0]!.id, 'controls')).result;
  for (const c of [
    'LINE_COUNT_MISMATCH',
    'DUPLICATE_SOURCE_LINE_REFERENCE',
    'MISSING_REFERENCED_LINE',
    'DUPLICATE_LINE_IDENTITY',
    'SEQUENCE_COVERAGE_FAILED',
    'CROSS_CURRENCY_MEMBERSHIP',
    'INVALID_STATEMENT_ORDERING',
    'ENTRY_OUTSIDE_STATEMENT_PERIOD',
  ])
    assert.ok(e.controls.includes(c), c);
  assert.equal(e.completeness, 'PROVEN_INCOMPLETE');
  assert.equal(e.calculatedClosingMinor, null);
  assert.equal(e.reportedClosingMinor, '60');
});

test('statement-only count evidence does not hide omission masked by duplicate sequence', async () => {
  const aid = await account();
  await derived(aid, [
    entry('a', '10', { statementReference: 's', sequence: 1 }),
    entry('b', '10', { statementReference: 's', sequence: 1 }),
  ]);
  const s = await derived(
    aid,
    [
      statement('s', {
        expectedLineCount: 2,
        sequenceRange: { from: 1, to: 2 },
        opening: money('0'),
        closing: money('20'),
      }),
    ],
    'synthetic-bank-statement-v1',
  );
  const r = (await bank.evaluate(s.results[0]!.id, 'sequence')).result;
  assert.equal(r.receivedLineCount, 2);
  assert.equal(r.completeness, 'PROVEN_INCOMPLETE');
  assert.ok(r.controls.includes('SEQUENCE_COVERAGE_FAILED'));
  assert.equal(r.arithmeticStatus, 'UNVERIFIED');
});

test('missing stable bank ID is observation-only, same revision replays without claiming cross-receipt identity', async () => {
  const aid = await account(),
    n = await derived(aid, [
      entry(null, '100', { statementReference: 's', lineIdentity: 'line' }),
    ]);
  assert.equal(
    (await bank.derive(n.revisions[0]!, 'synthetic-bank-entry-v1')).id,
    n.results[0]!.id,
  );
  const second = await derived(aid, [
    entry(null, '100', { statementReference: 's', lineIdentity: 'line' }),
  ]);
  assert.notEqual(second.results[0]!.id, n.results[0]!.id);
  const summary = await bank.summary(aid);
  assert.equal(summary.observationOnlyEntries, 2);
  assert.deepEqual(summary.totals, []);
  const s = await derived(
    aid,
    [
      statement('s', {
        opening: money('0'),
        closing: money('100'),
        expectedLineCount: 1,
      }),
    ],
    'synthetic-bank-statement-v1',
  );
  const r = (await bank.evaluate(s.results[0]!.id, 'no-id')).result;
  assert.ok(r.controls.includes('UNVERIFIED_ENTRY_IDENTITY'));
  assert.equal(r.calculatedClosingMinor, null);
});

test('corrections and source-token conflicts retain immutable old entries, balances and as-of evaluations', async () => {
  const aid = await account();
  const old = await derived(aid, [
    {
      ...entry('e', '970000', { statementReference: 's', lineIdentity: 'e' }),
      sourceRevision: 'opaque-1',
    },
  ]);
  const s = await derived(
    aid,
    [
      statement('s', {
        opening: money('0'),
        closing: money('970000'),
        lineIds: ['e'],
      }),
    ],
    'synthetic-bank-statement-v1',
  );
  const before = await bank.evaluate(s.results[0]!.id, 'before');
  const corrected = await derived(aid, [
    {
      ...entry('e', '960000', {
        statementReference: 'different',
        lineIdentity: 'e',
      }),
      sourceRevision: 'opaque-1',
    },
  ]);
  assert.notEqual(old.results[0]!.id, corrected.results[0]!.id);
  assert.equal(
    (await bank.evaluate(s.results[0]!.id, 'before')).result
      .calculatedClosingMinor,
    '970000',
  );
  const after = (await bank.evaluate(s.results[0]!.id, 'after')).result;
  assert.ok(after.controls.includes('AMBIGUOUS_ENTRY'));
  assert.ok(after.controls.includes('CONFLICTING_STATEMENT_ASSOCIATION'));
  assert.equal(after.calculatedClosingMinor, null);
  const rows = (
    await bp.query(
      'SELECT amount_minor::text,source_unambiguous,revision_state FROM bank.current_entry WHERE source_account_id=$1 ORDER BY amount_minor',
      [aid],
    )
  ).rows;
  assert.deepEqual(
    rows.map((r) => r.amount_minor),
    ['960000', '970000'],
  );
  assert.ok(
    rows.every(
      (r) => !r.source_unambiguous && r.revision_state === 'REVIEW_REQUIRED',
    ),
  );
  const status = (
    await ip.query(
      'SELECT conflicting_source_token FROM ingestion.fact_status WHERE source_account_id=$1 AND external_id=$2',
      [aid, 'e'],
    )
  ).rows[0];
  assert.equal(status.conflicting_source_token, true);
  assert.equal(before.result.arithmeticStatus, 'PASS');
  const reportCorrection = await derived(
    aid,
    [
      statement('s', {
        opening: money('0'),
        closing: money('960000'),
        lineIds: ['e'],
      }),
    ],
    'synthetic-bank-statement-v1',
  );
  assert.notEqual(reportCorrection.results[0]!.id, s.results[0]!.id);
  assert.ok(
    (
      await bank.evaluate(reportCorrection.results[0]!.id, 'corrected')
    ).result.controls.includes('AMBIGUOUS_STATEMENT'),
  );
});

test('real DB property: exact value, N-fold derivation replay and correction preservation', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.bigInt({ min: 1n, max: 9223372036854775806n }),
      fc.integer({ min: 1, max: 5 }),
      async (amount, replays) => {
        const aid = await account(),
          old = await derived(aid, [entry('e', amount.toString())]);
        for (let i = 0; i < replays; i++)
          assert.equal(
            (await bank.derive(old.revisions[0]!, 'synthetic-bank-entry-v1'))
              .id,
            old.results[0]!.id,
          );
        await derived(aid, [entry('e', (amount + 1n).toString())]);
        const rows = (
          await bp.query(
            'SELECT amount_minor::text FROM bank.entry WHERE source_account_id=$1 ORDER BY amount_minor',
            [aid],
          )
        ).rows;
        assert.deepEqual(
          rows.map((r) => r.amount_minor),
          [amount.toString(), (amount + 1n).toString()],
        );
        assert.equal(
          (
            await bp.query(
              'SELECT count(*)::integer n FROM outbox.outbox_event o JOIN bank.derivation d ON d.id=o.bank_derivation_id WHERE d.source_account_id=$1',
              [aid],
            )
          ).rows[0].n,
          2,
        );
      },
    ),
    { numRuns: 25, seed: 70504 },
  );
});

test('twelve blocked duplicate derivations converge on one bank fact and outbox intent', async () => {
  const aid = await account(),
    n = await normalized(aid, [entry('e')]);
  const results = values(
    await contend(aid, (api) =>
      api.derive(n.revisions[0]!, 'synthetic-bank-entry-v1'),
    ),
  );
  assert.equal(new Set(results.map((r) => r.id)).size, 1);
  assert.equal(
    (
      await bp.query(
        'SELECT count(*)::integer n FROM outbox.outbox_event WHERE bank_derivation_id=$1',
        [results[0]!.id],
      )
    ).rows[0].n,
    1,
  );
});
test('twelve blocked related statement memberships share one group and account identity', async () => {
  const aid = await account(),
    n = await normalized(
      aid,
      Array.from({ length: 12 }, (_, i) =>
        entry('e' + i, '100', {
          statementReference: 's',
          lineIdentity: 'e' + i,
        }),
      ),
    );
  const results = values(
    await contend(aid, (api, i) =>
      api.derive(n.revisions[i]!, 'synthetic-bank-entry-v1'),
    ),
  );
  assert.equal(new Set(results.map((r) => r.accountId)).size, 1);
  assert.equal(
    (
      await bp.query(
        'SELECT count(DISTINCT group_id)::integer n FROM bank.membership WHERE source_account_id=$1',
        [aid],
      )
    ).rows[0].n,
    1,
  );
  const repeated = values(
    await contend(aid, (api) =>
      api.derive(n.revisions[0]!, 'synthetic-bank-entry-v1'),
    ),
  );
  assert.equal(new Set(repeated.map((r) => r.id)).size, 1);
  assert.equal(
    (
      await bp.query(
        'SELECT count(*)::integer n FROM bank.membership WHERE source_account_id=$1',
        [aid],
      )
    ).rows[0].n,
    12,
  );
});
test('concurrent conflicting statement association preserves both histories and explicit conflict', async () => {
  const aid = await account(),
    old = await normalized(aid, [
      entry('e', '100', { statementReference: 'one', lineIdentity: 'e' }),
    ]),
    corrected = await normalized(aid, [
      entry('e', '99', { statementReference: 'two', lineIdentity: 'e' }),
    ]);
  values(
    await contend(aid, (api, i) =>
      api.derive(
        (i % 2 ? old : corrected).revisions[0]!,
        'synthetic-bank-entry-v1',
      ),
    ),
  );
  for (const ref of ['one', 'two']) {
    const s = await derived(
      aid,
      [
        statement(ref, {
          lineIds: ['e'],
          opening: money('0'),
          closing: money('100'),
        }),
      ],
      'synthetic-bank-statement-v1',
    );
    const r = (await bank.evaluate(s.results[0]!.id, 'concurrent')).result;
    assert.ok(r.controls.includes('CONFLICTING_STATEMENT_ASSOCIATION'));
    assert.ok(r.controls.includes('AMBIGUOUS_ENTRY'));
    assert.equal(r.calculatedClosingMinor, null);
  }
  assert.equal(
    (
      await bp.query(
        'SELECT count(*)::integer n FROM bank.membership WHERE source_account_id=$1',
        [aid],
      )
    ).rows[0].n,
    2,
  );
});
test('correction arriving while original derivation waits does not select receipt-time truth', async () => {
  const aid = await account(),
    n = await normalized(aid, [entry('e', '970000')]);
  values(
    await contend(
      aid,
      (api) => api.derive(n.revisions[0]!, 'synthetic-bank-entry-v1'),
      12,
      async (c) => {
        const r = entry('e', '960000');
        const p = batchPayload({
          sourceAccountId: aid,
          batchKey: randomUUID(),
          actorId: 'test-correction',
          provenance: {},
          records: [r],
        });
        const b = (
          await c.query('SELECT ingestion.accept_batch($1::jsonb) result', [p])
        ).rows[0].result.id;
        await c.query(
          "SELECT ingestion.request_normalization($1,'synthetic-bank-entry-v1','test')",
          [b],
        );
        const rawId = (
          await c.query(
            'SELECT id FROM ingestion.raw_record WHERE batch_id=$1',
            [b],
          )
        ).rows[0].id;
        await c.query(
          "SELECT ingestion.complete_normalization($1,'synthetic-bank-entry-v1',$2::jsonb)",
          [
            rawId,
            JSON.stringify(normalize(r.bytes, 'e', 'synthetic-bank-entry-v1')),
          ],
        );
      },
    ),
  );
  assert.equal((await bank.summary(aid)).ambiguousEntries, 1);
  assert.deepEqual((await bank.summary(aid)).totals, []);
  const newRev = (
    await ip.query(
      "SELECT i.revision_id FROM ingestion.interpretation i JOIN ingestion.revision r ON r.id=i.revision_id WHERE r.source_account_id=$1 AND i.normalizer_version='synthetic-bank-entry-v1' AND i.amount_minor=960000",
      [aid],
    )
  ).rows[0].revision_id;
  await bank.derive(newRev, 'synthetic-bank-entry-v1');
  assert.equal((await bank.summary(aid)).entries, 2);
});

test('runtime capabilities and immutable/sealed bank histories are enforced by PostgreSQL', async () => {
  const aid = await account(),
    d = await derived(aid, [
      entry('e', '10', {
        statementReference: 's',
        lineIdentity: 'e',
        runningBalance: money('10'),
      }),
    ]);
  for (const sql of [
    'UPDATE bank.entry SET amount_minor=1',
    'DELETE FROM bank.entry',
    'TRUNCATE bank.entry',
    "INSERT INTO bank.account(source_account_id,currency) VALUES(gen_random_uuid(),'PHP')",
    'SET ROLE flow_ledger_owner',
    "SELECT ledger.post_journal('{}'::jsonb)",
    'SELECT * FROM processor.activity',
  ])
    await assert.rejects(bp.query(sql), code('42501'));
  for (const table of [
    'account',
    'statement_group',
    'derivation',
    'entry',
    'membership',
    'balance_observation',
  ]) {
    await rejected(
      (c) =>
        c.query(
          `UPDATE bank.${table} SET ${table === 'entry' ? 'amount_minor=amount_minor' : table === 'balance_observation' ? 'amount_minor=amount_minor' : table === 'membership' ? 'line_identity=line_identity' : 'id=id'}`,
        ),
      'P1003',
    );
    await rejected((c) => c.query(`DELETE FROM bank.${table}`), 'P1003');
    await rejected((c) => c.query(`TRUNCATE bank.${table} CASCADE`), 'P1003');
  }
  await rejected(
    (c) =>
      c.query(
        "INSERT INTO bank.membership(entry_id,source_account_id,group_id,line_identity) SELECT entry_id,source_account_id,group_id,'forged' FROM bank.membership WHERE entry_id=$1",
        [d.results[0]!.id],
      ),
    'P5003',
  );
  await assert.rejects(
    bank.derive(d.revisions[0]!, 'synthetic-bank-entry-v1', 'unknown-v2'),
    code('P5002'),
  );
});

async function injected(table: string, work: () => Promise<unknown>) {
  const name = 'bank_fail_' + randomUUID().replaceAll('-', '');
  await admin.query(
    `CREATE FUNCTION public.${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION USING ERRCODE='P5999',MESSAGE='Synthetic bank failure'; END $$`,
  );
  await admin.query(
    `CREATE TRIGGER ${name} BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION public.${name}()`,
  );
  try {
    await assert.rejects(work(), code('P5999'));
  } finally {
    await admin.query(`DROP TRIGGER ${name} ON ${table}`);
    await admin.query(`DROP FUNCTION public.${name}()`);
  }
}
test('crash windows during account, entry, membership, balance and intent creation roll back only bank derivation', async () => {
  for (const table of [
    'bank.account',
    'bank.entry',
    'bank.membership',
    'bank.balance_observation',
    'outbox.outbox_event',
  ]) {
    const aid = await account(),
      n = await normalized(aid, [
        entry('e', '100', {
          statementReference: 's',
          lineIdentity: 'e',
          runningBalance: money('100'),
        }),
      ]);
    await injected(table, () =>
      bank.derive(n.revisions[0]!, 'synthetic-bank-entry-v1'),
    );
    assert.equal(
      (
        await bp.query(
          'SELECT count(*)::integer n FROM bank.derivation WHERE source_account_id=$1',
          [aid],
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (
        await ip.query(
          'SELECT count(*)::integer n FROM ingestion.interpretation WHERE revision_id=$1 AND state=$2',
          [n.revisions[0], 'NORMALIZED'],
        )
      ).rows[0].n,
      1,
    );
    await bank.derive(n.revisions[0]!, 'synthetic-bank-entry-v1');
  }
  for (const table of ['bank.statement', 'bank.statement_reference']) {
    const aid = await account(),
      n = await normalized(
        aid,
        [statement('s', { lineIds: ['missing'], opening: money('0') })],
        'synthetic-bank-statement-v1',
      );
    await injected(table, () =>
      bank.derive(n.revisions[0]!, 'synthetic-bank-statement-v1'),
    );
    await bank.derive(n.revisions[0]!, 'synthetic-bank-statement-v1');
  }
});
test('control evaluation links and financial audit are atomic under failure and retries', async () => {
  const aid = await account();
  await derived(aid, [
    entry('a', '10', { statementReference: 's', lineIdentity: 'a' }),
  ]);
  const s = await derived(
    aid,
    [
      statement('s', {
        opening: money('0'),
        closing: money('9'),
        lineIds: ['a'],
      }),
    ],
    'synthetic-bank-statement-v1',
  );
  for (const table of ['bank.evaluation_entry', 'audit.audit_event']) {
    const key = randomUUID();
    await injected(table, () => bank.evaluate(s.results[0]!.id, key));
    assert.equal(
      (
        await bp.query(
          'SELECT count(*)::integer n FROM bank.evaluation WHERE statement_id=$1 AND evaluation_key=$2',
          [s.results[0]!.id, key],
        )
      ).rows[0].n,
      0,
    );
    const e = await bank.evaluate(s.results[0]!.id, key);
    assert.ok(e.result.controls.includes('CLOSING_BALANCE_MISMATCH'));
    assert.equal((await bank.evaluate(s.results[0]!.id, key)).id, e.id);
  }
});
test('actual backend crash before COMMIT retains normalized input and no partial bank population', async () => {
  for (const kind of ['entry', 'statement']) {
    const aid = await account(),
      v =
        kind === 'entry'
          ? 'synthetic-bank-entry-v1'
          : 'synthetic-bank-statement-v1',
      n = await normalized(
        aid,
        [
          kind === 'entry'
            ? entry('e', '100', { statementReference: 's' })
            : statement('s', { lineIds: ['e'] }),
        ],
        v,
      );
    const c = await admin.connect();
    c.on('error', () => {});
    try {
      await c.query('BEGIN');
      await c.query('SELECT bank.derive($1,$2,$3)', [
        n.revisions[0],
        v,
        'bank-v1',
      ]);
      const pid = (await c.query('SELECT pg_backend_pid() pid')).rows[0].pid;
      await admin.query('SELECT pg_terminate_backend($1)', [pid]);
      await assert.rejects(c.query('COMMIT'));
    } finally {
      c.release(true);
    }
    assert.equal(
      (
        await bp.query(
          'SELECT count(*)::integer n FROM bank.derivation WHERE source_account_id=$1',
          [aid],
        )
      ).rows[0].n,
      0,
    );
    const d = await bank.derive(n.revisions[0]!, v);
    assert.equal((await bank.derive(n.revisions[0]!, v)).id, d.id);
  }
});
test('real lost COMMIT acknowledgements recover derivation and control snapshot by unchanged identity', async () => {
  const aid = await account(),
    n = await normalized(aid, [
      entry('e', '100', { statementReference: 's', lineIdentity: 'e' }),
    ]);
  const proxy = await commitDropProxy(bu!),
    p = new Pool({ connectionString: proxy.url });
  p.on('error', () => {});
  try {
    await assert.rejects(
      new PostgresBank(p).derive(n.revisions[0]!, 'synthetic-bank-entry-v1'),
      UnknownBankCommit,
    );
    await proxy.dropped;
  } finally {
    await p.end();
    await proxy.close();
  }
  const recovered = await bank.derive(
    n.revisions[0]!,
    'synthetic-bank-entry-v1',
  );
  assert.equal(recovered.replayed, true);
  const s = await derived(
    aid,
    [
      statement('s', {
        opening: money('0'),
        closing: money('99'),
        lineIds: ['e'],
      }),
    ],
    'synthetic-bank-statement-v1',
  );
  const proxy2 = await commitDropProxy(bu!),
    p2 = new Pool({ connectionString: proxy2.url });
  p2.on('error', () => {});
  try {
    await assert.rejects(
      new PostgresBank(p2).evaluate(s.results[0]!.id, 'lost'),
      UnknownBankCommit,
    );
    await proxy2.dropped;
  } finally {
    await p2.end();
    await proxy2.close();
  }
  const e = await bank.evaluate(s.results[0]!.id, 'lost');
  assert.equal(e.replayed, true);
  assert.equal(
    (
      await bp.query(
        'SELECT count(*)::integer n FROM audit.audit_event WHERE bank_evaluation_id=$1',
        [e.id],
      )
    ).rows[0].n,
    1,
  );
});

test('real PostgreSQL statement conservation property uses independent supplied counts and exact signed stocks', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.bigInt({ min: -100000000000000000n, max: 100000000000000000n }),
      fc.array(
        fc
          .bigInt({ min: -10000000000000000n, max: 10000000000000000n })
          .filter((n) => n !== 0n),
        { maxLength: 8 },
      ),
      async (opening, amounts) => {
        const aid = await account(),
          ids = amounts.map((_, i) => 'line-' + i);
        if (amounts.length)
          await derived(
            aid,
            amounts.map((n, i) =>
              entry(ids[i]!, n.toString(), {
                statementReference: 's',
                lineIdentity: ids[i],
                sequence: i + 1,
              }),
            ),
          );
        const close = opening + amounts.reduce((a, b) => a + b, 0n);
        const s = await derived(
          aid,
          [
            statement('s', {
              opening: money(opening.toString()),
              closing: money(close.toString()),
              expectedLineCount: amounts.length,
              lineIds: ids,
            }),
          ],
          'synthetic-bank-statement-v1',
        );
        const e = (await bank.evaluate(s.results[0]!.id, 'conservation'))
          .result;
        assert.deepEqual(e.controls, []);
        assert.equal(e.calculatedClosingMinor, close.toString());
        assert.equal(e.arithmeticStatus, 'PASS');
        assert.equal(e.completeness, 'PROVEN_COMPLETE');
      },
    ),
    { numRuns: 20, seed: 70508 },
  );
});

test('deferred guards reject orphan derivation, forged normalized bank data and incomplete/forged control snapshots', async () => {
  const aid = await account(),
    d = await derived(aid, [
      entry('e', '10', { statementReference: 's', lineIdentity: 'e' }),
    ]);
  const row = (
    await bp.query('SELECT * FROM bank.derivation WHERE id=$1', [
      d.results[0]!.id,
    ])
  ).rows[0];
  // Exact new interpreter registry fixture only probes completeness; it does not claim implemented v2 behavior.
  const version = 'test-bank-' + randomUUID();
  await admin.query('INSERT INTO bank.interpreter_version VALUES($1,$2)', [
    version,
    'Disposable guard probe',
  ]);
  await rejected(
    (c) =>
      c.query(
        "INSERT INTO bank.derivation(revision_id,normalizer_version,interpreter_version,source_account_id,fact_id,account_id,currency,kind,identity_kind) VALUES($1,$2,$3,$4,$5,$6,$7,'entry','SOURCE_ID')",
        [
          row.revision_id,
          row.normalizer_version,
          version,
          row.source_account_id,
          row.fact_id,
          row.account_id,
          row.currency,
        ],
      ),
    'P5004',
  );
  const n = await normalized(aid, [entry('fresh')]);
  const rawId = (
    await ip.query('SELECT id FROM ingestion.raw_record WHERE revision_id=$1', [
      n.revisions[0],
    ])
  ).rows[0].id;
  await rejected(
    (c) =>
      c.query(
        "INSERT INTO ingestion.interpretation(revision_id,normalizer_version,basis_raw_id,result,result_checksum,state,amount_minor,currency,occurred_at,direction) VALUES($1,'synthetic-bank-entry-v1',$2,$3::jsonb,encode(sha256(convert_to(($3::jsonb)::text,'UTF8')),'hex'),'NORMALIZED',1,'PHP',$4,'inflow')",
        [
          n.revisions[0],
          rawId,
          JSON.stringify(
            normalize(entry('fresh').bytes, 'fresh', 'synthetic-bank-entry-v1'),
          ),
          time,
        ],
      ),
    'P2003',
  );
  const s = await derived(
      aid,
      [
        statement('s', {
          opening: money('0'),
          closing: money('9'),
          lineIds: ['e'],
        }),
      ],
      'synthetic-bank-statement-v1',
    ),
    sid = s.results[0]!.id;
  await rejected(
    (c) =>
      c.query(
        "INSERT INTO bank.evaluation(statement_id,source_account_id,evaluation_key,interpreter_version,input,result) VALUES($1,$2,'forged','bank-v1','{}','{\"controls\":[]}')",
        [sid, aid],
      ),
    'P5003',
  );
  const snapshot = (
    await admin.query("SELECT bank.statement_snapshot($1,'bank-v1') snapshot", [
      sid,
    ])
  ).rows[0].snapshot;
  await rejected(
    (c) =>
      c.query(
        "INSERT INTO bank.evaluation(statement_id,source_account_id,evaluation_key,interpreter_version,input,result) VALUES($1,$2,'orphan-links','bank-v1',$3,$4)",
        [sid, aid, snapshot.input, snapshot.result],
      ),
    'P5004',
  );
  const e = await bank.evaluate(sid, 'valid');
  for (const table of [
    'statement',
    'statement_reference',
    'evaluation',
    'evaluation_entry',
    'interpreter_version',
  ]) {
    const col =
      table === 'statement_reference'
        ? 'line_identity'
        : table === 'evaluation_entry'
          ? 'entry_id'
          : table === 'interpreter_version'
            ? 'contract'
            : 'id';
    await rejected(
      (c) => c.query(`UPDATE bank.${table} SET ${col}=${col}`),
      'P1003',
    );
    await rejected((c) => c.query(`DELETE FROM bank.${table}`), 'P1003');
    await rejected((c) => c.query(`TRUNCATE bank.${table} CASCADE`), 'P1003');
  }
  await rejected(
    (c) =>
      c.query('INSERT INTO bank.evaluation_entry VALUES($1,$2)', [
        e.id,
        d.results[0]!.id,
      ]),
    'P5003',
  );
});

test('whole-command retryable SQLSTATEs preserve identity and concurrent successful evaluation retries converge', async () => {
  for (const sqlstate of ['40001', '40P01']) {
    const aid = await account(),
      n = await normalized(aid, [entry('e')]),
      name = 'bank_retry_' + randomUUID().replaceAll('-', '');
    await admin.query(`CREATE SEQUENCE public.${name}`);
    await admin.query(
      `GRANT USAGE ON SEQUENCE public.${name} TO flow_ledger_owner`,
    );
    await admin.query(
      `CREATE FUNCTION public.${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF nextval('public.${name}')=1 THEN RAISE EXCEPTION USING ERRCODE='${sqlstate}',MESSAGE='Synthetic retryable failure'; END IF; RETURN NEW; END $$`,
    );
    await admin.query(
      `CREATE TRIGGER ${name} BEFORE INSERT ON bank.derivation FOR EACH ROW EXECUTE FUNCTION public.${name}()`,
    );
    try {
      const d = await bank.derive(n.revisions[0]!, 'synthetic-bank-entry-v1');
      assert.equal(
        (await bank.derive(n.revisions[0]!, 'synthetic-bank-entry-v1')).id,
        d.id,
      );
      assert.equal(
        (
          await bp.query(
            'SELECT count(*)::integer n FROM bank.derivation WHERE source_account_id=$1',
            [aid],
          )
        ).rows[0].n,
        1,
      );
    } finally {
      await admin.query(`DROP TRIGGER ${name} ON bank.derivation`);
      await admin.query(`DROP FUNCTION public.${name}()`);
      await admin.query(`DROP SEQUENCE public.${name}`);
    }
  }
  const aid = await account(),
    s = await derived(
      aid,
      [statement('s', { expectedLineCount: 1, lineIds: ['missing'] })],
      'synthetic-bank-statement-v1',
    );
  const r = values(
    await contend(aid, (api) =>
      api.evaluate(s.results[0]!.id, 'concurrent-retry'),
    ),
  );
  assert.equal(new Set(r.map((e) => e.id)).size, 1);
  assert.equal(
    (
      await bp.query(
        'SELECT count(*)::integer n FROM audit.audit_event WHERE bank_evaluation_id=$1',
        [r[0]!.id],
      )
    ).rows[0].n,
    1,
  );
});

test('malformed bank money/direction/time remains durable failed evidence, with no invented bank movement', async () => {
  const aid = await account();
  const bad = [
    entry('sign', '10', { direction: 'DEBIT' }),
    {
      ...entry('number'),
      bytes: Buffer.from(
        '{"id":"number","status":"booked","amount":{"amountMinor":9007199254740993,"currency":"PHP"},"bookedAt":"2026-01-02T00:00:00.000Z"}',
      ),
    },
    entry('minimum', '-9223372036854775808'),
    entry('zero', '0'),
    entry('date', '10', { valueDate: '2026-02-30' }),
    entry('currency', '10', { amount: money('10', 'XXX') }),
  ];
  const n = await normalized(aid, bad);
  assert.deepEqual(
    await bank.deriveBatch(n.batchId, 'synthetic-bank-entry-v1'),
    [],
  );
  const summary = await ingestion.summary(n.batchId, 'synthetic-bank-entry-v1');
  assert.equal(summary.received, 6);
  assert.equal(summary.failed, 6);
  assert.equal(summary.pending, 0);
  assert.equal(summary.completeness, 'UNKNOWN');
  assert.equal(
    (
      await ip.query(
        'SELECT count(*)::integer n FROM ingestion.raw_record WHERE batch_id=$1',
        [n.batchId],
      )
    ).rows[0].n,
    6,
  );
  await assert.rejects(
    bank.derive(n.revisions[0]!, 'synthetic-bank-entry-v1'),
    code('P5002'),
  );
});

test('bank snapshot booking instants are canonical UTC independently of session timezone; value date remains a date', async () => {
  const aid = await account(),
    d = await derived(aid, [
      entry('e', '10', {
        statementReference: 's',
        lineIdentity: 'e',
        valueDate: '2026-01-03',
      }),
    ]);
  assert.equal(
    (
      await bp.query(
        'SELECT value_date::text value FROM bank.entry WHERE id=$1',
        [d.results[0]!.id],
      )
    ).rows[0].value,
    '2026-01-03',
  );
  const s = await derived(
    aid,
    [
      statement('s', {
        opening: money('0'),
        closing: money('10'),
        lineIds: ['e'],
      }),
    ],
    'synthetic-bank-statement-v1',
  );
  const c = await bp.connect();
  try {
    await c.query("SET TIME ZONE 'Asia/Manila'");
    await c.query('BEGIN');
    const result = (
      await c.query('SELECT bank.evaluate($1::jsonb) result', [
        JSON.stringify({
          statementId: s.results[0]!.id,
          evaluationKey: 'manila',
          actorId: 'bank-test',
          interpreterVersion: 'bank-v1',
        }),
      ])
    ).rows[0].result;
    await c.query('COMMIT');
    const input = (
      await bp.query('SELECT input FROM bank.evaluation WHERE id=$1', [
        result.id,
      ])
    ).rows[0].input;
    assert.equal(input.entries[0].bookedAt, time);
  } finally {
    await c.query('ROLLBACK');
    await c.query("SET TIME ZONE 'UTC'");
    c.release();
  }
});
