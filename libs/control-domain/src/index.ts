import { Money, type Currency, type MoneyJson } from '@flow/money';
export const CONTROL_VERSION = 'financial-controls-v1';
export type Status = 'PASS' | 'FAIL' | 'UNKNOWN';
export type ControlType =
  | 'SOURCE'
  | 'SOURCE_PERIOD'
  | 'PROCESSING_PARTITION'
  | 'PROCESSING_COMPLETION'
  | 'PROCESSOR_COVERAGE'
  | 'BANK_COVERAGE'
  | 'PROCESSOR'
  | 'PROCESSOR_TOTAL'
  | 'BANK'
  | 'BANK_TOTAL'
  | 'BANK_COMPLETENESS'
  | 'RECONCILIATION'
  | 'ALLOCATION'
  | 'LEDGER'
  | 'EXPOSURE'
  | 'FRESHNESS';
export interface ControlCommand {
  readonly bookId: string;
  readonly runKey: string;
  readonly actorId: string;
  readonly reconciliationRunIds: readonly string[];
  readonly version?: typeof CONTROL_VERSION;
  /** Explicit elapsed-time policy; no reminder scheduling. */
  readonly maxAgeSeconds?: number;
  readonly createCases?: boolean;
}
export function serializeControl(command: ControlCommand): string {
  for (const t of [command.bookId, command.runKey, command.actorId])
    if (typeof t !== 'string' || !t.trim() || t.length > 512)
      throw new TypeError('Invalid control identity');
  if (command.version !== undefined && command.version !== CONTROL_VERSION)
    throw new RangeError('Unsupported control version');
  if (
    !Array.isArray(command.reconciliationRunIds) ||
    command.reconciliationRunIds.some((id) => typeof id !== 'string' || !id) ||
    new Set(command.reconciliationRunIds).size !==
      command.reconciliationRunIds.length
  )
    throw new TypeError('Invalid reconciliation population');
  const age = command.maxAgeSeconds ?? 86400;
  if (!Number.isSafeInteger(age) || age < 1 || age > 31536000)
    throw new RangeError('Invalid age policy');
  return JSON.stringify({
    ...command,
    version: CONTROL_VERSION,
    maxAgeSeconds: age,
    createCases: command.createCases ?? false,
    reconciliationRunIds: [...command.reconciliationRunIds].sort(),
  });
}
export function partitionStatus(
  received: bigint,
  normalized: bigint,
  failed: bigint,
  pending: bigint,
): Status {
  if ([received, normalized, failed, pending].some((n) => n < 0n))
    return 'FAIL';
  return received === normalized + failed + pending ? 'PASS' : 'FAIL';
}
/** Individual amounts use Money; aggregate totals use unbounded exact integer strings. */
export function discrepancy(
  expected: Money,
  observed: Money,
): { amountMinor: string; currency: Currency } {
  if (expected.currency !== observed.currency)
    throw new RangeError('Currency mismatch');
  return {
    amountMinor: (observed.amountMinor - expected.amountMinor).toString(),
    currency: expected.currency,
  };
}
export function totalStatus(
  expected: string | null,
  observed: string | null,
): Status {
  if (expected === null || observed === null) return 'UNKNOWN';
  return BigInt(expected) === BigInt(observed) ? 'PASS' : 'FAIL';
}
export interface ExposureComponent {
  readonly identity: string;
  readonly currency: Currency;
  readonly amount: MoneyJson | null;
  readonly acceptedRisk: boolean;
}
export function exposureTotals(components: readonly ExposureComponent[]) {
  const identities = new Map<string, ExposureComponent>(),
    totals = new Map<
      Currency,
      {
        currency: Currency;
        unreconciledMinor: bigint;
        acceptedRiskMinor: bigint;
        unknownCount: number;
        acceptedRiskUnknownCount: number;
      }
    >();
  for (const c of components) {
    const prior = identities.get(c.identity);
    if (prior) {
      if (JSON.stringify(prior) !== JSON.stringify(c))
        throw new RangeError('Conflicting exposure identity');
      continue;
    }
    identities.set(c.identity, c);
    const t = totals.get(c.currency) ?? {
      currency: c.currency,
      unreconciledMinor: 0n,
      acceptedRiskMinor: 0n,
      unknownCount: 0,
      acceptedRiskUnknownCount: 0,
    };
    if (c.amount === null) {
      t.unknownCount++;
      if (c.acceptedRisk) t.acceptedRiskUnknownCount++;
    } else {
      const m = Money.fromJSON(c.amount);
      if (m.currency !== c.currency || m.amountMinor < 0n)
        throw new RangeError('Invalid exposure');
      t.unreconciledMinor += m.amountMinor;
      if (c.acceptedRisk) t.acceptedRiskMinor += m.amountMinor;
    }
    totals.set(c.currency, t);
  }
  return [...totals.values()]
    .sort((a, b) => a.currency.localeCompare(b.currency))
    .map((t) => ({
      ...t,
      knownUnreconciledMinor: t.unreconciledMinor.toString(),
      knownAcceptedRiskMinor: t.acceptedRiskMinor.toString(),
      unreconciledMinor:
        t.unknownCount > 0 ? null : t.unreconciledMinor.toString(),
      acceptedRiskMinor:
        t.acceptedRiskUnknownCount > 0 ? null : t.acceptedRiskMinor.toString(),
    }));
}
export interface ControlResult {
  readonly key: string;
  readonly type: ControlType;
  readonly status: Status;
  readonly unit: 'COUNT' | 'MINOR_UNITS' | 'SECONDS' | 'ASSERTION';
  readonly severity: 'WARNING' | 'ERROR' | 'CRITICAL';
  readonly scope: Readonly<Record<string, unknown>>;
  readonly currency: Currency | null;
  readonly expected: string | null;
  readonly observed: string | null;
  readonly discrepancy: string | null;
  readonly details: Readonly<Record<string, unknown>>;
}
export interface ControlSummary {
  readonly id: string;
  readonly bookId: string;
  readonly version: string;
  readonly state: 'DRAFT' | 'SEALED' | 'EVALUATING' | 'COMPLETED';
  readonly frozenAt: string | null;
  readonly completedAt: string | null;
  readonly current: boolean;
  readonly currentReason:
    | 'INCOMPLETE'
    | 'EVALUATION_EXPIRED'
    | 'UNCHANGED_INPUTS'
    | 'INPUTS_CHANGED'
    | 'CURRENT_POPULATION_UNSUPPORTED';
  readonly assurance: Status;
  readonly results: readonly ControlResult[];
  readonly statuses: readonly {
    type: ControlType;
    status: Status;
    count: number;
  }[];
  readonly processing: readonly Record<string, unknown>[];
  readonly reconciliation: readonly Record<string, unknown>[];
  readonly exposure: readonly Record<string, unknown>[];
  readonly cases: readonly { key: string; caseId: string }[];
}
