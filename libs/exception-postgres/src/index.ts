import type { Pool, PoolClient } from 'pg';
import {
  serializeCommand,
  exposureOf,
  type CaseCommand,
  type CaseView,
  type ExceptionSummary,
} from '@flow/exception-domain';
export class ExceptionDatabaseError extends Error {
  constructor(readonly code: string) {
    super('Exception command rejected (' + code + ')');
  }
}
export class UnknownExceptionCommit extends Error {
  constructor(
    readonly identity: string,
    options: ErrorOptions,
  ) {
    super('Commit outcome unknown; retry unchanged exception command', options);
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
export class PostgresExceptions {
  constructor(
    private readonly writer: Pool,
    private readonly reader: Pool = writer,
  ) {}
  async generate(runId: string, actorId: string): Promise<readonly string[]> {
    if (!runId || !actorId.trim() || actorId.length > 512)
      throw new TypeError('Invalid generation identity');
    const payload = JSON.stringify({ runId, actorId });
    return this.transaction(
      payload,
      async (c) =>
        (
          await c.query<{ ids: string[] }>(
            'SELECT exceptions.generate($1::jsonb) AS ids',
            [payload],
          )
        ).rows[0]!.ids,
    );
  }
  async apply(command: CaseCommand): Promise<CaseView> {
    const payload = serializeCommand(command);
    return this.transaction(payload, async (c) => {
      const view = (
        await c.query<{ result: CaseView }>(
          'SELECT exceptions.apply($1::jsonb) AS result',
          [payload],
        )
      ).rows[0]!.result;
      exposureOf(view);
      return view;
    });
  }
  async get(id: string): Promise<CaseView> {
    const view = (
      await this.reader.query<{ result: CaseView }>(
        'SELECT exceptions.case_view($1::uuid) AS result',
        [id],
      )
    ).rows[0]?.result;
    if (!view) throw new RangeError('Unknown exception case');
    exposureOf(view);
    return view;
  }
  async summary(mappingId: string): Promise<ExceptionSummary> {
    return (
      await this.reader.query<{ result: ExceptionSummary }>(
        'SELECT exceptions.summary($1::uuid) AS result',
        [mappingId],
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
        if (committing && !(code && /^(22|23|40|42|P[124568])/.test(code))) {
          discard = true;
          throw new UnknownExceptionCommit(identity, { cause: error });
        }
        if (code) throw new ExceptionDatabaseError(code);
        throw error;
      } finally {
        client.removeListener('error', onError);
        client.release(discard);
      }
    }
  }
}
