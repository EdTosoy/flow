import type { Pool, QueryResultRow, QueryResult } from 'pg';
import {
  batchPayload,
  canonicalJson,
  type BatchCommand,
} from '@flow/ingestion-domain';
import {
  PostgresWorker,
  UnknownWorkerCommit,
  WorkFailure,
  LostLease,
  type Claim,
  type Failure,
  type WorkerTelemetry,
} from '@flow/worker-postgres';
import {
  STRIPE_API_VERSION,
  stripeMetric,
  StripeBoundaryError,
  eventObservation,
  eventEnvelope,
  financialPacket,
  paginate,
  object,
  identity,
  type EventEnvelope,
  type StripeReader,
  type JsonObject,
} from '@flow/stripe-integration';
export interface SourceBinding {
  sourceAccountId: string;
  accountId: string;
}
export interface Acceptance {
  id: string;
  replayed: boolean;
}
function databaseCode(error: unknown): string | undefined {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : undefined;
}
/** Every evidence write has an explicit synchronous commit. Replay keeps the original command/token. */
async function write<R extends QueryResultRow>(
  pool: Pool,
  operation: string,
  sql: string,
  values: unknown[],
): Promise<QueryResult<R>> {
  for (let attempt = 0; ; attempt++) {
    const client = await pool.connect();
    let committing = false,
      discard = false;
    const onError = (): void => {
      discard = true;
    };
    client.on('error', onError);
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await client.query(
        "SET LOCAL synchronous_commit=on; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='10s'; SET LOCAL idle_in_transaction_session_timeout='10s'",
      );
      const result = await client.query<R>(sql, values);
      committing = true;
      await client.query('COMMIT');
      return result;
    } catch (error) {
      const code = databaseCode(error);
      try {
        await client.query('ROLLBACK');
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
      client.removeListener('error', onError);
      client.release(discard);
    }
  }
}
export class StripeEvidenceDatabase {
  constructor(
    readonly pool: Pool,
    readonly binding: SourceBinding,
  ) {}
  async ready(): Promise<boolean> {
    return (
      await this.pool.query<{ ok: boolean }>(
        'SELECT stripe.ready($1::uuid,$2) AS ok',
        [this.binding.sourceAccountId, this.binding.accountId],
      )
    ).rows[0]!.ok;
  }
  async accept(
    event: EventEnvelope,
    raw: Buffer,
    origin: 'webhook' | 'api',
  ): Promise<Acceptance> {
    const command: BatchCommand = {
      sourceAccountId: this.binding.sourceAccountId,
      batchKey: 'stripe-event:' + event.id,
      actorId: 'stripe-ingress',
      provenance: {
        provider: 'stripe',
        environment: 'test',
        accountId: this.binding.accountId,
        eventId: event.id,
        eventType: event.type,
        eventApiVersion: event.apiVersion,
        objectId: event.objectId,
        origin,
      },
      preferredNormalizerVersion: 'external-event-v1',
      records: [
        {
          locator: 'event',
          objectKind: 'stripe-event',
          externalId: event.id,
          sourceRevision: event.apiVersion,
          bytes: raw,
          sequence: null,
          sourceObservedAt: new Date(event.created * 1000).toISOString(),
        },
      ],
    };
    return (
      await write<{ result: Acceptance }>(
        this.pool,
        'stripe.accept_event',
        'SELECT stripe.accept_event($1::jsonb,$2) AS result',
        [batchPayload(command), origin],
      )
    ).rows[0]!.result;
  }
}
/** Same claim/finish/retry engine as Phase 10; only this adapter knows about Stripe. */
export class StripeEvidenceWorker extends PostgresWorker {
  private retryHints = new WeakMap<Claim, number>();
  constructor(
    private readonly stripePool: Pool,
    private readonly binding: SourceBinding,
    private readonly api: StripeReader,
    telemetry: WorkerTelemetry = {},
  ) {
    super(stripePool, telemetry);
  }
  /** Inspect committed economic receipts using the worker's existing read capability. */
  async completedEvidenceCount(from: number, to: number): Promise<bigint> {
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from > to)
      throw new RangeError('Invalid evidence window');
    const result = await this.stripePool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM stripe.completion c JOIN stripe.event e ON e.event_id=c.receipt->>'eventId' JOIN worker.work_item w ON w.id=c.work_id WHERE e.source_account_id=$1 AND w.state='SUCCEEDED' AND (e.document->>'created')::bigint BETWEEN $2 AND $3 AND EXISTS(SELECT FROM jsonb_array_elements(c.receipt->'derivations')) AND EXISTS(SELECT FROM worker.attempt_event a JOIN stripe.principal_binding b ON b.principal=a.database_principal WHERE a.work_id=w.id AND a.kind='SUCCEEDED' AND b.capability='worker' AND b.source_account_id=e.source_account_id)",
      [this.binding.sourceAccountId, from, to],
    );
    return BigInt(result.rows[0]!.count);
  }
  override async handle(claim: Claim, signal?: AbortSignal): Promise<void> {
    if (claim.handler !== 'stripe-evidence') return super.handle(claim, signal);
    if (
      claim.handlerVersion !== 1 ||
      claim.eventType !== 'ingestion.normalization_requested' ||
      claim.schemaVersion !== 1 ||
      claim.aggregateVersion !== 1 ||
      claim.normalizerVersion !== 'external-event-v1' ||
      object(claim.payload)['batchId'] !== claim.batchId ||
      object(claim.payload)['bookId'] !== claim.bookId ||
      object(claim.payload)['normalizerVersion'] !== claim.normalizerVersion
    )
      throw new WorkFailure('UNSUPPORTED', 'UNSUPPORTED_STRIPE_CONTRACT');
    const completed = await this.stripePool.query(
      'SELECT 1 FROM stripe.completion WHERE work_id=$1',
      [claim.id],
    );
    if (completed.rowCount) return;
    const rows = await this.stripePool.query<{
      document: unknown;
      source_account_id: string;
    }>(
      'SELECT document,source_account_id FROM stripe.event WHERE batch_id=$1',
      [claim.batchId],
    );
    const row = rows.rows[0];
    if (!row || row.source_account_id !== this.binding.sourceAccountId)
      throw new WorkFailure('POISON', 'STRIPE_SOURCE_MISMATCH');
    const check = (): void => {
      if (signal?.aborted) throw new LostLease();
    };
    const snapshot = async (
      key: string,
      fn: () => Promise<unknown>,
    ): Promise<JsonObject> => {
      check();
      const pinned = await this.stripePool.query<{ document: unknown }>(
        'SELECT document FROM stripe.snapshot WHERE work_id=$1 AND attempt=$2 AND key=$3',
        [claim.id, claim.attempt, key],
      );
      if (pinned.rows[0]) return object(pinned.rows[0].document);
      const data = object(await fn());
      check();
      // Keep decoded API responses, not wire bytes. The webhook bytes remain exact and immutable.
      const encoded = JSON.stringify(data);
      if (Buffer.byteLength(encoded) > 1048576)
        throw new WorkFailure('UNSUPPORTED', 'API_EVIDENCE_SIZE_LIMIT');
      return object(
        (
          await write<{ result: unknown }>(
            this.stripePool,
            'stripe.save_snapshot',
            'SELECT stripe.save_snapshot($1::uuid,$2::uuid,$3,$4::jsonb) AS result',
            [claim.id, claim.token, key, encoded],
          )
        ).rows[0]!.result,
      );
    };
    try {
      const account = await snapshot('account', () =>
        this.api.read('account', this.binding.accountId),
      );
      if (
        identity(account['id']) !== this.binding.accountId ||
        account['object'] !== 'account'
      )
        throw new WorkFailure('DOMAIN_REJECTION', 'STRIPE_ACCOUNT_MISMATCH');
      const event = eventEnvelope(row.document, this.binding.accountId);
      const fetch = async (
        kind: Parameters<StripeReader['read']>[0],
        id: string,
      ): Promise<JsonObject> => {
        const value = await snapshot(kind + ':' + id, () =>
          this.api.read(kind, id),
        );
        if (value['id'] !== id)
          throw new WorkFailure('UNSUPPORTED', 'STRIPE_RESOURCE_ID_MISMATCH');
        return value;
      };
      const list = async (payout: string): Promise<JsonObject[]> =>
        paginate(
          {
            read: this.api.read,
            list: (_kind, p) =>
              snapshot(
                'payout-page:' + payout + ':' + (p.startingAfter ?? 'first'),
                () => this.api.list('payout_transactions', p),
              ),
          },
          'payout_transactions',
          { payout },
        );
      const packet = await financialPacket(event, fetch, list);
      check();
      const evidence = await this.stripePool.query<{
        key: string;
        document: unknown;
      }>(
        'SELECT key,document FROM stripe.snapshot WHERE work_id=$1 AND attempt=$2 ORDER BY key',
        [claim.id, claim.attempt],
      );
      const artifact = Buffer.from(
        JSON.stringify({
          apiVersion: STRIPE_API_VERSION,
          acquisition: 'decoded-sdk-response',
          snapshots: evidence.rows,
        }),
      );
      const commands: string[] = [];
      for (const [version, observations] of [
        ['processor-movement-v1', packet.movements],
        ['processor-settlement-v1', packet.settlements],
      ] as const) {
        if (!observations.length) continue;
        commands.push(
          batchPayload({
            sourceAccountId: this.binding.sourceAccountId,
            batchKey: 'stripe-processed:' + event.id + ':' + version,
            actorId: 'stripe-worker',
            preferredNormalizerVersion: version,
            provenance: {
              provider: 'stripe',
              environment: 'test',
              accountId: this.binding.accountId,
              eventId: event.id,
              eventType: event.type,
              eventApiVersion: event.apiVersion,
              sourceObjectId: event.objectId,
              apiVersion: STRIPE_API_VERSION,
              workId: claim.id,
              attempt: claim.attempt,
              representation: 'canonical-adapter-projection',
            },
            artifactBytes: artifact,
            records: observations.map((o, i) => ({
              locator: String(i),
              objectKind:
                o.type === 'movement'
                  ? 'processor-movement'
                  : 'processor-settlement',
              externalId: o.externalId,
              sourceRevision: null,
              bytes: Buffer.from(canonicalJson(o)),
              sourceObservedAt: o.occurredAt,
              sequence: null,
            })),
          }),
        );
      }
      await write(
        this.stripePool,
        'stripe.apply',
        'SELECT stripe.apply($1::uuid,$2::uuid,$3::jsonb,$4::jsonb)',
        [
          claim.id,
          claim.token,
          JSON.stringify({
            state: 'NORMALIZED',
            observation: eventObservation(event),
          }),
          '[' + commands.join(',') + ']',
        ],
      );
    } catch (error) {
      if (error instanceof StripeBoundaryError) {
        stripeMetric('stripe_normalization_failure_total');
        this.retryHints.set(claim, error.retryAfterSeconds);
        throw new WorkFailure(error.classification, error.code);
      }
      throw error;
    }
  }
  override async finish(claim: Claim, failure?: Failure): Promise<boolean> {
    if (claim.handler !== 'stripe-evidence')
      return super.finish(claim, failure);
    const hint = this.retryHints.get(claim) ?? 0;
    this.retryHints.delete(claim);
    return (
      await write<{ ok: boolean }>(
        this.stripePool,
        'stripe.finish',
        'SELECT stripe.finish($1::uuid,$2::uuid,$3,$4,$5) AS ok',
        [
          claim.id,
          claim.token,
          failure?.classification ?? null,
          failure?.code ?? null,
          hint,
        ],
      )
    ).rows[0]!.ok;
  }
}
/** An explicit bounded window is restartable through overlap and durable event identity, not a clock cursor. */
export async function backfill(
  database: StripeEvidenceDatabase,
  reader: StripeReader,
  from: number,
  to: number,
  maxPages = 10,
  now = Math.floor(Date.now() / 1000),
): Promise<{ received: number; duplicates: number }> {
  if (
    !Number.isSafeInteger(from) ||
    !Number.isSafeInteger(to) ||
    from > to ||
    from < now - 29 * 86400 ||
    to > now
  )
    throw new StripeBoundaryError(
      'DOMAIN_REJECTION',
      'INVALID_RECENT_BACKFILL_WINDOW',
    );
  const account = object(
    await reader.read('account', database.binding.accountId),
  );
  if (account['id'] !== database.binding.accountId)
    throw new StripeBoundaryError(
      'DOMAIN_REJECTION',
      'STRIPE_ACCOUNT_MISMATCH',
    );
  // Validate all pages before accepting; a partial/failed scan never claims completeness.
  const events = await paginate(reader, 'events', { from, to }, maxPages);
  let duplicates = 0;
  for (const row of events) {
    const event = eventEnvelope(row, database.binding.accountId);
    if (event.created < from || event.created > to)
      throw new StripeBoundaryError('UNSUPPORTED', 'EVENT_OUTSIDE_WINDOW');
    const result = await database.accept(
      event,
      Buffer.from(JSON.stringify(row)),
      'api',
    );
    if (result.replayed) duplicates++;
  }
  stripeMetric('stripe_backfill_event_total', events.length);
  return { received: events.length, duplicates };
}
