import { Pool } from 'pg';
import { stripeReader, stripeMetricSnapshot } from '@flow/stripe-integration';
import { backfill, StripeEvidenceDatabase } from '@flow/stripe-postgres';
import { stripeConfig } from './stripe-config';
async function main(): Promise<void> {
  const config = stripeConfig('ingress');
  const args = process.argv.slice(2);
  if (args.length < 2 || args.length > 3)
    throw new Error(
      'Provide explicit from/to epoch seconds and optional page bound',
    );
  const pool = new Pool({
    connectionString: config.url,
    max: 2,
    connectionTimeoutMillis: 1000,
    statement_timeout: 5000,
  });
  pool.on('error', () =>
    process.stderr.write('Stripe backfill database unavailable\n'),
  );
  try {
    const result = await backfill(
      new StripeEvidenceDatabase(pool, config.binding),
      stripeReader(config.key),
      Number(args[0]),
      Number(args[1]),
      args[2] === undefined ? 10 : Number(args[2]),
    );
    process.stdout.write(
      JSON.stringify({
        ...result,
        completeness: 'UNKNOWN',
        windowFrom: Number(args[0]),
        windowTo: Number(args[1]),
        metrics: stripeMetricSnapshot(),
      }) + '\n',
    );
  } finally {
    await pool.end();
  }
}
void main().catch(() => {
  process.stderr.write(
    'Bounded Stripe backfill failed; repeat the explicit window with overlap after resolving the failure\n',
  );
  process.exitCode = 1;
});
