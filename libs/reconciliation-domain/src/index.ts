import { Money, type Currency } from '@flow/money';
import { boundedText, canonicalJson, utcTime } from '@flow/ingestion-domain';
export const RULE_VERSION = 'settlement-bank-exact-v1';
export type Outcome = 'MATCHED' | 'UNMATCHED' | 'AMBIGUOUS' | 'INELIGIBLE';
export interface RunCommand {
  readonly mappingId: string;
  readonly runKey: string;
  /** Half-open UTC scope, applied to report time and bank booking time independently. */
  readonly from: string;
  readonly to: string;
  readonly effectiveAt: string;
  readonly actorId: string;
  readonly ruleVersion?: typeof RULE_VERSION;
}
export function serializeCommand(command: RunCommand): string {
  [command.mappingId, command.runKey, command.actorId].forEach(boundedText);
  [command.from, command.to, command.effectiveAt].forEach(utcTime);
  if (command.from >= command.to)
    throw new RangeError('Empty/reversed run window');
  if (command.ruleVersion && command.ruleVersion !== RULE_VERSION)
    throw new TypeError('Unsupported rule');
  return canonicalJson({ ...command, ruleVersion: RULE_VERSION });
}
export interface RuleInput {
  readonly id: string;
  readonly eligible: boolean;
  readonly reference: string | null;
  readonly amount: Money;
  readonly time: string;
}
export interface PairEvidence {
  readonly currencyExact: boolean;
  readonly amountExact: boolean;
  readonly directionCompatible: boolean;
  readonly referenceExact: boolean;
  readonly bookingWindowValid: boolean;
}
/** Fixed synthetic contract: elapsed UTC booking within [report, report+72h]. No calendar or tolerance. */
export function evidence(processor: RuleInput, bank: RuleInput): PairEvidence {
  utcTime(processor.time);
  utcTime(bank.time);
  const delta = Date.parse(bank.time) - Date.parse(processor.time);
  return Object.freeze({
    currencyExact: processor.amount.currency === bank.amount.currency,
    amountExact: processor.amount.amountMinor === bank.amount.amountMinor,
    directionCompatible:
      processor.amount.amountMinor !== 0n &&
      processor.amount.amountMinor > 0n === bank.amount.amountMinor > 0n,
    referenceExact:
      processor.reference !== null && processor.reference === bank.reference,
    bookingWindowValid: delta >= 0 && delta <= 72 * 60 * 60 * 1000,
  });
}
/** Candidate edges use identity + temporal plausibility; a failed amount check stays a rejected candidate. */
export function evaluate(
  processors: readonly RuleInput[],
  banks: readonly RuleInput[],
): ReadonlyMap<string, Outcome> {
  if (
    new Set([...processors, ...banks].map((x) => x.id)).size !==
    processors.length + banks.length
  )
    throw new TypeError('Duplicate item identity');
  const edges = processors.flatMap((p) =>
    banks.flatMap((b) => {
      const e = evidence(p, b);
      return e.referenceExact && e.currencyExact && e.bookingWindowValid
        ? [{ p, b, e }]
        : [];
    }),
  );
  const result = new Map<string, Outcome>();
  for (const item of [...processors, ...banks]) {
    const own = edges.filter((x) => x.p.id === item.id || x.b.id === item.id);
    const other = own[0];
    const competing =
      other &&
      edges.filter((x) => x.p.id === other.p.id || x.b.id === other.b.id)
        .length > 1;
    result.set(
      item.id,
      !item.eligible
        ? 'INELIGIBLE'
        : own.length > 1 || competing
          ? 'AMBIGUOUS'
          : other &&
              other.p.eligible &&
              other.b.eligible &&
              Object.values(other.e).every(Boolean)
            ? 'MATCHED'
            : 'UNMATCHED',
    );
  }
  return result;
}
export interface RunResult {
  readonly id: string;
  readonly state: 'DRAFT' | 'SEALED' | 'RUNNING' | 'COMPLETED';
  readonly processorPopulation: number;
  readonly bankPopulation: number;
  readonly candidateCount: number;
  readonly matchedGroups: number;
  readonly outcomes: readonly {
    readonly side: 'PROCESSOR' | 'BANK';
    readonly outcome: Outcome;
    readonly count: number;
  }[];
  readonly values: readonly {
    readonly currency: Currency;
    readonly side: 'PROCESSOR' | 'BANK';
    readonly outcome: Outcome;
    readonly amountMinor: string;
  }[];
  readonly current: readonly {
    readonly status:
      'ACTIVE' | 'INVALIDATED' | 'SUPERSEDED' | 'CONFLICT' | 'STALE';
    readonly count: number;
  }[];
  readonly sourceCoverage: 'UNKNOWN' | 'PROVEN_COMPLETE' | 'PROVEN_INCOMPLETE';
  readonly populationHash: string | null;
  readonly unknownValueCount: number;
}
