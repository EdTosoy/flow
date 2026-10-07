import type { Pool, PoolClient } from 'pg';
import {
  INTERPRETER_VERSION,
  type DerivationResult,
  type EvaluationResult,
} from '@flow/processor-domain';
export class ProcessorDatabaseError extends Error {
  constructor(readonly code: string) {
    super('Processor command rejected (' + code + ')');
  }
}
export class UnknownProcessorCommit extends Error {
  constructor(
    readonly identity: string,
    options: ErrorOptions,
  ) {
    super('Commit outcome unknown; retry unchanged processor command', options);
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
export class PostgresProcessor {
  constructor(
    private readonly writer: Pool,
    private readonly reader: Pool = writer,
  ) {}
  async derive(
    revisionId: string,
    normalizerVersion: string,
    interpreterVersion: string = INTERPRETER_VERSION,
  ): Promise<DerivationResult> {
    const values = [revisionId, normalizerVersion, interpreterVersion];
    return this.transaction(
      JSON.stringify(values),
      async (c) =>
        (
          await c.query<{ result: DerivationResult }>(
            'SELECT processor.derive($1::uuid,$2,$3) AS result',
            values,
          )
        ).rows[0]!.result,
    );
  }
  async deriveBatch(
    batchId: string,
    normalizerVersion: string,
  ): Promise<DerivationResult[]> {
    const rows = await this.reader.query<{ revision_id: string }>(
      "SELECT DISTINCT i.revision_id FROM ingestion.interpretation i JOIN ingestion.raw_record r ON r.revision_id=i.revision_id WHERE r.batch_id=$1 AND i.normalizer_version=$2 AND i.state='NORMALIZED' ORDER BY i.revision_id",
      [batchId, normalizerVersion],
    );
    const results: DerivationResult[] = [];
    for (const r of rows.rows)
      results.push(await this.derive(r.revision_id, normalizerVersion));
    return results;
  }
  async evaluate(
    kind: 'payment' | 'settlement',
    subjectId: string,
    evaluationKey: string,
    activityNormalizerVersion = 'synthetic-movement-v1',
    actorId = 'processor-developer',
    interpreterVersion: string = INTERPRETER_VERSION,
  ): Promise<EvaluationResult> {
    const payload = JSON.stringify({
      kind,
      subjectId,
      evaluationKey,
      activityNormalizerVersion,
      actorId,
      interpreterVersion,
    });
    return this.transaction(
      payload,
      async (c) =>
        (
          await c.query<{ result: EvaluationResult }>(
            'SELECT processor.evaluate($1::jsonb) AS result',
            [payload],
          )
        ).rows[0]!.result,
    );
  }
  private async transaction<T>(
    identity: string,
    operation: (client: PoolClient) => Promise<T>,
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
        await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
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
        if (committing && !(code && /^(22|23|40|42|P[124])/.test(code))) {
          discard = true;
          throw new UnknownProcessorCommit(identity, { cause: error });
        }
        if (code) throw new ProcessorDatabaseError(code);
        throw error;
      } finally {
        client.removeListener('error', onError);
        client.release(discard);
      }
    }
  }
}
