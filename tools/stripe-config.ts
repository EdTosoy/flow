import { sandboxKey, identity } from '@flow/stripe-integration';
import type { SourceBinding } from '@flow/stripe-postgres';
export function stripeConfig(capability: 'ingress' | 'worker'): {
  key: string;
  binding: SourceBinding;
  url: string;
} {
  if (process.env['STRIPE_MODE'] !== 'sandbox')
    throw new Error('Sandbox mode required');
  const accountId = identity(process.env['STRIPE_ACCOUNT_ID']),
    sourceAccountId = process.env['STRIPE_SOURCE_ACCOUNT_ID'];
  const url =
    process.env[
      capability === 'ingress'
        ? 'STRIPE_INGRESS_DATABASE_URL'
        : 'STRIPE_WORKER_DATABASE_URL'
    ];
  if (
    !/^acct_[A-Za-z0-9_]+$/.test(accountId) ||
    !sourceAccountId ||
    !/^[0-9a-f-]{36}$/i.test(sourceAccountId) ||
    !url
  )
    throw new Error('Stripe source capability configuration required');
  return {
    key: sandboxKey(process.env['STRIPE_SECRET_KEY']),
    binding: { accountId, sourceAccountId },
    url,
  };
}
