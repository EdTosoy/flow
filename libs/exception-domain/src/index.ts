import { Money, type MoneyJson, type Currency } from '@flow/money';

export const POLICY_VERSION = 'exception-workflow-v1';
export const STATES = [
  'OPEN',
  'UNDER_REVIEW',
  'AWAITING_EVIDENCE',
  'RESOLVED',
] as const;
export type State = (typeof STATES)[number];
export const CLASSES = [
  'MISSING_BANK_MOVEMENT',
  'EXTRA_BANK_MOVEMENT',
  'AMOUNT_MISMATCH',
  'AMBIGUOUS_MATCH',
  'PROCESSOR_INCONSISTENCY',
  'BANK_INCONSISTENCY',
  'SOURCE_INCOMPLETENESS',
  'SOURCE_REVISION_AMBIGUITY',
  'DUPLICATE_EVIDENCE',
  'TIMING_LATE_ARRIVAL',
  'UNSUPPORTED_CASE',
  'CURRENT_PROOF_INVALIDATED',
] as const;
export type Classification = (typeof CLASSES)[number];
export const RESOLUTIONS = [
  'SOURCE_CORRECTION_REQUIRED',
  'PROCESSOR_FEE_CONFIRMED',
  'TIMING_DIFFERENCE',
  'DUPLICATE_SOURCE_RECORD',
  'ACCEPTED_RISK',
  'ACCOUNTING_ADJUSTMENT_REQUIRED',
  'NOT_RECONCILED',
  'UNSUPPORTED_SOURCE',
  'OTHER',
  'FIXED_AND_VERIFIED',
] as const;
export type Resolution = (typeof RESOLUTIONS)[number];
export type Action =
  | 'START_REVIEW'
  | 'AWAIT_EVIDENCE'
  | 'RESUME_REVIEW'
  | 'SUPERSEDE'
  | 'RESOLVE'
  | 'REOPEN'
  | 'CLASSIFY'
  | 'ASSIGN'
  | 'NOTE'
  | 'ATTACH';
export function nextState(state: State, action: Action): State {
  if (action === 'START_REVIEW' && state === 'OPEN') return 'UNDER_REVIEW';
  if (action === 'AWAIT_EVIDENCE' && state === 'UNDER_REVIEW')
    return 'AWAITING_EVIDENCE';
  if (action === 'RESUME_REVIEW' && state === 'AWAITING_EVIDENCE')
    return 'UNDER_REVIEW';
  if (action === 'RESOLVE' && state === 'UNDER_REVIEW') return 'RESOLVED';
  if (action === 'SUPERSEDE' && state === 'RESOLVED') return state;
  if (action === 'REOPEN' && state === 'RESOLVED') return 'UNDER_REVIEW';
  if (
    ['NOTE', 'ATTACH'].includes(action) ||
    (['CLASSIFY', 'ASSIGN'].includes(action) && state !== 'RESOLVED')
  )
    return state;
  throw new RangeError('Illegal exception transition');
}
export const EVIDENCE_KINDS = [
  'PROCESSOR_ACTIVITY',
  'PROCESSOR_SETTLEMENT',
  'BANK_ENTRY',
  'RECONCILIATION_RUN',
  'MATCH_GROUP',
  'PROCESSOR_CONTROL',
  'BANK_CONTROL',
  'SOURCE_RECORD',
] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];
export interface EvidenceReference {
  readonly kind: EvidenceKind;
  readonly id: string;
}
export interface CaseCommand {
  readonly caseId: string;
  readonly commandKey: string;
  readonly expectedVersion: number;
  readonly actorId: string;
  readonly reason: string;
  readonly action: Action;
  readonly classification?: Classification;
  readonly assigneeId?: string | null;
  readonly resolution?: Resolution;
  /** Exact completed outcome for verified resolution or explicit reopening. */
  readonly evidenceRunId?: string;
  readonly note?: string;
  readonly attachment?: EvidenceReference;
}
function text(value: unknown, max = 512): void {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > max ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)
  )
    throw new TypeError('Invalid exception text');
}
export function serializeCommand(command: CaseCommand): string {
  for (const v of [command.caseId, command.commandKey, command.actorId])
    text(v);
  if (command.commandKey.startsWith('outcome:'))
    throw new TypeError('Reserved command namespace');
  text(command.reason, 4000);
  if (
    !Number.isSafeInteger(command.expectedVersion) ||
    command.expectedVersion < 1
  )
    throw new TypeError('Invalid case version');
  if (
    ![
      'SUPERSEDE',
      'START_REVIEW',
      'AWAIT_EVIDENCE',
      'RESUME_REVIEW',
      'RESOLVE',
      'REOPEN',
      'CLASSIFY',
      'ASSIGN',
      'NOTE',
      'ATTACH',
    ].includes(command.action)
  )
    throw new TypeError('Invalid action');
  if (
    (command.action === 'CLASSIFY') !==
      (command.classification !== undefined) ||
    (command.classification && !CLASSES.includes(command.classification))
  )
    throw new TypeError('Invalid classification');
  if ((command.action === 'ASSIGN') !== (command.assigneeId !== undefined))
    throw new TypeError('Invalid assignment');
  if (command.assigneeId !== undefined && command.assigneeId !== null)
    text(command.assigneeId);
  if (
    (command.action === 'RESOLVE') !== (command.resolution !== undefined) ||
    (command.resolution && !RESOLUTIONS.includes(command.resolution))
  )
    throw new TypeError('Invalid resolution');
  if ((command.action === 'NOTE') !== (command.note !== undefined))
    throw new TypeError('Invalid note');
  if (command.note !== undefined) text(command.note, 4000);
  if ((command.action === 'ATTACH') !== (command.attachment !== undefined))
    throw new TypeError('Invalid attachment');
  if (command.attachment) {
    if (!EVIDENCE_KINDS.includes(command.attachment.kind))
      throw new TypeError('Invalid evidence kind');
    text(command.attachment.id);
  }
  if (
    (command.action === 'REOPEN' ||
      command.action === 'SUPERSEDE' ||
      command.resolution === 'FIXED_AND_VERIFIED') !==
    (command.evidenceRunId !== undefined)
  )
    throw new TypeError('Resolution/reopening requires exact later outcome');
  return JSON.stringify(command);
}
export interface CaseView {
  readonly id: string;
  readonly mappingId: string;
  readonly itemId: string;
  readonly originalRunId: string;
  readonly evidenceRunId: string;
  readonly version: number;
  readonly state: State;
  readonly classification: Classification;
  readonly assigneeId: string | null;
  readonly resolution: Resolution | null;
  readonly currency: Currency;
  readonly side: 'PROCESSOR' | 'BANK';
  readonly exposure: MoneyJson | null;
  readonly exposureReason: string;
  readonly createdAt: string;
  readonly stateSince: string;
  readonly firstReviewAt: string | null;
  readonly resolvedAt: string | null;
  readonly currentlyReconciled: boolean;
}
/** Validate exact Money transport; no resolved state is used to establish reconciliation. */
export function exposureOf(view: CaseView): Money | null {
  return view.exposure === null ? null : Money.fromJSON(view.exposure);
}
export interface ExceptionSummary {
  readonly states: readonly { readonly state: State; readonly count: number }[];
  readonly classes: readonly {
    readonly classification: Classification;
    readonly count: number;
  }[];
  readonly exposure: readonly {
    readonly currency: Currency;
    readonly side: 'PROCESSOR' | 'BANK';
    readonly amountMinor: string;
    readonly acceptedRiskMinor: string;
    readonly unknownCount: number;
  }[];
  readonly createdTotal: number;
  readonly resolvedTotal: number;
  readonly reopenedTotal: number;
  readonly manualReconciliationTotal: 0;
  readonly oldestOpenAgeSeconds: string | null;
  readonly medianResolutionSeconds: string | null;
}
