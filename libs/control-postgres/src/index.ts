import type { Pool, PoolClient } from 'pg';
import {
  serializeControl,
  type ControlCommand,
  type ControlSummary,
} from '@flow/control-domain';
export class ControlDatabaseError extends Error {
  constructor(readonly code: string) {
    super('Control command rejected (' + code + ')');
  }
}
export class UnknownControlCommit extends Error {
  constructor(
    readonly identity: string,
    options: ErrorOptions,
  ) {
    super('Control commit outcome unknown; retry unchanged command', options);
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
export class PostgresControls {
  constructor(
    private readonly writer: Pool,
    private readonly reader: Pool = writer,
  ) {}
  async create(command: ControlCommand): Promise<string> {
    const payload = serializeControl(command);
    return this.transaction(
      payload,
      async (c) =>
        (
          await c.query<{ id: string }>(
            'SELECT controls.create_run($1::jsonb) AS id',
            [payload],
          )
        ).rows[0]!.id,
    );
  }
  async freeze(id: string): Promise<void> {
    await this.transaction(
      id,
      async (c) => {
        await c.query('SELECT controls.freeze($1::uuid)', [id]);
      },
      true,
    );
  }
  async evaluate(id: string, limit = 100): Promise<number> {
    return this.transaction(
      id,
      async (c) =>
        (
          await c.query<{ n: number }>(
            'SELECT controls.evaluate($1::uuid,$2::integer) AS n',
            [id, limit],
          )
        ).rows[0]!.n,
    );
  }
  async complete(id: string): Promise<void> {
    await this.transaction(id, async (c) => {
      await c.query('SELECT controls.complete($1::uuid)', [id]);
    });
  }
  async run(command: ControlCommand): Promise<ControlSummary> {
    const id = await this.create(command);
    await this.freeze(id);
    while (await this.evaluate(id)) {}
    await this.complete(id);
    return this.summary(id);
  }
  async summary(id: string): Promise<ControlSummary> {
    return (
      await this.reader.query<{ result: ControlSummary }>(
        'SELECT controls.summary($1::uuid) AS result',
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
        if (committing && !(code && /^(22|23|40|42|P[1245689])/.test(code))) {
          discard = true;
          throw new UnknownControlCommit(identity, { cause: error });
        }
        if (code) throw new ControlDatabaseError(code);
        throw error;
      } finally {
        client.removeListener('error', onError);
        client.release(discard);
      }
    }
  }
}
