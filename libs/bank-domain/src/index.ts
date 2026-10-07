import { Money, type Currency } from '@flow/money';
import { boundedText, canonicalJson } from '@flow/ingestion-domain';
export const INTERPRETER_VERSION = 'bank-v1';
export type BankDirection = 'CREDIT' | 'DEBIT';
export interface BankMovement {
  readonly amount: Money;
  readonly direction: BankDirection;
}
export function movement(signed: Money): BankMovement {
  if (signed.amountMinor === 0n)
    throw new RangeError('Zero is not a bank movement');
  return Object.freeze({
    direction: signed.amountMinor > 0n ? 'CREDIT' : 'DEBIT',
    amount: Money.of(
      signed.amountMinor < 0n ? -signed.amountMinor : signed.amountMinor,
      signed.currency,
    ),
  });
}
/** Exact aggregate may exceed an individual Money/BIGINT range. Stocks may be negative. */
export function calculatedClosing(
  opening: Money,
  entries: readonly BankMovement[],
): bigint {
  let total = opening.amountMinor;
  for (const e of entries) {
    if (
      e.amount.currency !== opening.currency ||
      e.amount.amountMinor <= 0n ||
      !['CREDIT', 'DEBIT'].includes(e.direction)
    )
      throw new TypeError('Invalid bank movement');
    total +=
      e.direction === 'CREDIT' ? e.amount.amountMinor : -e.amount.amountMinor;
  }
  return total;
}
export function semanticIdentity(
  revisionId: string,
  normalizerVersion: string,
  interpreterVersion = INTERPRETER_VERSION,
): string {
  [revisionId, normalizerVersion, interpreterVersion].forEach(boundedText);
  return canonicalJson({ revisionId, normalizerVersion, interpreterVersion });
}
export interface DerivationResult {
  readonly id: string;
  readonly replayed: boolean;
  readonly kind: 'entry' | 'statement';
  readonly accountId: string;
}
export interface StatementControlResult {
  readonly controls: readonly string[];
  readonly currency: Currency;
  readonly completeness: 'UNKNOWN' | 'PROVEN_COMPLETE' | 'PROVEN_INCOMPLETE';
  readonly receivedLineCount: number;
  readonly expectedLineCount: number | null;
  readonly openingMinor: string | null;
  readonly reportedClosingMinor: string | null;
  readonly calculatedClosingMinor: string | null;
  readonly knownMovementNetMinor: string;
  readonly creditsMinor: string;
  readonly debitsMinor: string;
  readonly arithmeticStatus: 'PASS' | 'FAIL' | 'UNVERIFIED';
}
export interface EvaluationResult {
  readonly id: string;
  readonly replayed: boolean;
  readonly result: StatementControlResult;
}
export interface BankSummary {
  readonly entries: number;
  readonly ambiguousEntries: number;
  readonly observationOnlyEntries: number;
  readonly totals: readonly {
    readonly currency: Currency;
    readonly creditsMinor: string;
    readonly debitsMinor: string;
  }[];
}
