import { stripeMetric } from './telemetry';
export {
  stripeMetric,
  stripeMetrics,
  stripeMetricSnapshot,
  METRIC_NAMES,
} from './telemetry';
import Stripe from 'stripe';
import { Money, currency } from '@flow/money';
import {
  canonicalJson,
  type Observation,
  type SettlementObservation,
  type ExternalEventObservation,
} from '@flow/ingestion-domain';
export const STRIPE_API_VERSION = '2026-09-30.endive';
export const EVENT_TYPES = Object.freeze([
  'charge.succeeded',
  'refund.created',
  'refund.updated',
  'refund.failed',
  'charge.dispute.created',
  'charge.dispute.funds_withdrawn',
  'charge.dispute.funds_reinstated',
  'charge.dispute.closed',
  'payout.created',
  'payout.paid',
  'payout.failed',
  'payout.reconciliation_completed',
] as const);
export type JsonObject = Record<string, unknown>;
export class StripeBoundaryError extends Error {
  constructor(
    readonly classification:
      'TRANSIENT' | 'TIMEOUT' | 'UNSUPPORTED' | 'DOMAIN_REJECTION' | 'POISON',
    readonly code: string,
    readonly retryAfterSeconds = 0,
  ) {
    super(code);
  }
}
export function object(v: unknown): JsonObject {
  if (!v || typeof v !== 'object' || Array.isArray(v))
    throw new StripeBoundaryError('UNSUPPORTED', 'UNSUPPORTED_SCHEMA');
  return v as JsonObject;
}
export function identity(v: unknown): string {
  if (typeof v !== 'string' || !/^[A-Za-z0-9_:-]{1,256}$/.test(v))
    throw new StripeBoundaryError('UNSUPPORTED', 'INVALID_IDENTITY');
  return v;
}
export function resourceId(v: unknown): string {
  return identity(typeof v === 'object' && v !== null ? object(v)['id'] : v);
}
export function timestamp(v: unknown): string {
  if (
    typeof v !== 'number' ||
    !Number.isSafeInteger(v) ||
    v < 0 ||
    v > 253402300799
  )
    throw new StripeBoundaryError('UNSUPPORTED', 'INVALID_TIMESTAMP');
  return new Date(v * 1000).toISOString();
}
function supportedCurrency(v: unknown): ReturnType<typeof currency> {
  try {
    return currency(String(v).toUpperCase());
  } catch {
    throw new StripeBoundaryError('UNSUPPORTED', 'UNSUPPORTED_CURRENCY');
  }
}
function integer(v: unknown): bigint {
  if (typeof v !== 'number' || !Number.isSafeInteger(v))
    throw new StripeBoundaryError('UNSUPPORTED', 'UNSAFE_MINOR_UNITS');
  return BigInt(v);
}
export function sandboxKey(key: unknown): string {
  if (typeof key !== 'string' || !/^(sk|rk)_test_[A-Za-z0-9_]+$/.test(key))
    throw new StripeBoundaryError('DOMAIN_REJECTION', 'SANDBOX_KEY_REQUIRED');
  return key;
}
export interface EventEnvelope {
  id: string;
  type: string;
  created: number;
  apiVersion: string | null;
  objectId: string;
  value: JsonObject;
}
export function eventEnvelope(
  value: unknown,
  accountId: string,
): EventEnvelope {
  const e = object(value);
  identity(accountId);
  if (e['object'] !== 'event' || e['livemode'] !== false)
    throw new StripeBoundaryError('DOMAIN_REJECTION', 'SANDBOX_EVENT_REQUIRED');
  // Root-account snapshot events often omit account. Connect/context events are outside this single-account boundary.
  if (e['account'] !== undefined || e['context'] !== undefined)
    throw new StripeBoundaryError(
      'DOMAIN_REJECTION',
      'UNEXPECTED_ACCOUNT_CONTEXT',
    );
  const id = identity(e['id']),
    type = String(e['type']);
  if (!EVENT_TYPES.includes(type as (typeof EVENT_TYPES)[number]))
    throw new StripeBoundaryError('UNSUPPORTED', 'EVENT_NOT_ALLOWLISTED');
  const data = object(object(e['data'])['object']);
  if (
    data['livemode'] === true ||
    data['on_behalf_of'] ||
    data['transfer_data'] ||
    data['source_transfer']
  )
    throw new StripeBoundaryError(
      'DOMAIN_REJECTION',
      'UNSUPPORTED_LIVE_OR_CONNECT',
    );
  timestamp(e['created']);
  if (e['api_version'] !== null && typeof e['api_version'] !== 'string')
    throw new StripeBoundaryError('UNSUPPORTED', 'INVALID_EVENT_VERSION');
  return {
    id,
    type,
    created: e['created'] as number,
    apiVersion: e['api_version'] as string | null,
    objectId: identity(data['id']),
    value: e,
  };
}
export function verifyWebhook(
  raw: Buffer,
  signature: string | undefined,
  secrets: readonly string[],
  accountId: string,
): EventEnvelope {
  if (
    !signature ||
    signature.length > 4096 ||
    secrets.length < 1 ||
    secrets.length > 2 ||
    secrets.some((s) => !/^whsec_[A-Za-z0-9_]+$/.test(s))
  )
    throw new StripeBoundaryError('DOMAIN_REJECTION', 'INVALID_SIGNATURE');
  let value: unknown;
  let verified = false;
  for (const secret of secrets) {
    try {
      value = Stripe.webhooks.constructEvent(raw, signature, secret, 300);
      verified = true;
      break;
    } catch {
      /* Never expose SDK errors or signature/secret material. */
    }
  }
  if (!verified)
    throw new StripeBoundaryError('DOMAIN_REJECTION', 'INVALID_SIGNATURE');
  return eventEnvelope(value, accountId);
}
export function eventObservation(e: EventEnvelope): ExternalEventObservation {
  return {
    type: 'external-event',
    provider: 'stripe',
    externalId: e.id,
    occurredAt: timestamp(e.created),
    eventType: e.type,
    apiVersion: e.apiVersion,
    objectId: e.objectId,
  };
}
export function classifyApiFailure(error: unknown): StripeBoundaryError {
  if (error instanceof StripeBoundaryError) return error;
  const e =
    typeof error === 'object' && error !== null ? (error as JsonObject) : {};
  const status = e['statusCode'],
    type = e['type'];
  const headers =
    typeof e['headers'] === 'object' && e['headers'] !== null
      ? (e['headers'] as JsonObject)
      : {};
  const hint = Number(headers['retry-after']);
  const retry =
    Number.isFinite(hint) && hint > 0 ? Math.min(3600, Math.ceil(hint)) : 1;
  if (status === 429 || type === 'StripeRateLimitError')
    return new StripeBoundaryError('TRANSIENT', 'STRIPE_RATE_LIMIT', retry);
  if (typeof status === 'number' && status >= 500)
    return new StripeBoundaryError('TRANSIENT', 'STRIPE_SERVER_FAILURE', retry);
  const detail =
    typeof e['detail'] === 'object' && e['detail'] !== null
      ? (e['detail'] as JsonObject)
      : {};
  if (type === 'StripeConnectionError')
    return new StripeBoundaryError(
      e['code'] === 'ETIMEDOUT' || detail['code'] === 'ETIMEDOUT'
        ? 'TIMEOUT'
        : 'TRANSIENT',
      e['code'] === 'ETIMEDOUT' || detail['code'] === 'ETIMEDOUT'
        ? 'STRIPE_TIMEOUT'
        : 'STRIPE_NETWORK_FAILURE',
      retry,
    );
  if (
    status === 401 ||
    status === 403 ||
    type === 'StripeAuthenticationError' ||
    type === 'StripePermissionError'
  )
    return new StripeBoundaryError('DOMAIN_REJECTION', 'STRIPE_CONFIGURATION');
  if (status === 404)
    return new StripeBoundaryError('UNSUPPORTED', 'STRIPE_NOT_FOUND');
  if (status === 400 || type === 'StripeInvalidRequestError')
    return new StripeBoundaryError(
      'DOMAIN_REJECTION',
      'STRIPE_INVALID_REQUEST',
    );
  return new StripeBoundaryError('UNSUPPORTED', 'STRIPE_UNEXPECTED_RESPONSE');
}
export interface StripeReader {
  read(
    kind:
      | 'account'
      | 'charge'
      | 'refund'
      | 'dispute'
      | 'balance_transaction'
      | 'payout',
    id: string,
  ): Promise<unknown>;
  list(
    kind: 'events' | 'payout_transactions',
    parameters: {
      startingAfter?: string;
      payout?: string;
      from?: number;
      to?: number;
    },
  ): Promise<unknown>;
}
/** Official SDK is confined here. No runtime method can issue a financial POST. */
export function stripeReader(
  key: string,
  transport?: typeof globalThis.fetch,
): StripeReader {
  const sdk = new Stripe(sandboxKey(key), {
    apiVersion: STRIPE_API_VERSION,
    maxNetworkRetries: 0,
    timeout: 5000,
    ...(transport
      ? { httpClient: Stripe.createFetchHttpClient(transport) }
      : {}),
  });
  const request = async (fn: () => Promise<unknown>): Promise<unknown> => {
    const start = performance.now();
    stripeMetric('stripe_api_request_total');
    try {
      return await fn();
    } catch (e) {
      stripeMetric('stripe_api_failure_total');
      throw classifyApiFailure(e);
    } finally {
      stripeMetric('stripe_api_duration_ms_total', performance.now() - start);
    }
  };
  return {
    read: (kind, id) =>
      request(() => {
        switch (kind) {
          case 'account':
            return sdk.accounts.retrieveCurrent();
          case 'charge':
            return sdk.charges.retrieve(id);
          case 'refund':
            return sdk.refunds.retrieve(id);
          case 'dispute':
            return sdk.disputes.retrieve(id);
          case 'payout':
            return sdk.payouts.retrieve(id);
          case 'balance_transaction':
            return sdk.balanceTransactions.retrieve(id);
        }
      }),
    list: (kind, p) =>
      request(() =>
        kind === 'events'
          ? sdk.events.list({
              limit: 100,
              types: [...EVENT_TYPES],
              created: { gte: p.from!, lte: p.to! },
              ...(p.startingAfter ? { starting_after: p.startingAfter } : {}),
            })
          : sdk.balanceTransactions.list({
              limit: 100,
              payout: p.payout!,
              ...(p.startingAfter ? { starting_after: p.startingAfter } : {}),
            }),
      ),
  };
}
export interface FinancialPacket {
  movements: Observation[];
  settlements: SettlementObservation[];
}
export type EvidenceFetch = (
  kind: Parameters<StripeReader['read']>[0],
  id: string,
) => Promise<JsonObject>;
function testResource(o: JsonObject): void {
  if (
    (o['livemode'] !== false &&
      !(o['object'] === 'refund' && o['livemode'] === undefined)) ||
    o['on_behalf_of'] ||
    o['transfer_data'] ||
    o['source_transfer']
  )
    throw new StripeBoundaryError(
      'UNSUPPORTED',
      'UNSUPPORTED_RESOURCE_ENVIRONMENT',
    );
}
/** Money is calculated solely with bigint. Unsafe SDK integers and unsupported currencies fail closed. */
export function balanceMovements(
  bt: JsonObject,
  kind: Observation['subtype'],
  chargeId: string,
  parent: string | null,
): Observation[] {
  if (bt['object'] !== 'balance_transaction' || bt['exchange_rate'] != null)
    throw new StripeBoundaryError(
      'UNSUPPORTED',
      'UNSUPPORTED_BALANCE_SCHEMA_OR_FX',
    );
  const code = supportedCurrency(bt['currency']);
  const gross = integer(bt['amount']),
    fee = integer(bt['fee']),
    net = integer(bt['net']);
  if (
    fee < 0n ||
    gross - fee !== net ||
    (kind === 'capture' ? gross <= 0n : gross >= 0n)
  )
    throw new StripeBoundaryError(
      'UNSUPPORTED',
      'UNSUPPORTED_BALANCE_CONSERVATION',
    );
  const id = identity(bt['id']),
    occurredAt = timestamp(bt['created']);
  timestamp(bt['available_on']);
  const movement = (
    suffix: string,
    subtype: Observation['subtype'],
    amount: bigint,
    parentReference: string | null,
  ): Observation => ({
    type: 'movement',
    subtype,
    externalId: id + suffix,
    amount: Money.of(amount, code).toJSON(),
    occurredAt,
    direction: amount > 0n ? 'inflow' : amount < 0n ? 'outflow' : 'zero',
    reference: chargeId,
    parentReference,
  });
  const main = movement(':gross', kind, gross, parent);
  return [
    main,
    ...(fee === 0n
      ? []
      : [
          movement(
            ':fee',
            'fee',
            -fee,
            kind === 'capture' ? main.externalId : parent,
          ),
        ]),
  ];
}
export async function financialPacket(
  e: EventEnvelope,
  fetch: EvidenceFetch,
  list: (payout: string) => Promise<JsonObject[]>,
): Promise<FinancialPacket> {
  if (e.apiVersion !== STRIPE_API_VERSION)
    throw new StripeBoundaryError(
      'UNSUPPORTED',
      'UNSUPPORTED_EVENT_API_VERSION',
    );
  if (e.type === 'charge.dispute.funds_reinstated')
    throw new StripeBoundaryError(
      'UNSUPPORTED',
      'DISPUTE_REINSTATEMENT_UNSUPPORTED',
    );
  if (e.type === 'refund.failed')
    throw new StripeBoundaryError(
      'UNSUPPORTED',
      'REFUND_FAILURE_REVERSAL_UNSUPPORTED',
    );
  if (e.type === 'payout.failed')
    throw new StripeBoundaryError(
      'UNSUPPORTED',
      'PAYOUT_FAILURE_REVERSAL_UNSUPPORTED',
    );
  const movements = new Map<string, Observation>(),
    settlements: SettlementObservation[] = [];
  const add = (items: Observation[]): string[] =>
    items.map((m) => {
      const old = movements.get(m.externalId);
      if (old && canonicalJson(old) !== canonicalJson(m))
        throw new StripeBoundaryError(
          'UNSUPPORTED',
          'CONFLICTING_BALANCE_EVIDENCE',
        );
      movements.set(m.externalId, m);
      return m.externalId;
    });
  const charge = async (id: string): Promise<string> => {
    const c = await fetch('charge', id);
    testResource(c);
    if (
      c['object'] !== 'charge' ||
      c['captured'] !== true ||
      c['paid'] !== true ||
      c['status'] !== 'succeeded'
    )
      throw new StripeBoundaryError('UNSUPPORTED', 'UNSUPPORTED_CAPTURE_STATE');
    if (c['balance_transaction'] == null)
      throw new StripeBoundaryError('TRANSIENT', 'BALANCE_EVIDENCE_PENDING', 1);
    const bt = await fetch(
      'balance_transaction',
      resourceId(c['balance_transaction']),
    );
    if (
      resourceId(bt['source']) !== id ||
      bt['type'] !== 'charge' ||
      integer(c['amount_captured']) !== integer(bt['amount']) ||
      c['currency'] !== bt['currency']
    )
      throw new StripeBoundaryError('UNSUPPORTED', 'CAPTURE_BALANCE_MISMATCH');
    add(balanceMovements(bt, 'capture', id, null));
    return identity(bt['id']) + ':gross';
  };
  const refund = async (id: string): Promise<string[]> => {
    const r = await fetch('refund', id);
    testResource(r);
    if (r['status'] === 'pending' || r['status'] === 'requires_action')
      throw new StripeBoundaryError('TRANSIENT', 'REFUND_EVIDENCE_PENDING', 30);
    if (
      r['object'] !== 'refund' ||
      r['status'] !== 'succeeded' ||
      r['failure_balance_transaction'] != null
    )
      throw new StripeBoundaryError('UNSUPPORTED', 'UNSUPPORTED_REFUND_STATE');
    const cid = resourceId(r['charge']),
      parent = await charge(cid);
    if (r['balance_transaction'] == null)
      throw new StripeBoundaryError('TRANSIENT', 'BALANCE_EVIDENCE_PENDING', 1);
    const bt = await fetch(
      'balance_transaction',
      resourceId(r['balance_transaction']),
    );
    if (
      resourceId(bt['source']) !== id ||
      bt['type'] !== 'refund' ||
      -integer(r['amount']) !== integer(bt['amount']) ||
      r['currency'] !== bt['currency']
    )
      throw new StripeBoundaryError('UNSUPPORTED', 'REFUND_BALANCE_MISMATCH');
    return add(balanceMovements(bt, 'refund', cid, parent));
  };
  const dispute = async (id: string): Promise<string[]> => {
    const d = await fetch('dispute', id);
    testResource(d);
    if (d['status'] === 'won')
      throw new StripeBoundaryError(
        'UNSUPPORTED',
        'DISPUTE_REINSTATEMENT_UNSUPPORTED',
      );
    if (
      d['object'] !== 'dispute' ||
      !Array.isArray(d['balance_transactions']) ||
      d['balance_transactions'].length === 0
    )
      throw new StripeBoundaryError('UNSUPPORTED', 'DISPUTE_BALANCE_UNPROVEN');
    const cid = resourceId(d['charge']),
      parent = await charge(cid),
      ids: string[] = [];
    // A reinstatement cannot be represented by the current negative-only chargeback contract.
    for (const item of d['balance_transactions']) {
      const bt = await fetch('balance_transaction', resourceId(item));
      if (
        resourceId(bt['source']) !== id ||
        bt['reporting_category'] !== 'dispute' ||
        d['currency'] !== bt['currency']
      )
        throw new StripeBoundaryError(
          'UNSUPPORTED',
          'DISPUTE_BALANCE_MISMATCH',
        );
      ids.push(...add(balanceMovements(bt, 'chargeback', cid, parent)));
    }
    return ids;
  };
  if (e.type === 'charge.succeeded') await charge(e.objectId);
  else if (e.type.startsWith('refund.')) await refund(e.objectId);
  else if (e.type.startsWith('charge.dispute.')) await dispute(e.objectId);
  else {
    const p = await fetch('payout', e.objectId);
    testResource(p);
    if (
      p['automatic'] === true &&
      (p['status'] === 'pending' ||
        p['status'] === 'in_transit' ||
        p['reconciliation_status'] === 'in_progress')
    )
      throw new StripeBoundaryError('TRANSIENT', 'PAYOUT_EVIDENCE_PENDING', 30);
    if (
      p['object'] !== 'payout' ||
      p['automatic'] !== true ||
      p['status'] !== 'paid' ||
      p['reconciliation_status'] !== 'completed' ||
      p['failure_balance_transaction'] != null
    )
      throw new StripeBoundaryError(
        'UNSUPPORTED',
        'PAYOUT_MEMBERSHIP_UNPROVEN',
      );
    const payoutBt = await fetch(
      'balance_transaction',
      resourceId(p['balance_transaction']),
    );
    if (
      payoutBt['type'] !== 'payout' ||
      resourceId(payoutBt['source']) !== e.objectId ||
      integer(payoutBt['amount']) !== -integer(p['amount']) ||
      integer(payoutBt['fee']) !== 0n ||
      integer(payoutBt['net']) !== integer(payoutBt['amount']) ||
      payoutBt['currency'] !== p['currency']
    )
      throw new StripeBoundaryError('UNSUPPORTED', 'PAYOUT_BALANCE_MISMATCH');
    const members = await list(e.objectId);
    if (members.length === 0)
      throw new StripeBoundaryError('UNSUPPORTED', 'EMPTY_PAYOUT_MEMBERSHIP');
    const memberIds: string[] = [];
    let net = 0n;
    const seen = new Set<string>();
    for (const bt of members) {
      const id = identity(bt['id']);
      if (seen.has(id))
        throw new StripeBoundaryError(
          'UNSUPPORTED',
          'DUPLICATE_PAYOUT_MEMBERSHIP',
        );
      seen.add(id);
      if (bt['currency'] !== p['currency'])
        throw new StripeBoundaryError('UNSUPPORTED', 'CROSS_CURRENCY_PAYOUT');
      const source = resourceId(bt['source']);
      const ids =
        bt['type'] === 'charge'
          ? (await charge(source),
            [
              id + ':gross',
              ...(integer(bt['fee']) === 0n ? [] : [id + ':fee']),
            ])
          : bt['type'] === 'refund'
            ? await refund(source)
            : bt['reporting_category'] === 'dispute'
              ? await dispute(source)
              : (() => {
                  throw new StripeBoundaryError(
                    'UNSUPPORTED',
                    'UNSUPPORTED_PAYOUT_COMPONENT',
                  );
                })();
      const selected = ids.filter((x) => x.startsWith(id + ':'));
      if (selected.length === 0)
        throw new StripeBoundaryError(
          'UNSUPPORTED',
          'PAYOUT_COMPONENT_MISMATCH',
        );
      let projected = 0n;
      for (const mid of selected) {
        const m = movements.get(mid);
        if (!m)
          throw new StripeBoundaryError(
            'UNSUPPORTED',
            'PAYOUT_COMPONENT_MISMATCH',
          );
        projected += Money.fromJSON(m.amount).amountMinor;
      }
      if (projected !== integer(bt['net']))
        throw new StripeBoundaryError(
          'UNSUPPORTED',
          'PAYOUT_COMPONENT_MISMATCH',
        );
      memberIds.push(...selected);
      net += integer(bt['net']);
    }
    if (net !== integer(p['amount']))
      throw new StripeBoundaryError(
        'UNSUPPORTED',
        'PAYOUT_CONSERVATION_MISMATCH',
      );
    const amount = Money.of(net, supportedCurrency(p['currency'])).toJSON();
    settlements.push({
      type: 'settlement',
      externalId: e.objectId,
      amount,
      occurredAt: timestamp(p['created']),
      direction: net > 0n ? 'inflow' : net < 0n ? 'outflow' : 'zero',
      transferReference: e.objectId,
      componentKind: 'processor-movement',
      componentIds: memberIds,
    });
  }
  return {
    movements: [...movements.values()].sort((a, b) =>
      a.externalId.localeCompare(b.externalId),
    ),
    settlements,
  };
}
export async function paginate(
  reader: StripeReader,
  kind: 'events' | 'payout_transactions',
  parameters: Parameters<StripeReader['list']>[1],
  maxPages = 10,
): Promise<JsonObject[]> {
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 10)
    throw new StripeBoundaryError('DOMAIN_REJECTION', 'INVALID_PAGE_BOUND');
  const result: JsonObject[] = [],
    seen = new Set<string>();
  let cursor: string | undefined;
  for (let i = 0; i < maxPages; i++) {
    const page = object(
      await reader.list(kind, {
        ...parameters,
        ...(cursor ? { startingAfter: cursor } : {}),
      }),
    );
    if (
      page['object'] !== 'list' ||
      !Array.isArray(page['data']) ||
      page['data'].length > 100 ||
      typeof page['has_more'] !== 'boolean'
    )
      throw new StripeBoundaryError('UNSUPPORTED', 'INVALID_PAGE');
    for (const v of page['data']) {
      const row = object(v),
        id = identity(row['id']);
      if (seen.has(id))
        throw new StripeBoundaryError('UNSUPPORTED', 'REPEATED_PAGE');
      seen.add(id);
      result.push(row);
    }
    if (!page['has_more']) return result;
    if (page['data'].length === 0)
      throw new StripeBoundaryError('UNSUPPORTED', 'EMPTY_CONTINUATION_PAGE');
    cursor = identity(object(page['data'].at(-1))['id']);
  }
  throw new StripeBoundaryError('UNSUPPORTED', 'PAGINATION_LIMIT');
}
