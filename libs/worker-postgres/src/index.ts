import type { Pool, PoolClient } from 'pg';
import {
  normalize,
  normalizerVersion,
  canonicalJson,
  type NormalizerVersion,
} from '@flow/ingestion-domain';

export type FailureClass =
  'TRANSIENT' | 'DOMAIN_REJECTION' | 'POISON' | 'UNSUPPORTED' | 'TIMEOUT';
export interface Failure {
  readonly classification: FailureClass;
  readonly code: string;
}
export class WorkFailure extends Error {
  constructor(
    readonly classification: FailureClass,
    readonly code: string,
  ) {
    super(code);
  }
}
export class LostLease extends Error {}
export class UnknownWorkerCommit extends Error {
  constructor(
    readonly operation: string,
    options: ErrorOptions,
  ) {
    super(
      'Worker COMMIT outcome unknown; inspect durable state or replay the same completion token',
      options,
    );
  }
}
export interface Claim {
  readonly id: string;
  readonly eventId: string;
  readonly handler: string;
  readonly handlerVersion: number;
  readonly attempt: number;
  readonly token: string;
  readonly owner: string;
  readonly timeoutMs: number;
  readonly eventType: string;
  readonly schemaVersion: number;
  readonly aggregateVersion: number;
  readonly bookId: string;
  readonly batchId: string | null;
  readonly normalizerVersion: string | null;
  readonly payload: unknown;
}
export interface WorkLog {
  readonly workId: string;
  readonly eventType: string;
  readonly attempt: number;
  readonly leaseToken: string;
  readonly handler: string;
  readonly durationMs: number;
  readonly outcome: 'SUCCEEDED' | 'FAILED' | 'FENCED';
  readonly failureClass?: FailureClass;
  readonly failureCode?: string;
}
export interface WorkerTelemetry {
  /** Payloads and arbitrary exception messages are deliberately excluded. Observers must not affect work. */
  readonly log?: (entry: WorkLog) => void;
  readonly timing?: (
    metric: 'claim_latency' | 'handler_duration',
    milliseconds: number,
  ) => void;
}
function codeOf(error: unknown): string | undefined {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : undefined;
}
export function classifyFailure(error: unknown): Failure {
  if (error instanceof WorkFailure)
    return { classification: error.classification, code: error.code };
  const code = codeOf(error);
  if (code && /^(22|23|P[1-9])/.test(code))
    return { classification: 'DOMAIN_REJECTION', code };
  // Unknown infrastructure/implementation errors have a bounded retry budget, never an unbounded loop.
  return {
    classification: 'TRANSIENT',
    code: code && /^[A-Z0-9_]{1,128}$/.test(code) ? code : 'UNKNOWN_FAILURE',
  };
}
/** The only installed effect handler. Completed notifications have explicit DB NO_LOCAL_HANDLER registrations. */
export const HANDLER_REGISTRY = Object.freeze({
  'normalize-batch': Object.freeze({
    version: 1,
    eventType: 'ingestion.normalization_requested',
    schemaVersion: 1,
    aggregateVersion: 1,
  }),
});
export function normalizationPayload(claim: Claim): {
  batchId: string;
  version: NormalizerVersion;
} {
  const contract = HANDLER_REGISTRY['normalize-batch'];
  if (
    claim.handler !== 'normalize-batch' ||
    claim.handlerVersion !== contract.version ||
    claim.eventType !== contract.eventType ||
    claim.schemaVersion !== contract.schemaVersion ||
    claim.aggregateVersion !== contract.aggregateVersion
  )
    throw new WorkFailure('UNSUPPORTED', 'UNSUPPORTED_CONTRACT');
  const p = claim.payload;
  if (typeof p !== 'object' || p === null || Array.isArray(p))
    throw new WorkFailure('POISON', 'INVALID_PAYLOAD');
  const data = p as Record<string, unknown>;
  if (
    Object.keys(data).sort().join(',') !== 'batchId,bookId,normalizerVersion' ||
    typeof data['batchId'] !== 'string' ||
    data['batchId'] !== claim.batchId ||
    data['bookId'] !== claim.bookId ||
    data['normalizerVersion'] !== claim.normalizerVersion
  )
    throw new WorkFailure('POISON', 'INVALID_PAYLOAD');
  try {
    return {
      batchId: data['batchId'],
      version: normalizerVersion(data['normalizerVersion'] as string),
    };
  } catch {
    throw new WorkFailure('UNSUPPORTED', 'UNSUPPORTED_NORMALIZER');
  }
}
/** Caller owns a provisioned flow_worker pool. No unrestricted domain writer credential is needed. */
export class PostgresWorker {
  constructor(
    private readonly pool: Pool,
    private readonly telemetry: WorkerTelemetry = {},
  ) {}
  async claim(
    owner: string,
    bookId: string | null = null,
  ): Promise<Claim | null> {
    const begin = performance.now();
    try {
      return await this.transaction(
        'claim',
        async (c) =>
          (
            await c.query<{ result: Claim | null }>(
              'SELECT worker.claim($1,$2::uuid) AS result',
              [owner, bookId],
            )
          ).rows[0]!.result,
      );
    } finally {
      this.observe(() =>
        this.telemetry.timing?.('claim_latency', performance.now() - begin),
      );
    }
  }
  async finish(claim: Claim, failure?: Failure): Promise<boolean> {
    return this.transaction(
      `finish:${claim.id}:${claim.token}`,
      async (c) =>
        (
          await c.query<{ accepted: boolean }>(
            'SELECT worker.finish($1::uuid,$2::uuid,$3,$4) AS accepted',
            [
              claim.id,
              claim.token,
              failure?.classification ?? null,
              failure?.code ?? null,
            ],
          )
        ).rows[0]!.accepted,
    );
  }
  /** Separate semantic domain commits allow safe replay of a partially completed batch. Each is fenced. */
  async handle(claim: Claim, signal?: AbortSignal): Promise<void> {
    const { batchId, version } = normalizationPayload(claim);
    const rows = await this.pool.query<{
      id: string;
      payload_bytes: Buffer;
      external_id: string | null;
    }>(
      "SELECT r.id,r.payload_bytes,r.external_id FROM ingestion.raw_record r JOIN ingestion.processing p ON p.raw_id=r.id AND p.normalizer_version=$2 WHERE r.batch_id=$1::uuid AND p.state='PENDING' ORDER BY r.receipt_order",
      [batchId, version],
    );
    for (const row of rows.rows) {
      if (signal?.aborted) throw new WorkFailure('TIMEOUT', 'HANDLER_TIMEOUT');
      const result = canonicalJson(
        normalize(row.payload_bytes, row.external_id, version),
      );
      const accepted = await this.transaction(
        `normalize:${claim.id}:${claim.token}:${row.id}`,
        async (c) =>
          (
            await c.query<{ accepted: boolean }>(
              'SELECT worker.complete_normalization($1::uuid,$2::uuid,$3::uuid,$4::jsonb) AS accepted',
              [claim.id, claim.token, row.id, result],
            )
          ).rows[0]!.accepted,
      );
      if (!accepted) throw new LostLease();
    }
  }
  async processOne(
    owner: string,
    bookId: string | null = null,
  ): Promise<boolean> {
    const claim = await this.claim(owner, bookId);
    if (!claim) return false;
    const start = performance.now();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failure: Failure | undefined;
    let fenced = false;
    try {
      // Timeout stops further steps and fences future writes by closing this attempt. It does not assert rollback of a COMMIT in flight.
      await Promise.race([
        this.handle(claim, controller.signal),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new WorkFailure('TIMEOUT', 'HANDLER_TIMEOUT'));
          }, claim.timeoutMs);
        }),
      ]);
    } catch (error) {
      fenced = error instanceof LostLease;
      failure = classifyFailure(error);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    const durationMs = performance.now() - start;
    // Completion acknowledgement loss is safely replayable with this original token.
    let accepted: boolean;
    try {
      accepted = await this.finish(claim, failure);
    } catch (error) {
      if (!(error instanceof UnknownWorkerCommit)) throw error;
      accepted = await this.finish(claim, failure);
    }
    this.observe(() => this.telemetry.timing?.('handler_duration', durationMs));
    this.observe(() =>
      this.telemetry.log?.({
        workId: claim.id,
        eventType: claim.eventType,
        attempt: claim.attempt,
        leaseToken: claim.token,
        handler: claim.handler,
        durationMs,
        outcome:
          !accepted || fenced ? 'FENCED' : failure ? 'FAILED' : 'SUCCEEDED',
        ...(failure
          ? { failureClass: failure.classification, failureCode: failure.code }
          : {}),
      }),
    );
    return true;
  }
  async processBatch(
    owner: string,
    limit: number,
    bookId: string | null = null,
    signal?: AbortSignal,
  ): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000)
      throw new RangeError('Batch limit must be 1..10000');
    let count = 0;
    while (
      count < limit &&
      !signal?.aborted &&
      (await this.processOne(owner, bookId))
    )
      count++;
    return count;
  }
  async status(
    state:
      | 'PENDING'
      | 'PROCESSING'
      | 'RETRYABLE'
      | 'SUCCEEDED'
      | 'FAILED_TERMINAL'
      | null = null,
  ): Promise<unknown[]> {
    return (
      await this.pool.query(
        'SELECT id,event_id,event_type,schema_version,handler,handler_version,state,attempt_count,max_attempts,next_attempt_at,lease_owner,lease_expires_at,last_failure_class,last_failure_code,created_at,completed_at FROM worker.status WHERE ($1::text IS NULL OR state=$1) ORDER BY created_at,id LIMIT 1000',
        [state],
      )
    ).rows;
  }
  async metrics(): Promise<Record<string, unknown>> {
    return (await this.pool.query('SELECT * FROM worker.metrics')).rows[0]!;
  }
  private observe(observer: () => void): void {
    try {
      observer();
    } catch {
      /* Operational exporters cannot change financial execution. */
    }
  }
  private async transaction<T>(
    operation: string,
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const c = await this.pool.connect();
      let committing = false,
        discard = false;
      const onError = (): void => {
        discard = true;
      };
      c.on('error', onError);
      try {
        await c.query('BEGIN ISOLATION LEVEL READ COMMITTED');
        await c.query(
          "SET LOCAL synchronous_commit=on; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'; SET LOCAL idle_in_transaction_session_timeout='30s'",
        );
        const result = await fn(c);
        committing = true;
        await c.query('COMMIT');
        return result;
      } catch (error) {
        const code = codeOf(error);
        try {
          await c.query('ROLLBACK');
        } catch {
          discard = true;
        }
        if ((code === '40001' || code === '40P01') && attempt < 4) {
          await new Promise((r) => setTimeout(r, 10 * 2 ** attempt));
          continue;
        }
        if (committing && !(code && /^(22|23|40|42|P[1-9])/.test(code))) {
          discard = true;
          throw new UnknownWorkerCommit(operation, { cause: error });
        }
        throw error;
      } finally {
        c.removeListener('error', onError);
        c.release(discard);
      }
    }
  }
}
