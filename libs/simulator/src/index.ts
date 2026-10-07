import { createHash } from 'node:crypto';
import { Money, type MoneyJson } from '@flow/money';
import { validatePost, type PostJournalCommand } from '@flow/ledger-domain';

export interface InternalExpectation {
  readonly id: string;
  readonly paymentReference: string;
  readonly payerId: string;
  readonly kind: 'capture' | 'refund';
  readonly amount: MoneyJson;
  readonly occurredAt: string;
}
export interface ProcessorActivity {
  readonly id: string;
  readonly kind: 'capture' | 'fee' | 'refund' | 'chargeback';
  readonly paymentReference: string;
  readonly parentCaptureId: string | null;
  /** Signed processor balance contribution. Fees/refunds/chargebacks are negative. */
  readonly amount: MoneyJson;
  readonly occurredAt: string;
}
export interface SourceEvent {
  readonly deliveryId: string;
  readonly sourceAccountId: string;
  readonly eventId: string;
  readonly occurredAt: string;
  readonly deliveredAt: string;
  /** Original synthetic JSON bytes. Malformed records remain representable. */
  readonly payload: string;
}
export interface SettlementReport {
  readonly id: string;
  readonly sourceAccountId: string;
  readonly transferReference: string;
  readonly reportedAt: string;
  readonly componentIds: readonly string[];
  readonly gross: MoneyJson;
  readonly fees: MoneyJson;
  readonly refunds: MoneyJson;
  readonly chargebacks: MoneyJson;
  readonly net: MoneyJson;
}
export interface BankObservation {
  readonly id: string;
  readonly sourceAccountId: string;
  readonly transferReference: string;
  readonly status: 'booked';
  readonly bookedAt: string;
  readonly amount: MoneyJson;
}
export interface CaptureAttempt {
  readonly attemptId: string;
  readonly commandKey: string;
  readonly expectation: InternalExpectation;
}
/** This is the ONLY object handed to the system under test. */
export interface SystemInput {
  readonly scope: {
    readonly environment: 'synthetic';
    readonly merchantId: string;
    readonly processorAccountId: string;
    readonly bankAccountId: string;
  };
  readonly internalExpectations: readonly InternalExpectation[];
  readonly processorEvents: readonly SourceEvent[];
  readonly settlements: readonly SettlementReport[];
  readonly bankObservations: readonly BankObservation[];
  readonly captureAttempts: readonly CaptureAttempt[];
}
export interface ScenarioManifest {
  readonly scenarioId: string;
  readonly simulatorVersion: string;
  readonly seed: number;
  readonly startTime: string;
  /** Generation settings and fault counts; explicit placements are private. */
  readonly configuration: Readonly<Record<string, unknown>>;
  readonly configurationSha256: string;
  readonly inputSha256: string;
  /** Counts of delivered input only, never hidden missing/canonical counts. */
  readonly recordCounts: Readonly<
    Record<keyof Omit<SystemInput, 'scope'>, number>
  >;
}

/** Sorted object keys, preserved array order; exact JSON values only. */
export function stableJson(value: unknown): string {
  function normalize(item: unknown): unknown {
    if (item === null || typeof item === 'string' || typeof item === 'boolean')
      return item;
    if (typeof item === 'number' && Number.isSafeInteger(item)) return item;
    if (Array.isArray(item)) return item.map(normalize);
    if (typeof item === 'object' && item !== null) {
      return Object.fromEntries(
        Object.keys(item)
          .sort()
          .map((key) => [
            key,
            normalize((item as Record<string, unknown>)[key]),
          ]),
      );
    }
    throw new TypeError('Scenario JSON requires exact serializable values');
  }
  return JSON.stringify(normalize(value));
}
export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Caller supplies the book/accounts. No persistence, oracle or table mutation. */
export function captureCommand(
  attempt: CaptureAttempt,
  context: {
    readonly bookId: string;
    readonly receivableAccountId: string;
    readonly salesAccountId: string;
  },
): PostJournalCommand {
  if (attempt.expectation.kind !== 'capture')
    throw new TypeError('Capture expectation required');
  const money = Money.fromJSON(attempt.expectation.amount);
  const command: PostJournalCommand = {
    bookId: context.bookId,
    commandKey: attempt.commandKey,
    actorId: 'synthetic-simulator-harness',
    reason: 'synthetic merchant capture mechanics',
    effectNamespace: 'simulator.capture',
    businessEffectKey: attempt.expectation.id,
    currency: money.currency,
    effectiveAt: attempt.expectation.occurredAt,
    policyVersion: 'synthetic-merchant-capture-v1',
    entries: [
      { accountId: context.receivableAccountId, side: 'debit', money },
      { accountId: context.salesAccountId, side: 'credit', money },
    ],
  };
  validatePost(command);
  return command;
}
