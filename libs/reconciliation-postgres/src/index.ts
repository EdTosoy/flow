import type { Pool, PoolClient } from 'pg';
import {
  serializeCommand,
  type RunCommand,
  type RunResult,
} from '@flow/reconciliation-domain';
export class ReconciliationDatabaseError extends Error {
  constructor(readonly code: string) {
    super('Reconciliation command rejected (' + code + ')');
  }
}
export class UnknownReconciliationCommit extends Error {
  constructor(
    readonly identity: string,
    options: ErrorOptions,
  ) {
    super(
      'Commit outcome unknown; retry unchanged reconciliation command',
      options,
    );
  }
}
function codeOf(error: unknown): string | undefined {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : undefined;
}
export class PostgresReconciliation {
  constructor(
    private readonly writer: Pool,
    private readonly reader: Pool = writer,
  ) {}
  async create(command: RunCommand): Promise<string> {
    const payload = serializeCommand(command);
    return this.transaction(
      payload,
      async (c) =>
        (
          await c.query<{ id: string }>(
            'SELECT reconciliation.create_run($1::jsonb) AS id',
            [payload],
          )
        ).rows[0]!.id,
    );
  }
  async seal(runId: string): Promise<void> {
    await this.transaction(
      runId,
      async (c) => {
        await c.query('SELECT reconciliation.seal($1::uuid)', [runId]);
      },
      true,
    );
  }
  async plan(runId: string): Promise<void> {
    await this.transaction(runId, async (c) => {
      await c.query('SELECT reconciliation.plan($1::uuid)', [runId]);
    });
  }
  async advance(runId: string, limit = 100): Promise<number> {
    return this.transaction(
      runId,
      async (c) =>
        (
          await c.query<{ n: number }>(
            'SELECT reconciliation.advance($1::uuid,$2::integer) AS n',
            [runId, limit],
          )
        ).rows[0]!.n,
    );
  }
  async complete(runId: string): Promise<void> {
    await this.transaction(runId, async (c) => {
      await c.query('SELECT reconciliation.complete($1::uuid)', [runId]);
    });
  }
  async run(command: RunCommand): Promise<RunResult> {
    const snapshot = JSON.parse(serializeCommand(command)) as RunCommand;
    const id = await this.create(snapshot);
    await this.seal(id);
    await this.plan(id);
    while (await this.advance(id)) {
      /* durable bounded progress; retry resumes unchanged run */
    }
    await this.complete(id);
    return this.summary(id);
  }
  async summary(id: string): Promise<RunResult> {
    return (
      await this.reader.query<{ result: RunResult }>(
        'SELECT reconciliation.summary($1::uuid) AS result',
        [id],
      )
    ).rows[0]!.result;
  }
  private async transaction<T>(
    identity: string,
    operation: (client: PoolClient) => Promise<T>,
    snapshot = false,
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const client = await this.writer.connect();
      let committing = false,
        discard = false;
      const onError = (): void => {
        discard = true;
      };
      client.on('error', onError);
      try {
        await client.query(
          snapshot
            ? 'BEGIN ISOLATION LEVEL REPEATABLE READ'
            : 'BEGIN ISOLATION LEVEL READ COMMITTED',
        );
        await client.query(
          "SET LOCAL synchronous_commit=on; SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='30s'; SET LOCAL idle_in_transaction_session_timeout='30s'",
        );
        const result = await operation(client);
        committing = true;
        await client.query('COMMIT');
        return result;
      } catch (error) {
        const code = codeOf(error);
        try {
          await client.query('ROLLBACK');
        } catch {
          discard = true;
        }
        if ((code === '40001' || code === '40P01') && attempt < 4) {
          await new Promise((r) => setTimeout(r, 10 * 2 ** attempt));
          continue;
        }
        if (committing && !(code && /^(22|23|40|42|P[12456])/.test(code))) {
          discard = true;
          throw new UnknownReconciliationCommit(identity, { cause: error });
        }
        if (code) throw new ReconciliationDatabaseError(code);
        throw error;
      } finally {
        client.removeListener('error', onError);
        client.release(discard);
      }
    }
  }
}
