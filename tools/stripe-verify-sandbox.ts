import { Pool } from 'pg';
import { stripeReader, object } from '@flow/stripe-integration';
import {
  backfill,
  StripeEvidenceDatabase,
  StripeEvidenceWorker,
} from '@flow/stripe-postgres';
import { stripeConfig } from './stripe-config';
/** Fetches existing real sandbox objects; creates no external financial object and never fabricates evidence. */
async function main(): Promise<void> {
  if (!process.env['STRIPE_SECRET_KEY'] || !process.env['STRIPE_ACCOUNT_ID']) {
    process.stdout.write(
      'BLOCKED: Stripe sandbox credentials/account configuration unavailable\n',
    );
    process.exitCode = 2;
    return;
  }
  const ingress = stripeConfig('ingress'),
    worker = stripeConfig('worker'),
    api = stripeReader(ingress.key);
  const account = object(await api.read('account', ingress.binding.accountId));
  if (account['id'] !== ingress.binding.accountId)
    throw new Error('Sandbox account mismatch');
  const importPool = new Pool({
      connectionString: ingress.url,
      max: 2,
      connectionTimeoutMillis: 1000,
      statement_timeout: 5000,
    }),
    workPool = new Pool({
      connectionString: worker.url,
      max: 4,
      connectionTimeoutMillis: 1000,
      statement_timeout: 10000,
    });
  importPool.on('error', () =>
    process.stderr.write('Sandbox verification database unavailable\n'),
  );
  workPool.on('error', () =>
    process.stderr.write('Sandbox verification database unavailable\n'),
  );
  try {
    const now = Math.floor(Date.now() / 1000);
    const result = await backfill(
      new StripeEvidenceDatabase(importPool, ingress.binding),
      api,
      now - 86400,
      now,
      10,
    );
    if (result.received === 0)
      throw new Error('No real supported sandbox event available');
    const executor = new StripeEvidenceWorker(workPool, worker.binding, api);
    await executor.processBatch('stripe-sandbox-verification', 100);
    const proven = await executor.completedEvidenceCount(now - 86400, now);
    if (proven === 0n)
      throw new Error(
        'No supported sandbox event completed economic interpretation',
      );
    process.stdout.write(
      JSON.stringify({
        externalSandbox: 'PASS',
        apiVersion: '2026-09-30.endive',
        eventsRecovered: result.received,
        completedEvidence: proven.toString(),
        bankBoundary: 'synthetic only',
      }) + '\n',
    );
  } finally {
    await Promise.all([importPool.end(), workPool.end()]);
  }
}
void main().catch(() => {
  process.stderr.write(
    'Real Stripe sandbox verification FAILED; no external success is claimed\n',
  );
  process.exitCode = 1;
});
