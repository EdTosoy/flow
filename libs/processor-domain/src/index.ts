import { Money, type Currency, type MoneyJson } from '@flow/money';
import {
  boundedText,
  canonicalJson,
  type Observation,
} from '@flow/ingestion-domain';

export const INTERPRETER_VERSION = 'processor-v1' as const;
export type ActivityKind =
  'PAYMENT_CAPTURE' | 'PROCESSOR_FEE' | 'REFUND' | 'CHARGEBACK';
export type PaymentLifecycle =
  | 'observed'
  | 'captured'
  | 'partially_refunded'
  | 'refunded'
  | 'charged_back'
  | 'under_review';
export interface Activity {
  readonly kind: ActivityKind;
  /** Signed contribution to processor balance: capture positive; debits negative; zero fee allowed. */
  readonly contribution: MoneyJson;
  readonly paymentReference: string;
  readonly parentReference: string | null;
  readonly occurredAt: string;
  readonly control: 'INVALID_SIGN' | null;
}
export function interpret(observation: Observation): Activity {
  const money = Money.fromJSON(observation.amount);
  const kinds: Record<Observation['subtype'], ActivityKind> = {
    capture: 'PAYMENT_CAPTURE',
    fee: 'PROCESSOR_FEE',
    refund: 'REFUND',
    chargeback: 'CHARGEBACK',
  };
  return {
    kind: kinds[observation.subtype],
    contribution: money.toJSON(),
    paymentReference: observation.reference,
    parentReference: observation.parentReference,
    occurredAt: observation.occurredAt,
    control: validSign(kinds[observation.subtype], money.amountMinor)
      ? null
      : 'INVALID_SIGN',
  };
}
export function validSign(kind: ActivityKind, amount: bigint): boolean {
  return kind === 'PAYMENT_CAPTURE'
    ? amount > 0n
    : kind === 'PROCESSOR_FEE'
      ? amount <= 0n
      : amount < 0n;
}
/** Aggregate bigint deliberately exceeds individual Money bounds without narrowing. */
export function settlementNet(
  components: readonly Money[],
  code: Currency,
): bigint {
  let net = 0n;
  for (const component of components) {
    if (component.currency !== code)
      throw new TypeError('Cross-currency membership');
    net += component.amountMinor;
  }
  return net;
}
export function lifecycle(
  captured: bigint,
  refunds: bigint,
  chargebacks: bigint,
  controls: readonly string[],
): PaymentLifecycle {
  if (
    controls.length ||
    refunds > captured ||
    captured < 0n ||
    refunds < 0n ||
    chargebacks < 0n
  )
    return 'under_review';
  if (chargebacks > 0n) return 'charged_back';
  if (captured === 0n) return 'observed';
  if (refunds === captured) return 'refunded';
  if (refunds > 0n) return 'partially_refunded';
  return 'captured';
}
export function derivationIdentity(
  revisionId: string,
  normalizerVersion: string,
  interpreterVersion = INTERPRETER_VERSION,
): string {
  [revisionId, normalizerVersion, interpreterVersion].forEach(boundedText);
  return canonicalJson([revisionId, normalizerVersion, interpreterVersion]);
}
export interface DerivationResult {
  readonly id: string;
  readonly replayed: boolean;
  readonly kind: 'activity' | 'settlement';
  readonly paymentId: string | null;
}
export interface EvaluationResult {
  readonly id: string;
  readonly replayed: boolean;
  readonly result: {
    readonly controls: readonly string[];
    readonly lifecycle?: PaymentLifecycle;
    readonly capturedMinor?: string | null;
    readonly refundedMinor?: string | null;
    readonly validRefundMinor?: string;
    readonly chargebackMinor?: string | null;
    readonly reportedNetMinor?: string;
    readonly calculatedNetMinor?: string | null;
    readonly knownComponentNetMinor?: string;
    readonly currency?: Currency | null;
    readonly membershipCount?: number;
  };
}
