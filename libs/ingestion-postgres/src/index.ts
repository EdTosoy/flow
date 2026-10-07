import type { Pool, PoolClient } from 'pg';
import {
  batchPayload,
  boundedText,
  canonicalJson,
  normalize,
  normalizerVersion,
  type BatchCommand,
  type NormalizationResult,
  type NormalizerVersion,
} from '@flow/ingestion-domain';

export class IngestionDatabaseError extends Error {
  constructor(readonly code: string) {
    super(`Ingestion command rejected (${code})`);
  }
}
export class UnknownIngestionCommit extends Error {
  constructor(
    readonly identity: string,
    options: ErrorOptions,
  ) {
    super(
      'Commit outcome unknown; retry the unchanged ingestion/normalization command',
      options,
    );
  }
}
export interface BatchResult {
  readonly id: string;
  readonly replayed: boolean;
}
export interface BatchSummary {
  readonly batchId: string;
  readonly normalizerVersion: string;
  readonly received: number;
  readonly normalized: number;
  readonly failed: number;
  readonly pending: number;
  readonly distinctRevisions: number;
  readonly completeness: 'PROVEN_COMPLETE' | 'PROVEN_INCOMPLETE' | 'UNKNOWN';
}
function codeOf(error: unknown): string | undefined {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : undefined;
}
/** Controlled writes only. Caller supplies non-admin ingestion pools and owns their lifecycle. */
export class PostgresIngestion {
  constructor(
    private readonly writer: Pool,
    private readonly reader: Pool = writer,
  ) {}
  async registerSource(scope: {
    readonly bookId: string;
    readonly environment: 'synthetic' | 'test';
    readonly provider: string;
    readonly externalAccountId: string;
  }): Promise<string> {
    for (const value of Object.values(scope)) boundedText(value);
    const payload = canonicalJson(scope);
    return this.transaction(
      payload,
      async (c) =>
        (
          await c.query<{ id: string }>(
            'SELECT ingestion.register_source($1::jsonb) AS id',
            [payload],
          )
        ).rows[0]!.id,
    );
  }
  async ingest(command: BatchCommand): Promise<BatchResult> {
    const payload = batchPayload(command);
    return this.transaction(
      command.batchKey,
      async (c) =>
        (
          await c.query<{ result: BatchResult }>(
            'SELECT ingestion.accept_batch($1::jsonb) AS result',
            [payload],
          )
        ).rows[0]!.result,
    );
  }
  async requestNormalization(
    batchId: string,
    version: NormalizerVersion,
    actorId: string,
  ): Promise<void> {
    boundedText(batchId);
    normalizerVersion(version);
    boundedText(actorId);
    await this.transaction(`${batchId}:${version}`, async (c) => {
      await c.query('SELECT ingestion.request_normalization($1::uuid,$2,$3)', [
        batchId,
        version,
        actorId,
      ]);
    });
  }
  /** Computation is outside the transaction. A crash before result commit leaves PENDING. */
  async normalizeRaw(
    rawId: string,
    version: NormalizerVersion = 'synthetic-movement-v1',
  ): Promise<NormalizationResult> {
    normalizerVersion(version);
    boundedText(rawId);
    const r = (
      await this.reader.query<{
        payload_bytes: Buffer;
        external_id: string | null;
      }>(
        'SELECT payload_bytes,external_id FROM ingestion.raw_record WHERE id=$1::uuid',
        [rawId],
      )
    ).rows[0];
    if (!r) throw new IngestionDatabaseError('P2002');
    const result = normalize(r.payload_bytes, r.external_id, version);
    const payload = canonicalJson(result);
    return this.transaction(
      `${rawId}:${version}`,
      async (c) =>
        (
          await c.query<{ result: NormalizationResult }>(
            'SELECT ingestion.complete_normalization($1::uuid,$2,$3::jsonb) AS result',
            [rawId, version, payload],
          )
        ).rows[0]!.result,
    );
  }
  /** Explicit bounded developer processing; no unattended worker, leases or publisher. */
  async normalizeBatch(
    batchId: string,
    version: NormalizerVersion = 'synthetic-movement-v1',
  ): Promise<BatchSummary> {
    normalizerVersion(version);
    const records = await this.reader.query<{ id: string }>(
      'SELECT id FROM ingestion.raw_record WHERE batch_id=$1::uuid ORDER BY receipt_order',
      [batchId],
    );
    for (const r of records.rows) await this.normalizeRaw(r.id, version);
    return this.summary(batchId, version);
  }
  async summary(
    batchId: string,
    version: NormalizerVersion = 'synthetic-movement-v1',
  ): Promise<BatchSummary> {
    normalizerVersion(version);
    const r = await this.reader.query<{ summary: BatchSummary }>(
      `
      SELECT jsonb_build_object('batchId',b.id,'normalizerVersion',$2::text,'received',count(r.id),
        'normalized',count(r.id) FILTER(WHERE p.state='NORMALIZED'), 'failed',count(r.id) FILTER(WHERE p.state='FAILED'),
        'pending',count(r.id) FILTER(WHERE p.state IS NULL OR p.state='PENDING'),
        'distinctRevisions',count(DISTINCT r.revision_id),'completeness',b.completeness) AS summary
      FROM ingestion.batch b LEFT JOIN ingestion.raw_record r ON r.batch_id=b.id
      LEFT JOIN ingestion.processing p ON p.raw_id=r.id AND p.normalizer_version=$2
      WHERE b.id=$1::uuid GROUP BY b.id`,
      [batchId, version],
    );
    if (!r.rows[0]) throw new IngestionDatabaseError('P2002');
    return r.rows[0].summary;
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
        if (committing && !(code && /^(22|23|40|42|P[12])/.test(code))) {
          discard = true;
          throw new UnknownIngestionCommit(identity, { cause: error });
        }
        if (code) throw new IngestionDatabaseError(code);
        throw error;
      } finally {
        client.removeListener('error', onError);
        client.release(discard);
      }
    }
  }
}
