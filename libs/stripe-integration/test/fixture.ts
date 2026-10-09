import { randomUUID } from 'node:crypto';
import {
  STRIPE_API_VERSION,
  type StripeReader,
  type JsonObject,
  StripeBoundaryError,
} from '../src/index';
export function stripeFixture() {
  const suffix = randomUUID().replaceAll('-', ''),
    accountId = 'acct_' + suffix;
  const chargeId = 'ch_' + suffix,
    chargeBt = 'txn_charge_' + suffix,
    refundId = 're_' + suffix,
    refundBt = 'txn_refund_' + suffix,
    disputeId = 'dp_' + suffix,
    disputeBt = 'txn_dispute_' + suffix,
    payoutId = 'po_' + suffix,
    payoutBt = 'txn_payout_' + suffix;
  const created = 1767225600;
  const balance = (
    id: string,
    amount: number,
    fee: number,
    source: string,
    type: string,
    reporting_category = type,
  ): JsonObject => ({
    id,
    object: 'balance_transaction',
    amount,
    fee,
    net: amount - fee,
    currency: 'usd',
    source,
    type,
    reporting_category,
    created,
    available_on: created + 86400,
    status: 'available',
    exchange_rate: null,
  });
  const resources = new Map<string, JsonObject>([
    ['account:' + accountId, { id: accountId, object: 'account' }],
    [
      'charge:' + chargeId,
      {
        id: chargeId,
        object: 'charge',
        livemode: false,
        captured: true,
        paid: true,
        status: 'succeeded',
        amount: 10000,
        amount_captured: 10000,
        currency: 'usd',
        created,
        balance_transaction: chargeBt,
      },
    ],
    [
      'balance_transaction:' + chargeBt,
      balance(chargeBt, 10000, 320, chargeId, 'charge'),
    ],
    [
      'refund:' + refundId,
      {
        id: refundId,
        object: 'refund',
        amount: 2000,
        currency: 'usd',
        created,
        charge: chargeId,
        status: 'succeeded',
        balance_transaction: refundBt,
        failure_balance_transaction: null,
      },
    ],
    [
      'balance_transaction:' + refundBt,
      balance(refundBt, -2000, 0, refundId, 'refund'),
    ],
    [
      'dispute:' + disputeId,
      {
        id: disputeId,
        object: 'dispute',
        livemode: false,
        charge: chargeId,
        amount: 1000,
        currency: 'usd',
        created,
        status: 'needs_response',
        balance_transactions: [disputeBt],
      },
    ],
    [
      'balance_transaction:' + disputeBt,
      balance(disputeBt, -1000, 150, disputeId, 'adjustment', 'dispute'),
    ],
    [
      'payout:' + payoutId,
      {
        id: payoutId,
        object: 'payout',
        livemode: false,
        automatic: true,
        status: 'paid',
        amount: 6530,
        currency: 'usd',
        created: created + 172800,
        reconciliation_status: 'completed',
        balance_transaction: payoutBt,
        failure_balance_transaction: null,
      },
    ],
    [
      'balance_transaction:' + payoutBt,
      balance(payoutBt, -6530, 0, payoutId, 'payout'),
    ],
  ]);
  let events: JsonObject[] = [];
  let pages: JsonObject[][] = [
    [
      resources.get('balance_transaction:' + chargeBt)!,
      resources.get('balance_transaction:' + refundBt)!,
    ],
    [resources.get('balance_transaction:' + disputeBt)!],
  ];
  const calls: string[] = [];
  const reader: StripeReader = {
    read: async (kind, id) => {
      calls.push(kind + ':' + id);
      const value = resources.get(kind + ':' + id);
      if (!value)
        throw new StripeBoundaryError('UNSUPPORTED', 'STRIPE_NOT_FOUND');
      return structuredClone(value);
    },
    list: async (kind, p) => {
      calls.push('list:' + kind + ':' + (p.startingAfter ?? 'first'));
      if (kind === 'events') {
        const offset = p.startingAfter
          ? events.findIndex((e) => e['id'] === p.startingAfter) + 1
          : 0;
        return {
          object: 'list',
          data: events.slice(offset, offset + 2),
          has_more: offset + 2 < events.length,
        };
      }
      const all = pages.flat();
      const offset = p.startingAfter
        ? all.findIndex((e) => e['id'] === p.startingAfter) + 1
        : 0;
      return {
        object: 'list',
        data: all.slice(offset, offset + 2),
        has_more: offset + 2 < all.length,
      };
    },
  };
  const event = (
    type = 'charge.succeeded',
    objectId = chargeId,
    extra: JsonObject = {},
  ): JsonObject => ({
    id: 'evt_' + randomUUID().replaceAll('-', ''),
    object: 'event',
    type,
    livemode: false,
    api_version: STRIPE_API_VERSION,
    created,
    data: {
      object: {
        id: objectId,
        object: type.startsWith('charge.dispute')
          ? 'dispute'
          : type.split('.')[0],
        livemode: false,
      },
    },
    pending_webhooks: 1,
    ...extra,
  });
  return {
    accountId,
    chargeId,
    chargeBt,
    refundId,
    refundBt,
    disputeId,
    disputeBt,
    payoutId,
    payoutBt,
    created,
    resources,
    reader,
    calls,
    event,
    setEvents: (v: JsonObject[]) => {
      events = v;
    },
    setPages: (v: JsonObject[][]) => {
      pages = v;
    },
  };
}
