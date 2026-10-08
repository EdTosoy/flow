import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { classify, type ReadObservation, type Observer } from './telemetry';
export {
  classify,
  Telemetry,
  type ReadObservation,
  type Observer,
} from './telemetry';
import { health, type IntegritySummary } from '@flow/integrity-postgres';
export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json };
export type RecordJson = { [key: string]: Json };
export type Operation =
  | 'books'
  | 'overview'
  | 'integrity'
  | 'evaluations'
  | 'controls'
  | 'control'
  | 'reconciliation'
  | 'run'
  | 'exceptions'
  | 'case'
  | 'workers'
  | 'work';
export interface ReadResult {
  version: 'operations-read-v1';
  asOf: string;
  data: RecordJson | null;
  items: RecordJson[] | null;
  nextCursor: string | null;
  checks?: Record<string, 'PASS' | 'FAIL' | 'UNKNOWN'>;
}
export class InvalidRead extends Error {
  constructor() {
    super('Invalid operations request');
  }
}
export class ReadUnavailable extends Error {
  constructor(
    readonly category: 'NOT_FOUND' | 'UNAVAILABLE',
    readonly classification = category === 'NOT_FOUND'
      ? 'NOT_FOUND'
      : 'DATABASE_UNAVAILABLE',
  ) {
    super(
      category === 'NOT_FOUND'
        ? 'Requested scope was not found'
        : 'Operations data unavailable',
    );
  }
}
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function identifier(value: string): string {
  if (!uuidPattern.test(value)) throw new InvalidRead();
  return value.toLowerCase();
}
const statuses: Partial<Record<Operation, readonly string[]>> = {
  controls: ['PASS', 'FAIL', 'UNKNOWN'],
  reconciliation: ['DRAFT', 'SEALED', 'RUNNING', 'COMPLETED'],
  run: ['MATCHED', 'UNMATCHED', 'AMBIGUOUS', 'INELIGIBLE'],
  exceptions: ['OPEN', 'UNDER_REVIEW', 'AWAITING_EVIDENCE', 'RESOLVED'],
  workers: [
    'PENDING',
    'PROCESSING',
    'SUCCEEDED',
    'RETRYABLE',
    'FAILED_TERMINAL',
  ],
};
export const controlTypes = [
  'SOURCE',
  'SOURCE_PERIOD',
  'PROCESSING_PARTITION',
  'PROCESSING_COMPLETION',
  'PROCESSOR_COVERAGE',
  'BANK_COVERAGE',
  'PROCESSOR',
  'PROCESSOR_TOTAL',
  'BANK',
  'BANK_TOTAL',
  'BANK_COMPLETENESS',
  'RECONCILIATION',
  'ALLOCATION',
  'LEDGER',
  'EXPOSURE',
  'FRESHNESS',
] as const;
export const classifications = [
  'MISSING_BANK_MOVEMENT',
  'EXTRA_BANK_MOVEMENT',
  'AMOUNT_MISMATCH',
  'AMBIGUOUS_MATCH',
  'PROCESSOR_INCONSISTENCY',
  'BANK_INCONSISTENCY',
  'SOURCE_INCOMPLETENESS',
  'SOURCE_REVISION_AMBIGUITY',
  'DUPLICATE_EVIDENCE',
  'TIMING_LATE_ARRIVAL',
  'UNSUPPORTED_CASE',
  'CURRENT_PROOF_INVALIDATED',
] as const;
export function parameters(
  kind: Operation,
  input: Record<string, string | undefined>,
): Record<string, unknown> {
  const options: Record<string, unknown> = { limit: 50 };
  for (const key of Object.keys(input)) {
    const value = input[key];
    if (!value) continue;
    if (['evaluation', 'id'].includes(key)) options[key] = identifier(value);
    else if (key === 'limit') {
      if (!/^([1-9][0-9]?|100)$/.test(value)) throw new InvalidRead();
      options[key] = Number(value);
    } else if (key === 'currency') {
      if (!['PHP', 'USD'].includes(value)) throw new InvalidRead();
      options[key] = value;
    } else if (key === 'status') {
      if (!statuses[kind]?.includes(value)) throw new InvalidRead();
      options[key] = value;
    } else if (key === 'category') {
      const allow: readonly string[] =
        kind === 'exceptions'
          ? classifications
          : kind === 'controls'
            ? controlTypes
            : [];
      if (!allow.includes(value)) throw new InvalidRead();
      options[key] = value;
    } else if (key === 'key') {
      if (kind !== 'control' || value.length > 1024) throw new InvalidRead();
      options[key] = value;
    } else if (key === 'cursor') {
      try {
        if (value.length > 2048 || !/^[\w-]+$/.test(value))
          throw new InvalidRead();
        const c: unknown = JSON.parse(
          Buffer.from(value, 'base64url').toString(),
        );
        if (c === null || typeof c !== 'object' || Array.isArray(c))
          throw new InvalidRead();
        const v = c as Record<string, unknown>;
        if (kind === 'controls') {
          if (
            Object.keys(v).join() !== 'key' ||
            typeof v['key'] !== 'string' ||
            v['key'].length > 1024
          )
            throw new InvalidRead();
        } else if (kind === 'case') {
          if (
            Object.keys(v).join() !== 'sequence' ||
            !Number.isSafeInteger(v['sequence']) ||
            (v['sequence'] as number) < 0
          )
            throw new InvalidRead();
        } else if (kind === 'run') {
          if (Object.keys(v).join() !== 'id' || typeof v['id'] !== 'string')
            throw new InvalidRead();
          identifier(v['id']);
        } else {
          if (
            Object.keys(v).sort().join() !== 'id,time' ||
            typeof v['id'] !== 'string' ||
            typeof v['time'] !== 'string' ||
            v['time'].length > 64 ||
            !Number.isFinite(Date.parse(v['time']))
          )
            throw new InvalidRead();
          identifier(v['id']);
        }
        options[key] = v;
      } catch {
        throw new InvalidRead();
      }
    } else throw new InvalidRead();
  }
  return options;
}
const capabilitySql = `SELECT NOT r.rolsuper AND NOT r.rolcreatedb AND NOT r.rolcreaterole AND NOT r.rolbypassrls AND pg_has_role(current_user,'flow_operations_reader','MEMBER') AND NOT pg_has_role(current_user,'flow_ledger_owner','MEMBER') AND NOT EXISTS(SELECT FROM pg_roles w WHERE w.rolname IN ('flow_ledger_writer','flow_ingestion_writer','flow_processor_writer','flow_bank_writer','flow_reconciliation_writer','flow_exception_writer','flow_control_writer','flow_worker') AND pg_has_role(current_user,w.oid,'MEMBER')) AS ok FROM pg_roles r WHERE r.rolname=current_user`;
/** No arbitrary SQL port; each read observes a single, bounded authoritative snapshot. */
export class PostgresOperations {
  /** Technical connectivity/capability only; no financial sweep or assurance check. */
  async ready(): Promise<void> {
    const start = performance.now();
    const o: ReadObservation = {
      operation: 'ready',
      durationMs: 0,
      databaseMs: 0,
      queryCount: 0,
      rows: 0,
      outcome: 'SUCCESS',
      classification: 'NONE',
    };
    let client: PoolClient | undefined;
    let discard = false;
    const onError = () => {
      discard = true;
    };
    try {
      client = await this.reader.connect();
      client.on('error', onError);
      const query = async (sql: string) => {
        o.queryCount++;
        const began = performance.now();
        try {
          // The pinned pg driver accepts this option; @types/pg omits it on QueryConfig.
          const config = { text: sql, query_timeout: 1200 };
          return await client!.query(config);
        } finally {
          o.databaseMs += performance.now() - began;
        }
      };
      await query('BEGIN READ ONLY');
      await query(
        "SET LOCAL statement_timeout='1000ms'; SET LOCAL idle_in_transaction_session_timeout='1000ms'",
      );
      if (!(await query(capabilitySql)).rows[0]?.ok)
        throw new ReadUnavailable('UNAVAILABLE', 'PERMISSION_DENIED');
      if (
        !(
          await query(
            "SELECT has_function_privilege(current_user,'operations.read_v1(uuid,text,jsonb)','EXECUTE') AS ok",
          )
        ).rows[0]?.ok
      )
        throw new ReadUnavailable('UNAVAILABLE', 'PERMISSION_DENIED');
      await query('COMMIT');
    } catch (error) {
      o.outcome = 'FAILURE';
      o.classification = classify(error);
      discard = true;
      throw new ReadUnavailable('UNAVAILABLE', o.classification);
    } finally {
      // Destroy failed probe clients: rollback is unnecessary and no read locks remain stranded.
      client?.removeListener('error', onError);
      client?.release(discard);
      o.durationMs = performance.now() - start;
      try {
        this.observe?.(o);
      } catch {
        /* no correctness dependency on telemetry */
      }
    }
  }
  constructor(
    private readonly reader: Pool,
    private readonly observe?: Observer,
    private readonly timeoutMs = 30000,
  ) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000)
      throw new InvalidRead();
  }
  async read(
    kind: Operation,
    bookId: string | null,
    input: Record<string, string | undefined> = {},
  ): Promise<ReadResult> {
    const observation: ReadObservation = {
      operation: kind,
      durationMs: 0,
      databaseMs: 0,
      queryCount: 0,
      rows: 0,
      outcome: 'SUCCESS',
      classification: 'NONE',
    };
    const start = performance.now();
    try {
      const result = await this.perform(kind, bookId, input, observation);
      observation.rows = result.items?.length ?? (result.data ? 1 : 0);
      return result;
    } catch (error) {
      observation.outcome = 'FAILURE';
      observation.classification = classify(error);
      throw error;
    } finally {
      observation.durationMs = performance.now() - start;
      // Observability must never change query semantics or cleanup.
      try {
        this.observe?.(observation);
      } catch {
        /* diagnostics are best effort */
      }
    }
  }
  private async perform(
    kind: Operation,
    bookId: string | null,
    input: Record<string, string | undefined>,
    observation: ReadObservation,
  ): Promise<ReadResult> {
    if (
      ![
        'books',
        'overview',
        'integrity',
        'evaluations',
        'controls',
        'control',
        'reconciliation',
        'run',
        'exceptions',
        'case',
        'workers',
        'work',
      ].includes(kind)
    )
      throw new InvalidRead();
    const book = kind === 'books' ? null : identifier(bookId ?? '');
    const opts = parameters(kind, input);
    const client = await this.reader.connect().catch(() => {
      throw new ReadUnavailable('UNAVAILABLE');
    });
    const query = async <T extends QueryResultRow = QueryResultRow>(
      text: string,
      values?: unknown[],
    ): Promise<QueryResult<T>> => {
      const start = performance.now();
      observation.queryCount++;
      try {
        const config = {
          text,
          values,
          query_timeout: this.timeoutMs + 1000,
        };
        return await client.query<T>(config);
      } finally {
        observation.databaseMs += performance.now() - start;
      }
    };
    let discard = false;
    const onError = () => {
      discard = true;
    };
    client.on('error', onError);
    try {
      await query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await query(
        `SET LOCAL statement_timeout='${this.timeoutMs}ms'; SET LOCAL idle_in_transaction_session_timeout='30s'`,
      );
      // Enforce a narrow login even when misconfigured with owner credentials.
      const caps = (await query<{ ok: boolean }>(capabilitySql)).rows[0];
      if (!caps?.ok)
        throw new ReadUnavailable('UNAVAILABLE', 'PERMISSION_DENIED');
      const result = (
        await query<{ result: ReadResult }>(
          'SELECT operations.read_v1($1::uuid,$2,$3::jsonb) AS result',
          [book, kind, JSON.stringify(opts)],
        )
      ).rows[0]!.result;
      if (result.version !== 'operations-read-v1')
        throw new ReadUnavailable('UNAVAILABLE');
      await query('COMMIT');
      result.nextCursor = null;
      if (result.items && result.items.length > (opts['limit'] as number)) {
        result.items.pop();
        const last = result.items.at(-1)!;
        const cursor =
          kind === 'controls'
            ? { key: last['cursorKey'] }
            : kind === 'case'
              ? { sequence: last['version'] }
              : kind === 'run'
                ? { id: last['id'] }
                : { time: last['cursorTime'], id: last['id'] };
        result.nextCursor = Buffer.from(JSON.stringify(cursor)).toString(
          'base64url',
        );
      }
      if (kind === 'overview' || kind === 'integrity')
        result.checks = health(
          result.data!['integrity'] as unknown as IntegritySummary,
        );
      return result;
    } catch (error) {
      if (
        discard ||
        (error instanceof Error && error.message === 'Query read timeout')
      ) {
        discard = true;
      } else {
        try {
          await query('ROLLBACK');
        } catch {
          discard = true;
        }
      }
      if (error instanceof ReadUnavailable) throw error;
      const code =
        typeof error === 'object' && error !== null && 'code' in error
          ? error.code
          : undefined;
      throw new ReadUnavailable(
        code === 'P0012' ? 'NOT_FOUND' : 'UNAVAILABLE',
        classify(error),
      );
    } finally {
      client.removeListener('error', onError);
      client.release(discard);
    }
  }
}
