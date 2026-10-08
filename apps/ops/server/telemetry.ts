import 'server-only';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { headers } from 'next/headers';
import {
  Telemetry,
  type ReadObservation,
  classify,
} from '@flow/operations-read-postgres';
const context = new AsyncLocalStorage<{ id: string; failed: boolean }>();
const state = globalThis as typeof globalThis & {
  flowOpsTelemetry?: Telemetry;
};
const threshold = Number(process.env['OPS_SLOW_READ_MS'] ?? '500');
export const telemetry = (state.flowOpsTelemetry ??= new Telemetry(threshold));
export function log(
  operation: string,
  outcome: string,
  extra: Record<string, string | number> = {},
) {
  console.info(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: outcome === 'FAILURE' ? 'error' : 'info',
      subsystem: 'operations',
      operation,
      correlationId: context.getStore()?.id,
      outcome,
      ...extra,
    }),
  );
}
export function unavailable(error: unknown) {
  const current = context.getStore();
  if (current) current.failed = true;
  log('request_unavailable', 'FAILURE', { classification: classify(error) });
}
export function observe(o: ReadObservation) {
  telemetry.record(o);
  log(o.operation, o.outcome, {
    durationMs: Math.round(o.durationMs),
    databaseMs: Math.round(o.databaseMs),
    queryCount: o.queryCount,
    rows: o.rows,
    classification: o.classification,
    slow: o.durationMs >= threshold ? 1 : 0,
  });
}
export async function request<T>(
  operation: string,
  execute: () => Promise<T>,
): Promise<T> {
  const id = (await headers()).get('x-flow-request-id') ?? randomUUID();
  return context.run({ id, failed: false }, async () => {
    const start = performance.now();
    try {
      const result = await execute();
      const failed = context.getStore()!.failed;
      telemetry.request(operation, performance.now() - start, failed);
      log(operation, failed ? 'FAILURE' : 'SUCCESS', {
        durationMs: Math.round(performance.now() - start),
      });
      return result;
    } catch (error) {
      telemetry.request(operation, performance.now() - start, true);
      log(operation, 'FAILURE', {
        durationMs: Math.round(performance.now() - start),
        classification: 'UNEXPECTED',
      });
      throw error;
    }
  });
}
