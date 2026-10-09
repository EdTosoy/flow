import { Pool } from 'pg';
import {
  stripeReader,
  object,
  stripeMetricSnapshot,
} from '@flow/stripe-integration';
import { StripeEvidenceWorker } from '@flow/stripe-postgres';
import { stripeConfig } from './stripe-config';
async function main(): Promise<void> {
  const config = stripeConfig('worker'),
    api = stripeReader(config.key);
  if (
    object(await api.read('account', config.binding.accountId))['id'] !==
    config.binding.accountId
  )
    throw new Error('Stripe account mismatch');
  const pool = new Pool({
    connectionString: config.url,
    max: 4,
    connectionTimeoutMillis: 1000,
    statement_timeout: 10000,
    idleTimeoutMillis: 10000,
  });
  pool.on('error', () =>
    process.stderr.write('Stripe worker database unavailable\n'),
  );
  let stop = false;
  const shutdown = (): void => {
    stop = true;
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  const metrics = (): void => {
    process.stdout.write(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        subsystem: 'stripe-worker',
        operation: 'metrics',
        metrics: stripeMetricSnapshot(),
      }) + '\n',
    );
  };
  try {
    const worker = new StripeEvidenceWorker(pool, config.binding, api, {
      log: (entry) =>
        process.stdout.write(
          JSON.stringify({
            timestamp: new Date().toISOString(),
            subsystem: 'stripe-worker',
            ...entry,
          }) + '\n',
        ),
    });
    let nextMetricsAt = performance.now() + 30000;
    while (!stop) {
      if (!(await worker.processOne('stripe-worker')))
        await new Promise((resolve) => setTimeout(resolve, 250));
      if (performance.now() >= nextMetricsAt) {
        metrics();
        nextMetricsAt = performance.now() + 30000;
      }
    }
  } finally {
    process.removeListener('SIGTERM', shutdown);
    process.removeListener('SIGINT', shutdown);
    await pool.end();
    metrics();
  }
}
void main().catch(() => {
  process.stderr.write(
    'Stripe worker failed; inspect configuration and bounded worker failure history\n',
  );
  process.exitCode = 1;
});
