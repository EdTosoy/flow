import type { Pool, PoolClient } from 'pg';
import { Money, currency } from '@flow/money';
import {
  effectiveTime,
  text,
  uuid,
  validateIdentity,
  validatePost,
  type CommandResult,
  type CreateAccountCommand,
  type LedgerCommands,
  type LedgerReads,
  type PostedJournal,
  type PostJournalCommand,
  type ReverseJournalCommand,
} from '@flow/ledger-domain';

export class LedgerDatabaseError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export class UnknownCommitOutcome extends Error {
  constructor(
    readonly commandKey: string,
    options: ErrorOptions,
  ) {
    super(
      'Commit outcome unknown; retry the unchanged semantic command',
      options,
    );
  }
}
function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : undefined;
}

function accountPayload(command: CreateAccountCommand): unknown {
  validateIdentity(command);
  text(command.code);
  currency(command.currency);
  return command;
}
function postPayload(command: PostJournalCommand): unknown {
  validatePost(command);
  return {
    ...command,
    entries: command.entries.map(({ accountId, side, money }) => ({
      accountId,
      side,
      amountMinor: money.amountMinor.toString(),
    })),
  };
}
function reversalPayload(command: ReverseJournalCommand): unknown {
  validateIdentity(command);
  uuid(command.originalJournalId);
  text(command.policyVersion);
  effectiveTime(command.effectiveAt);
  return command;
}

/** Caller owns BEGIN/COMMIT/ROLLBACK, retry and unknown-outcome recovery for the whole use case. */
export function ledgerCommandsInTransaction(
  client: PoolClient,
): LedgerCommands {
  async function call(
    routine: 'create_account' | 'post_journal' | 'reverse_journal',
    payload: unknown,
  ): Promise<CommandResult> {
    const result = await client.query<{ result: CommandResult }>(
      `SELECT ledger.${routine}($1::jsonb) AS result`,
      [JSON.stringify(payload)],
    );
    return result.rows[0]!.result;
  }
  return {
    createAccount: (command) => call('create_account', accountPayload(command)),
    post: (command) => call('post_journal', postPayload(command)),
    reverse: (command) => call('reverse_journal', reversalPayload(command)),
  };
}

/** No raw mutation API. Supply a writer pool for commands and optionally reader pool for reads. */
export class PostgresLedger implements LedgerCommands, LedgerReads {
  constructor(
    private readonly writer: Pool,
    private readonly reader: Pool = writer,
  ) {}

  async createAccount(command: CreateAccountCommand): Promise<CommandResult> {
    return this.execute(
      'create_account',
      accountPayload(command),
      command.commandKey,
    );
  }

  async post(command: PostJournalCommand): Promise<CommandResult> {
    return this.execute(
      'post_journal',
      postPayload(command),
      command.commandKey,
    );
  }

  async reverse(command: ReverseJournalCommand): Promise<CommandResult> {
    return this.execute(
      'reverse_journal',
      reversalPayload(command),
      command.commandKey,
    );
  }

  async journal(id: string): Promise<PostedJournal | null> {
    uuid(id);
    const result = await this.reader.query<{ journal: unknown }>(
      'SELECT ledger.read_journal($1::uuid) AS journal',
      [id],
    );
    const value = result.rows[0]?.journal;
    if (value === null) return null;
    const j = value as {
      id: string;
      bookId: string;
      currency: string;
      state: 'posted';
      reversalOf: string | null;
      entries: {
        accountId: string;
        side: 'debit' | 'credit';
        amountMinor: string;
      }[];
    };
    const code = currency(j.currency);
    return {
      id: j.id,
      bookId: j.bookId,
      currency: code,
      state: j.state,
      reversalOf: j.reversalOf,
      entries: j.entries.map((e) => ({
        accountId: e.accountId,
        side: e.side,
        money: Money.parse(e.amountMinor, code),
      })),
    };
  }

  /** Signed debit-minus-credit aggregate; may exceed an individual BIGINT value. */
  async accountDelta(accountId: string): Promise<bigint> {
    uuid(accountId);
    const result = await this.reader.query<{ delta: string }>(
      `SELECT coalesce(sum(CASE e.side WHEN 'debit' THEN e.amount_minor::numeric ELSE -e.amount_minor::numeric END), 0)::text AS delta
       FROM ledger.ledger_account a LEFT JOIN ledger.ledger_entry e ON e.account_id = a.id
       WHERE a.id = $1::uuid GROUP BY a.id`,
      [accountId],
    );
    if (!result.rows[0])
      throw new LedgerDatabaseError('P1002', 'Account not found');
    return BigInt(result.rows[0]!.delta);
  }

  private async execute(
    routine: 'create_account' | 'post_journal' | 'reverse_journal',
    payload: unknown,
    commandKey: string,
  ): Promise<CommandResult> {
    // Readonly is a compile-time boundary; snapshot once before waiting or retrying.
    const serializedPayload = JSON.stringify(payload);
    for (let attempt = 0; ; attempt++) {
      const client: PoolClient = await this.writer.connect();
      let committing = false;
      let discard = false;
      // pg also emits on the checked-out client; its query rejection alone is insufficient.
      const onClientError = (): void => {
        discard = true;
      };
      client.on('error', onClientError);
      try {
        await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
        await client.query(
          "SET LOCAL synchronous_commit = on; SET LOCAL lock_timeout = '10s'; SET LOCAL statement_timeout = '20s'; SET LOCAL idle_in_transaction_session_timeout = '20s'",
        );
        const result = await client.query<{ result: CommandResult }>(
          `SELECT ledger.${routine}($1::jsonb) AS result`,
          [serializedPayload],
        );
        committing = true;
        await client.query('COMMIT');
        return result.rows[0]!.result;
      } catch (error) {
        const code = errorCode(error);
        try {
          await client.query('ROLLBACK');
        } catch {
          discard = true;
        }
        if ((code === '40001' || code === '40P01') && attempt < 4) {
          await new Promise((resolve) =>
            setTimeout(
              resolve,
              10 * 2 ** attempt + Math.floor(Math.random() * 10),
            ),
          );
          continue;
        }
        // Identified data/constraint/rollback errors are definite; other COMMIT failures stay unknown.
        const definiteCommitRejection =
          code !== undefined && /^(22|23|40|P1)/.test(code);
        if (committing && !definiteCommitRejection) {
          discard = true;
          throw new UnknownCommitOutcome(commandKey, { cause: error });
        }
        if (code)
          throw new LedgerDatabaseError(
            code,
            error instanceof Error ? error.message : 'Database command failed',
          );
        throw error;
      } finally {
        client.removeListener('error', onClientError);
        client.release(discard);
      }
    }
  }
}
