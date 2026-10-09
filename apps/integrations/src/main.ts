import { sandboxKey } from '@flow/stripe-integration';
import { Pool } from 'pg';
import { StripeEvidenceDatabase } from '@flow/stripe-postgres';
import { ingressServer } from './index';
async function main(): Promise<void> {
  const {
    STRIPE_ACCOUNT_ID,
    STRIPE_SOURCE_ACCOUNT_ID,
    STRIPE_INGRESS_DATABASE_URL,
    STRIPE_WEBHOOK_SECRETS,
    STRIPE_MODE,
  } = process.env;
  if (
    STRIPE_MODE !== 'sandbox' ||
    !STRIPE_ACCOUNT_ID ||
    !STRIPE_SOURCE_ACCOUNT_ID ||
    !STRIPE_INGRESS_DATABASE_URL ||
    !STRIPE_WEBHOOK_SECRETS
  )
    throw new Error('Sandbox ingress configuration required');
  if (process.env['STRIPE_SECRET_KEY'])
    sandboxKey(process.env['STRIPE_SECRET_KEY']);
  const pool = new Pool({
    connectionString: STRIPE_INGRESS_DATABASE_URL,
    max: 4,
    connectionTimeoutMillis: 1000,
    statement_timeout: 1000,
    idleTimeoutMillis: 10000,
  });
  pool.on('error', () =>
    process.stderr.write(
      '{"subsystem":"stripe-ingress","outcome":"database_unavailable"}\n',
    ),
  );
  try {
    const store = new StripeEvidenceDatabase(pool, {
      accountId: STRIPE_ACCOUNT_ID,
      sourceAccountId: STRIPE_SOURCE_ACCOUNT_ID,
    });
    if (!(await store.ready()))
      throw new Error('Source capability binding unavailable');
    const server = ingressServer(store, {
      accountId: STRIPE_ACCOUNT_ID,
      secrets: STRIPE_WEBHOOK_SECRETS.split(','),
      log: (entry) => process.stdout.write(JSON.stringify(entry) + '\n'),
    });
    const port = Number(process.env['STRIPE_INGRESS_PORT'] ?? 4242);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error('Invalid ingress port');
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    let closing = false;
    const close = (): void => {
      if (closing) return;
      closing = true;
      server.close(() => {
        void pool.end();
      });
      server.closeIdleConnections();
    };
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
  } catch (e) {
    await pool.end();
    throw e;
  }
}
void main().catch(() => {
  process.stderr.write(
    'Stripe ingress startup failed; inspect sandbox configuration and database binding\n',
  );
  process.exitCode = 1;
});
