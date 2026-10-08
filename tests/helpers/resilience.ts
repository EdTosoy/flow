/** Test-only fault coordination; never imported by runtime libraries or tools. */
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool, type PoolClient } from 'pg';
import { PostgresIntegrity } from '@flow/integrity-postgres';

export type Boundary =
  | 'beforeBegin'
  | 'afterBegin'
  | 'beforeCommand'
  | 'afterCommand'
  | 'beforeCommit';
export function intercepted(
  pool: Pool,
  hook: (
    text: string,
    client: PoolClient,
    execute: () => Promise<unknown>,
  ) => Promise<unknown>,
): Pool {
  return new Proxy(pool, {
    get(target, key) {
      if (key === 'connect')
        return async () => {
          const client = await target.connect();
          return new Proxy(client, {
            get(c, member) {
              if (member === 'query')
                return (...args: unknown[]) => {
                  const text = typeof args[0] === 'string' ? args[0] : '';
                  return hook(text, c, async () =>
                    Reflect.apply(c.query, c, args),
                  );
                };
              const value = Reflect.get(c, member);
              return typeof value === 'function' ? value.bind(c) : value;
            },
          });
        };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
export function failOnce(pool: Pool, boundary: Boundary) {
  let fired = false;
  return {
    pool: intercepted(pool, async (text, _client, execute) => {
      const begin = text.startsWith('BEGIN'),
        command =
          text.startsWith('SELECT ') && !text.includes('pg_backend_pid');
      const before =
        (boundary === 'beforeBegin' && begin) ||
        (boundary === 'beforeCommand' && command) ||
        (boundary === 'beforeCommit' && text === 'COMMIT');
      const after =
        (boundary === 'afterBegin' && begin) ||
        (boundary === 'afterCommand' && command);
      const fail = () => {
        fired = true;
        throw Object.assign(new Error('Test-only controlled interruption'), {
          code: '57014',
        });
      };
      if (!fired && before) fail();
      const result = await execute();
      if (!fired && after) fail();
      return result;
    }),
    fired: () => fired,
  };
}

export async function waitForLocks(
  admin: Pool,
  pids: number[],
  count = pids.length,
): Promise<void> {
  const deadline = performance.now() + 10000;
  while (performance.now() < deadline) {
    const observed = (
      await admin.query<{ n: number }>(
        "SELECT count(*)::integer n FROM pg_stat_activity WHERE pid=ANY($1::integer[]) AND wait_event_type='Lock'",
        [pids],
      )
    ).rows[0]!.n;
    if (observed >= count) return;
    await delay(5); // Poll observed PostgreSQL state, never use a sleep to presume contention.
  }
  throw new Error('Expected PostgreSQL contention was not observed');
}
export async function waitDue(admin: Pool, book: string): Promise<void> {
  await admin.query(
    "SELECT pg_sleep(greatest(0,extract(epoch FROM min(coalesce(w.next_attempt_at,w.lease_expires_at))-clock_timestamp()))+0.002) FROM worker.work_item w JOIN outbox.outbox_event o ON o.id=w.event_id WHERE o.book_id=$1 AND w.state IN ('PROCESSING','RETRYABLE')",
    [book],
  );
}
export async function contend(
  admin: Pool,
  book: string,
  actors: { pool: Pool; run: (pool: Pool) => Promise<unknown> }[],
) {
  const holder = await admin.connect(),
    pids: number[] = [];
  let joined: Promise<PromiseSettledResult<unknown>[]> | undefined;
  try {
    await holder.query('BEGIN');
    await holder.query(
      'SELECT id FROM ledger.book WHERE id=$1 FOR NO KEY UPDATE',
      [book],
    );
    joined = Promise.allSettled(
      actors.map((actor) =>
        actor.run(
          intercepted(actor.pool, async (text, client, execute) => {
            const result = await execute();
            if (text.startsWith('BEGIN'))
              pids.push(
                (
                  await client.query<{ pid: number }>(
                    'SELECT pg_backend_pid() pid',
                  )
                ).rows[0]!.pid,
              );
            return result;
          }),
        ),
      ),
    );
    const deadline = performance.now() + 10000;
    while (pids.length < actors.length && performance.now() < deadline)
      await delay(5);
    assert.equal(pids.length, actors.length);
    await waitForLocks(admin, pids);
    await holder.query('COMMIT');
    return await joined;
  } finally {
    await holder.query('ROLLBACK');
    holder.release();
    await joined;
  }
}
export async function clean(
  admin: Pool,
  book: string,
  runs: readonly string[] = [],
) {
  const summary = await new PostgresIntegrity(admin).sweep(book, runs);
  assert.deepEqual(summary.violations, [], 'Cross-domain invariant sweep');
  assert.equal(summary.integrity, 'PASS');
  return summary;
}
const immutableTables = [
  'ledger.ledger_account',
  'ledger.ledger_transaction',
  'ledger.ledger_entry',
  'ledger.command_receipt',
  'ingestion.source',
  'ingestion.source_account',
  'ingestion.batch',
  'ingestion.source_fact',
  'ingestion.revision',
  'ingestion.raw_record',
  'ingestion.interpretation',
  'ingestion.normalization_request',
  'processor.payment',
  'processor.derivation',
  'processor.activity',
  'processor.settlement_batch',
  'processor.membership',
  'processor.evaluation',
  'processor.evaluation_activity',
  'bank.account',
  'bank.statement_group',
  'bank.derivation',
  'bank.entry',
  'bank.statement',
  'bank.membership',
  'bank.statement_reference',
  'bank.balance_observation',
  'bank.evaluation',
  'bank.evaluation_entry',
  'reconciliation.run_member',
  'reconciliation.candidate',
  'reconciliation.group_candidate',
  'reconciliation.outcome_plan',
  'reconciliation.match_group',
  'reconciliation.match_group_member',
  'reconciliation.outcome',
  'reconciliation.allocation_decision',
  'exceptions.case_record',
  'exceptions.event',
  'exceptions.occurrence',
  'exceptions.attachment',
  'controls.input',
  'controls.result',
  'controls.case_link',
  'audit.audit_event',
  'outbox.outbox_event',
  'worker.registration',
  'worker.attempt_event',
];
/** Independent retained-row witness: new history is allowed; previous digests cannot disappear. */
export async function witness(admin: Pool) {
  const read = async () => {
    const rows = await admin.query<{ identity: string }>(
      immutableTables
        .map(
          (table) =>
            `SELECT '${table}:'||encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') AS identity FROM ${table} t`,
        )
        .join(' UNION ALL ') +
        " UNION ALL SELECT 'reconciliation.run:'||encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') FROM reconciliation.run t WHERE state='COMPLETED' UNION ALL SELECT 'controls.run:'||encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') FROM controls.run t WHERE state='COMPLETED'",
    );
    return new Set(rows.rows.map((r) => r.identity));
  };
  const before = await read();
  return async () => {
    const after = await read();
    for (const identity of before)
      assert(
        after.has(identity),
        'Retained immutable history changed: ' + identity,
      );
  };
}
