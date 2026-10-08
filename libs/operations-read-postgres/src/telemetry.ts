import type { Operation, ReadResult } from './index';
export type Classification =
  | 'NONE'
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'TIMEOUT'
  | 'DATABASE_UNAVAILABLE'
  | 'PERMISSION_DENIED'
  | 'UNSUPPORTED_STATE'
  | 'INVARIANT_FAILURE'
  | 'UNEXPECTED';
export interface ReadObservation {
  operation: Operation | 'ready';
  durationMs: number;
  databaseMs: number;
  queryCount: number;
  rows: number;
  outcome: 'SUCCESS' | 'FAILURE';
  classification: Classification;
}
export type Observer = (value: ReadObservation) => void;
export function classify(error: unknown): Classification {
  // pg's pinned driver-side response deadline, distinct from SQLSTATE 57014.
  if (error instanceof Error && error.message === 'Query read timeout')
    return 'TIMEOUT';
  if (error instanceof Error && error.constructor.name === 'InvalidRead')
    return 'INVALID_INPUT';
  const e = error as { classification?: unknown; code?: unknown } | null;
  if (
    typeof e?.classification === 'string' &&
    [
      'NOT_FOUND',
      'TIMEOUT',
      'DATABASE_UNAVAILABLE',
      'PERMISSION_DENIED',
      'UNSUPPORTED_STATE',
      'INVARIANT_FAILURE',
      'UNEXPECTED',
    ].includes(e.classification)
  )
    return e.classification as Classification;
  const code = typeof e?.code === 'string' ? e.code : '';
  if (code === '57014') return 'TIMEOUT';
  if (code === '22023') return 'INVALID_INPUT';
  if (code === 'P0012') return 'NOT_FOUND';
  if (code === '42501') return 'PERMISSION_DENIED';
  if (['P6002', 'P9002'].includes(code)) return 'UNSUPPORTED_STATE';
  if (/^P[2-9]003$|^P[2-9]004$/.test(code)) return 'INVARIANT_FAILURE';
  if (/^08|^57P|^ECONN|^EHOST|^ENET|^ETIMEDOUT/.test(code))
    return 'DATABASE_UNAVAILABLE';
  return 'UNEXPECTED';
}
const operations: readonly string[] = [
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
  'ready',
];
const buckets = [5, 25, 100, 500, 1000, 5000, 30000];
type Aggregate = {
  count: number;
  failures: number;
  slow: number;
  queries: number;
  rows: number;
  databaseMs: number;
  sum: number;
  buckets: number[];
};
/** Process-local, bounded labels; no IDs, SQL, parameters, payloads or trace storage. */
export class Telemetry {
  private readonly aggregates = new Map<string, Aggregate>();
  private readonly requests = new Map<
    string,
    { count: number; failures: number; sum: number }
  >();
  private readonly gauges = new Map<string, string>();
  constructor(readonly slowMs = 500) {
    if (!Number.isInteger(slowMs) || slowMs < 1 || slowMs > 30000)
      throw new Error('Invalid slow threshold');
  }
  record(o: ReadObservation) {
    if (!operations.includes(o.operation)) return;
    if (
      ![o.durationMs, o.databaseMs, o.queryCount, o.rows].every(
        (n) => Number.isFinite(n) && n >= 0,
      )
    )
      return;
    const a = this.aggregates.get(o.operation) ?? {
      count: 0,
      failures: 0,
      slow: 0,
      queries: 0,
      rows: 0,
      databaseMs: 0,
      sum: 0,
      buckets: buckets.map(() => 0),
    };
    a.count++;
    a.failures += o.outcome === 'FAILURE' ? 1 : 0;
    a.slow += o.durationMs >= this.slowMs ? 1 : 0;
    a.queries += o.queryCount;
    a.rows += o.rows;
    a.databaseMs += o.databaseMs;
    a.sum += o.durationMs;
    buckets.forEach((limit, i) => {
      if (o.durationMs <= limit) a.buckets[i] = a.buckets[i]! + 1;
    });
    this.aggregates.set(o.operation, a);
  }
  request(operation: string, durationMs: number, failed: boolean) {
    if (
      ![
        ...operations.map((o) => 'page_' + o),
        'readiness',
        'liveness',
        'metrics',
      ].includes(operation) ||
      !Number.isFinite(durationMs) ||
      durationMs < 0
    )
      return;
    const a = this.requests.get(operation) ?? { count: 0, failures: 0, sum: 0 };
    a.count++;
    a.failures += failed ? 1 : 0;
    a.sum += durationMs;
    this.requests.set(operation, a);
  }
  observedModel(operation: Operation, r: ReadResult) {
    if (!operations.includes(operation)) return;
    // These are last-observed scoped authoritative projections, never system-wide totals.
    if (operation === 'workers' && r.data) {
      const counts = (r.data['counts'] ?? {}) as Record<string, unknown>;
      for (const state of [
        'PENDING',
        'PROCESSING',
        'RETRYABLE',
        'FAILED_TERMINAL',
        'SUCCEEDED',
      ]) {
        const value = counts[state] ?? '0';
        if (typeof value === 'string' && /^\d+$/.test(value))
          this.gauges.set(
            `flow_last_observed_work_total{state="${state}"}`,
            value,
          );
      }
    }
    if (
      (operation === 'overview' || operation === 'integrity') &&
      r.data?.['integrity']
    ) {
      const integrity = r.data['integrity'] as Record<string, unknown>;
      for (const kind of ['integrity', 'financialAssurance']) {
        const status = integrity[kind];
        if (['PASS', 'FAIL', 'UNKNOWN'].includes(String(status))) {
          for (const s of ['PASS', 'FAIL', 'UNKNOWN'])
            this.gauges.set(
              `flow_last_observed_integrity{kind="${kind}",status="${s}"}`,
              status === s ? '1' : '0',
            );
        }
      }
      const controls = integrity['controls'];
      if (Array.isArray(controls)) {
        for (const status of ['PASS', 'FAIL', 'UNKNOWN'])
          this.gauges.set(
            `flow_last_observed_control_total{status="${status}"}`,
            String(
              controls.filter((c: { status?: string }) => c.status === status)
                .length,
            ),
          );
        for (const type of [
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
        ]) {
          for (const status of ['PASS', 'FAIL', 'UNKNOWN'])
            this.gauges.set(
              `flow_last_observed_subsystem_control_total{type="${type}",status="${status}"}`,
              String(
                controls.filter(
                  (c: { type?: string; status?: string }) =>
                    c.type === type && c.status === status,
                ).length,
              ),
            );
        }
      }
      const work = integrity['work'] as Record<string, unknown> | undefined;
      for (const state of [
        'pending',
        'processing',
        'retryable',
        'terminal',
        'succeeded',
        'expiredRecoverable',
      ]) {
        const count = work?.[state];
        if (
          typeof count === 'number' &&
          Number.isSafeInteger(count) &&
          count >= 0
        )
          this.gauges.set(
            `flow_last_observed_sweep_work_total{state="${state}"}`,
            String(count),
          );
      }
      const open = integrity['open'] as Record<string, unknown> | undefined;
      const exceptions = open?.['exceptions'];
      if (
        typeof exceptions === 'number' &&
        Number.isSafeInteger(exceptions) &&
        exceptions >= 0
      )
        this.gauges.set(
          'flow_last_observed_open_exceptions',
          String(exceptions),
        );
    }
    const evaluation = r.data?.['evaluation'] as
      Record<string, unknown> | null | undefined;
    if (typeof evaluation?.['current'] === 'boolean') {
      this.gauges.set(
        'flow_last_observed_evaluation_stale',
        evaluation['current'] ? '0' : '1',
      );
      const timestamp = Date.parse(r.asOf);
      if (Number.isFinite(timestamp))
        this.gauges.set(
          'flow_last_observed_evaluation_timestamp_seconds',
          String(Math.floor(timestamp / 1000)),
        );
    }
    const timestamp = Date.parse(r.asOf);
    if (Number.isFinite(timestamp))
      this.gauges.set(
        `flow_last_observed_model_timestamp_seconds{operation="${operation}"}`,
        String(Math.floor(timestamp / 1000)),
      );
  }
  text(): string {
    const lines = [
      '# TYPE flow_read_duration_seconds histogram',
      '# Process-local telemetry; gauges describe the last observed book snapshot, not global financial truth.',
    ];
    for (const [operation, a] of [...this.aggregates].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      const label = `{operation="${operation}"}`;
      for (const [metric, value] of [
        ['reads_total', a.count],
        ['read_errors_total', a.failures],
        ['slow_reads_total', a.slow],
        ['database_queries_total', a.queries],
        ['returned_rows_total', a.rows],
        ['database_duration_seconds_total', a.databaseMs / 1000],
      ] as const)
        lines.push(`flow_${metric}${label} ${value}`);

      buckets.forEach((limit, i) =>
        lines.push(
          `flow_read_duration_seconds_bucket{operation="${operation}",le="${limit / 1000}"} ${a.buckets[i]}`,
        ),
      );
      lines.push(
        `flow_read_duration_seconds_bucket{operation="${operation}",le="+Inf"} ${a.count}`,
        `flow_read_duration_seconds_sum${label} ${a.sum / 1000}`,
        `flow_read_duration_seconds_count${label} ${a.count}`,
      );
    }
    for (const [operation, a] of [...this.requests].sort()) {
      const label = `{surface="${operation}"}`;
      lines.push(
        `flow_server_requests_total${label} ${a.count}`,
        `flow_server_errors_total${label} ${a.failures}`,
        `flow_server_request_duration_seconds_sum${label} ${a.sum / 1000}`,
        `flow_server_request_duration_seconds_count${label} ${a.count}`,
      );
    }
    for (const [name, value] of [...this.gauges].sort())
      lines.push(`${name} ${value}`);
    return lines.join('\n') + '\n';
  }
}
