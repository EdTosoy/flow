import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import Stripe from 'stripe';
import {
  stripeReader,
  verifyWebhook,
  STRIPE_API_VERSION,
  EVENT_TYPES,
  eventEnvelope,
  financialPacket,
  object,
  paginate,
  classifyApiFailure,
  sandboxKey,
  balanceMovements,
  StripeBoundaryError,
} from '../src/index';
import { stripeFixture } from './fixture';
const secret = 'whsec_' + randomBytes(24).toString('hex');
function signed(
  payload: string,
  timestamp = Math.floor(Date.now() / 1000),
  key = secret,
): string {
  return Stripe.webhooks.generateTestHeaderString({
    payload,
    secret: key,
    timestamp,
  });
}
test('official signature verification uses exact bytes, timestamp tolerance and bounded rotation', () => {
  const f = stripeFixture(),
    raw = JSON.stringify(f.event());
  assert.equal(
    verifyWebhook(Buffer.from(raw), signed(raw), [secret], f.accountId)
      .apiVersion,
    STRIPE_API_VERSION,
  );
  assert.throws(() =>
    verifyWebhook(Buffer.from(raw + ' '), signed(raw), [secret], f.accountId),
  );
  for (const signature of [
    undefined,
    'invalid',
    signed(raw, Math.floor(Date.now() / 1000) - 301),
    signed(
      raw,
      Math.floor(Date.now() / 1000),
      'whsec_' + randomBytes(24).toString('hex'),
    ),
  ])
    assert.throws(() =>
      verifyWebhook(Buffer.from(raw), signature, [secret], f.accountId),
    );
  assert.doesNotThrow(() =>
    verifyWebhook(
      Buffer.from(raw),
      signed(raw),
      ['whsec_' + randomBytes(24).toString('hex'), secret],
      f.accountId,
    ),
  );
  assert.throws(() =>
    verifyWebhook(Buffer.from('{'), signed(raw), [secret], f.accountId),
  );
});
test('live, foreign/context and unsupported events are rejected', () => {
  const f = stripeFixture();
  for (const extra of [
    { livemode: true },
    { account: 'acct_other' },
    { context: 'acct_other' },
  ])
    assert.throws(() =>
      eventEnvelope(
        f.event('charge.succeeded', f.chargeId, extra),
        f.accountId,
      ),
    );
  assert.throws(() => eventEnvelope(f.event('customer.created'), f.accountId));
  assert.equal(EVENT_TYPES.length, 12);
  assert.throws(() => sandboxKey('sk_live_' + 'placeholder'));
  assert.throws(() => sandboxKey('unrecognized'));
});
test('capture gross and authoritative fee conserve net exactly', async () => {
  const f = stripeFixture();
  const packet = await financialPacket(
    eventEnvelope(f.event(), f.accountId),
    async (k, id) => object(await f.reader.read(k, id)),
    async () => [],
  );
  assert.deepEqual(
    packet.movements.map((m) => m.amount.amountMinor),
    ['-320', '10000'],
  );
  assert.equal(packet.movements[0]!.parentReference, f.chargeBt + ':gross');
});
test('partial refunds remain distinct and inherit the capture identity', async () => {
  const f = stripeFixture();
  const packet = await financialPacket(
    eventEnvelope(f.event('refund.updated', f.refundId), f.accountId),
    async (k, id) => object(await f.reader.read(k, id)),
    async () => [],
  );
  const r = packet.movements.find((x) => x.subtype === 'refund')!;
  assert.equal(r.amount.amountMinor, '-2000');
  assert.equal(r.parentReference, f.chargeBt + ':gross');
  assert.equal(r.reference, f.chargeId);
});
test('dispute withdrawal and fees map; reinstatement refuses a false capture', async () => {
  const f = stripeFixture();
  const packet = await financialPacket(
    eventEnvelope(
      f.event('charge.dispute.funds_withdrawn', f.disputeId),
      f.accountId,
    ),
    async (k, id) => object(await f.reader.read(k, id)),
    async () => [],
  );
  assert.equal(
    packet.movements.find((m) => m.subtype === 'chargeback')?.amount
      .amountMinor,
    '-1000',
  );
  f.resources.get('balance_transaction:' + f.disputeBt)!['amount'] = 1000;
  f.resources.get('balance_transaction:' + f.disputeBt)!['net'] = 850;
  await assert.rejects(
    financialPacket(
      eventEnvelope(
        f.event('charge.dispute.funds_reinstated', f.disputeId),
        f.accountId,
      ),
      async (k, id) => object(await f.reader.read(k, id)),
      async () => [],
    ),
    { code: 'DISPUTE_REINSTATEMENT_UNSUPPORTED' },
  );
});
test('automatic payout membership comes from all paginated explicit transactions', async () => {
  const f = stripeFixture();
  const packet = await financialPacket(
    eventEnvelope(
      f.event('payout.reconciliation_completed', f.payoutId),
      f.accountId,
    ),
    async (k, id) => object(await f.reader.read(k, id)),
    (payout) => paginate(f.reader, 'payout_transactions', { payout }),
  );
  assert.equal(packet.settlements[0]!.amount.amountMinor, '6530');
  assert.equal(packet.settlements[0]!.componentIds.length, 5);
  assert.equal(packet.settlements[0]!.componentKind, 'processor-movement');
  assert.equal(f.calls.filter((x) => x.startsWith('list:')).length, 2);
  f.resources.get('payout:' + f.payoutId)!['automatic'] = false;
  await assert.rejects(
    financialPacket(
      eventEnvelope(f.event('payout.paid', f.payoutId), f.accountId),
      async (k, id) => object(await f.reader.read(k, id)),
      async () => [],
    ),
    { code: 'PAYOUT_MEMBERSHIP_UNPROVEN' },
  );
});
test('pagination refuses truncated scans and repeated cursors', async () => {
  const f = stripeFixture();
  await assert.rejects(
    paginate(f.reader, 'payout_transactions', { payout: f.payoutId }, 1),
    { code: 'PAGINATION_LIMIT' },
  );
  const row = { id: 'txn_same' };
  await assert.rejects(
    paginate(
      {
        read: f.reader.read,
        list: async () => ({ object: 'list', data: [row], has_more: true }),
      },
      'payout_transactions',
      { payout: f.payoutId },
    ),
    { code: 'REPEATED_PAGE' },
  );
});
test('versions, currency, unsafe numbers, FX and guessed net are refused', async () => {
  const f = stripeFixture();
  await assert.rejects(
    financialPacket(
      eventEnvelope(
        f.event('charge.succeeded', f.chargeId, { api_version: '2019-02-19' }),
        f.accountId,
      ),
      async (k, id) => object(await f.reader.read(k, id)),
      async () => [],
    ),
    { code: 'UNSUPPORTED_EVENT_API_VERSION' },
  );
  const bt = f.resources.get('balance_transaction:' + f.chargeBt)!;
  for (const change of [
    { amount: Number.MAX_SAFE_INTEGER + 1 },
    { currency: 'jpy' },
    { exchange_rate: 1.1 },
    { net: 9999 },
    { fee: -1 },
  ])
    assert.throws(() =>
      balanceMovements({ ...bt, ...change }, 'capture', f.chargeId, null),
    );
});
test('API taxonomy exposes stable codes and bounded retry guidance', () => {
  for (const [error, code, classification] of [
    [
      { statusCode: 429, headers: { 'retry-after': '12' } },
      'STRIPE_RATE_LIMIT',
      'TRANSIENT',
    ],
    [{ statusCode: 503 }, 'STRIPE_SERVER_FAILURE', 'TRANSIENT'],
    [{ type: 'StripeConnectionError' }, 'STRIPE_NETWORK_FAILURE', 'TRANSIENT'],
    [
      { type: 'StripeConnectionError', code: 'ETIMEDOUT' },
      'STRIPE_TIMEOUT',
      'TIMEOUT',
    ],
    [{ statusCode: 401 }, 'STRIPE_CONFIGURATION', 'DOMAIN_REJECTION'],
    [{ statusCode: 400 }, 'STRIPE_INVALID_REQUEST', 'DOMAIN_REJECTION'],
    [{ statusCode: 404 }, 'STRIPE_NOT_FOUND', 'UNSUPPORTED'],
  ] as const) {
    const classified = classifyApiFailure(error);
    assert.equal(classified.code, code);
    assert.equal(classified.classification, classification);
  }
  assert.equal(
    classifyApiFailure({
      statusCode: 429,
      headers: { 'retry-after': '99999999' },
    }).retryAfterSeconds,
    3600,
  );
  assert.ok(
    classifyApiFailure(
      new StripeBoundaryError('UNSUPPORTED', 'SCHEMA'),
    ) instanceof StripeBoundaryError,
  );
});
test('official SDK transport pins the API version and uses only GET requests', async () => {
  const calls: { path: string; method: string; version: string | null }[] = [];
  const key = 'sk_test_' + 'contract_placeholder';
  const reader = stripeReader(key, async (input, init) => {
    const headers = new Headers(init?.headers);
    calls.push({
      path: String(input),
      method: init?.method ?? 'GET',
      version: headers.get('stripe-version'),
    });
    return new Response(
      JSON.stringify({ id: 'acct_contract', object: 'account' }),
      {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'request-id': 'req_contract',
        },
      },
    );
  });
  await reader.read('account', 'acct_contract');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.method, 'GET');
  assert.equal(calls[0]!.version, STRIPE_API_VERSION);
  assert.match(calls[0]!.path, /\/v1\/account$/);
});
