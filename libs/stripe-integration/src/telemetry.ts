/** Fixed names only. No event, account, customer or object identity is a metric label. */
export const METRIC_NAMES = [
  'stripe_api_request_total',
  'stripe_api_failure_total',
  'stripe_api_duration_ms_total',
  'stripe_backfill_event_total',
  'stripe_normalization_failure_total',
] as const;
export type StripeMetric = (typeof METRIC_NAMES)[number];
const totals = new Map<StripeMetric, number>(
  METRIC_NAMES.map((name) => [name, 0]),
);
export function stripeMetric(name: StripeMetric, value = 1): void {
  if (!METRIC_NAMES.includes(name) || !Number.isFinite(value) || value < 0)
    return;
  totals.set(name, (totals.get(name) ?? 0) + value);
}
export function stripeMetrics(): string {
  return METRIC_NAMES.map((name) => name + ' ' + totals.get(name) + '\n').join(
    '',
  );
}
export function stripeMetricSnapshot(): Readonly<Record<StripeMetric, number>> {
  return Object.fromEntries(
    METRIC_NAMES.map((name) => [name, totals.get(name) ?? 0]),
  ) as Record<StripeMetric, number>;
}
