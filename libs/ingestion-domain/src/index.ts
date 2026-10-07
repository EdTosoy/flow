import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { Money, type MoneyJson } from '@flow/money';
import {
  normalizeBank,
  type BankEntryObservation,
  type BankStatementObservation,
} from './bank';
export type { BankEntryObservation, BankStatementObservation } from './bank';

export const NORMALIZER_VERSIONS = [
  'synthetic-movement-v1',
  'synthetic-movement-v2',
  'synthetic-settlement-v1',
  'synthetic-settlement-group-v1',
  'synthetic-bank-entry-v1',
  'synthetic-bank-statement-v1',
] as const;
export type NormalizerVersion = (typeof NORMALIZER_VERSIONS)[number];
export interface RawInput {
  readonly locator: string;
  readonly objectKind: string;
  readonly externalId: string | null;
  /** Opaque upstream token. Never assumed to be an ordered number. */
  readonly sourceRevision: string | null;
  readonly bytes: Uint8Array;
  readonly sequence: number | null;
  readonly sourceObservedAt: string | null;
}
export interface BatchCommand {
  readonly sourceAccountId: string;
  readonly batchKey: string;
  readonly actorId: string;
  readonly provenance: Readonly<Record<string, unknown>>;
  readonly records: readonly RawInput[];
  readonly artifactBytes?: Uint8Array;
  readonly window?: { readonly from: string; readonly to: string };
  /** Independent source assertion, never a count computed from received records. */
  readonly expectedCount?: number;
  readonly expectedSequence?: { readonly from: number; readonly to: number };
  readonly manifestBytes?: Uint8Array;
}
export interface Observation {
  readonly type: 'movement';
  readonly subtype: 'capture' | 'fee' | 'refund' | 'chargeback';
  readonly externalId: string;
  readonly amount: MoneyJson;
  readonly occurredAt: string;
  readonly direction: 'inflow' | 'outflow' | 'zero';
  readonly reference: string;
  readonly parentReference: string | null;
}
export interface SettlementObservation {
  readonly type: 'settlement';
  readonly externalId: string;
  readonly amount: MoneyJson;
  readonly occurredAt: string;
  readonly direction: 'inflow' | 'outflow' | 'zero';
  readonly transferReference: string;
  readonly componentKind: 'synthetic-movement';
  readonly componentIds: readonly string[];
  /** Supplemental complete transfer declaration; only settlement-group-v1 supplies it. */
  readonly payoutMemberIds?: readonly string[] | null;
}
export type NormalizationResult =
  | {
      readonly state: 'NORMALIZED';
      readonly observation:
        | Observation
        | SettlementObservation
        | BankEntryObservation
        | BankStatementObservation;
    }
  | {
      readonly state: 'FAILED';
      readonly code:
        | 'INVALID_ENCODING'
        | 'INVALID_JSON'
        | 'MISSING_IDENTITY'
        | 'INVALID_STRUCTURE'
        | 'INVALID_MONEY'
        | 'INVALID_TIMESTAMP'
        | 'IDENTITY_MISMATCH'
        | 'UNSUPPORTED_KIND';
    };
export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
/** Sorted own keys, array order retained; only plain, exact JSON values. No floats. */
export function canonicalJson(value: unknown): string {
  function visit(v: unknown): unknown {
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
    if (typeof v === 'number' && Number.isSafeInteger(v)) return v;
    if (Array.isArray(v)) return Array.from(v, visit);
    if (
      typeof v === 'object' &&
      v !== null &&
      Object.getPrototypeOf(v) === Object.prototype
    ) {
      return Object.fromEntries(
        Object.keys(v)
          .sort()
          .map((k) => [k, visit((v as Record<string, unknown>)[k])]),
      );
    }
    throw new TypeError('Canonical JSON requires plain exact JSON values');
  }
  return JSON.stringify(visit(value));
}
export function utcTime(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    value.startsWith('0000-') ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    throw new TypeError('Canonical UTC milliseconds required');
  return value;
}
export function boundedText(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 512 ||
    value.includes('\0') ||
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
      value,
    )
  )
    throw new TypeError('Nonempty bounded text required');
}
export function normalizerVersion(value: string): NormalizerVersion {
  if (!NORMALIZER_VERSIONS.includes(value as NormalizerVersion))
    throw new TypeError('Unsupported normalizer version');
  return value as NormalizerVersion;
}
/** Pure interpretation of synthetic movement JSON; no accounting or oracle knowledge. */
export function normalize(
  bytes: Uint8Array,
  externalId: string | null,
  version:
    | 'synthetic-movement-v1'
    | 'synthetic-movement-v2'
    | 'synthetic-settlement-v1',
):
  | Exclude<NormalizationResult, { readonly state: 'NORMALIZED' }>
  | {
      readonly state: 'NORMALIZED';
      readonly observation: Observation | SettlementObservation;
    };
export function normalize(
  bytes: Uint8Array,
  externalId: string | null,
  version: NormalizerVersion,
): NormalizationResult;
export function normalize(
  bytes: Uint8Array,
  externalId: string | null,
  version: NormalizerVersion,
): NormalizationResult {
  normalizerVersion(version);
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    return { state: 'FAILED', code: 'INVALID_ENCODING' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return { state: 'FAILED', code: 'INVALID_JSON' };
  }
  if (
    version === 'synthetic-bank-entry-v1' ||
    version === 'synthetic-bank-statement-v1'
  )
    return normalizeBank(parsed, externalId, version);
  if (version === 'synthetic-settlement-group-v1') {
    const base = normalize(bytes, externalId, 'synthetic-settlement-v1');
    if (base.state !== 'NORMALIZED' || base.observation.type !== 'settlement')
      return base;
    try {
      const members = (parsed as Record<string, unknown>)['payoutMemberIds'];
      if (members === undefined)
        return {
          state: 'NORMALIZED',
          observation: { ...base.observation, payoutMemberIds: null },
        };
      if (
        !Array.isArray(members) ||
        members.length < 2 ||
        members.length > 10000
      )
        throw new TypeError('Explicit complete transfer members required');
      members.forEach(boundedText);
      return {
        state: 'NORMALIZED',
        observation: { ...base.observation, payoutMemberIds: members },
      };
    } catch {
      return { state: 'FAILED', code: 'INVALID_STRUCTURE' };
    }
  }
  if (!externalId) return { state: 'FAILED', code: 'MISSING_IDENTITY' };
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
    return { state: 'FAILED', code: 'INVALID_STRUCTURE' };
  const r = parsed as Record<string, unknown>;
  if (typeof r['id'] !== 'string' || !r['id'])
    return { state: 'FAILED', code: 'MISSING_IDENTITY' };
  if (r['id'] !== externalId)
    return { state: 'FAILED', code: 'IDENTITY_MISMATCH' };
  if (version === 'synthetic-settlement-v1') {
    try {
      boundedText(r['transferReference']);
      if (!Array.isArray(r['componentIds']) || r['componentIds'].length > 10000)
        throw new TypeError('Bounded itemized membership required');
      r['componentIds'].forEach(boundedText);
    } catch {
      return { state: 'FAILED', code: 'INVALID_STRUCTURE' };
    }
    let money: Money;
    try {
      money = Money.fromJSON(r['net']);
      // Preserve all explicit report totals in raw evidence; do not infer fee facts from them.
      for (const k of ['gross', 'fees', 'refunds', 'chargebacks'])
        if (Money.fromJSON(r[k]).currency !== money.currency)
          throw new TypeError('Mixed report currency');
    } catch {
      return { state: 'FAILED', code: 'INVALID_MONEY' };
    }
    let occurredAt: string;
    try {
      occurredAt = utcTime(r['reportedAt']);
    } catch {
      return { state: 'FAILED', code: 'INVALID_TIMESTAMP' };
    }
    return {
      state: 'NORMALIZED',
      observation: {
        type: 'settlement',
        externalId,
        amount: money.toJSON(),
        occurredAt,
        direction:
          money.amountMinor > 0n
            ? 'inflow'
            : money.amountMinor < 0n
              ? 'outflow'
              : 'zero',
        transferReference: r['transferReference'] as string,
        componentKind: 'synthetic-movement',
        componentIds: r['componentIds'] as string[],
      },
    };
  }
  if (!['capture', 'fee', 'refund', 'chargeback'].includes(r['kind'] as string))
    return { state: 'FAILED', code: 'UNSUPPORTED_KIND' };
  try {
    boundedText(r['paymentReference']);
    if (r['parentCaptureId'] !== null) boundedText(r['parentCaptureId']);
  } catch {
    return { state: 'FAILED', code: 'INVALID_STRUCTURE' };
  }
  let money: Money;
  try {
    money = Money.fromJSON(r['amount']);
  } catch {
    return { state: 'FAILED', code: 'INVALID_MONEY' };
  }
  let occurredAt: string;
  try {
    // v2 additionally accepts UTC seconds, with explicit zero milliseconds. v1 is retained.
    const time =
      version === 'synthetic-movement-v2' &&
      typeof r['occurredAt'] === 'string' &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(r['occurredAt'])
        ? r['occurredAt'].replace('Z', '.000Z')
        : r['occurredAt'];
    occurredAt = utcTime(time);
  } catch {
    return { state: 'FAILED', code: 'INVALID_TIMESTAMP' };
  }
  return {
    state: 'NORMALIZED',
    observation: {
      type: 'movement',
      subtype: r['kind'] as Observation['subtype'],
      externalId,
      amount: money.toJSON(),
      occurredAt,
      direction:
        money.amountMinor > 0n
          ? 'inflow'
          : money.amountMinor < 0n
            ? 'outflow'
            : 'zero',
      reference: r['paymentReference'] as string,
      parentReference: r['parentCaptureId'] as string | null,
    },
  };
}

/** Snapshot mutable caller buffers before acquiring a connection or retrying. */
export function batchPayload(command: BatchCommand): string {
  boundedText(command.sourceAccountId);
  boundedText(command.batchKey);
  boundedText(command.actorId);
  if (command.records.length > 10000)
    throw new RangeError('Phase 3 batch limit is 10,000 receipts');
  const count = (n: number): number => {
    if (!Number.isSafeInteger(n) || n < 0 || n > 2147483647)
      throw new RangeError('Invalid source count/sequence');
    return n;
  };
  const bytes = (b: Uint8Array): string => {
    if (b.byteLength > 16 * 1024 * 1024)
      throw new RangeError('Phase 3 payload limit is 16 MiB');
    return Buffer.from(b).toString('hex');
  };
  const locators = new Set<string>();
  const records = command.records.map((r) => {
    boundedText(r.locator);
    boundedText(r.objectKind);
    if (r.externalId !== null) boundedText(r.externalId);
    if (r.sourceRevision !== null) boundedText(r.sourceRevision);
    if (locators.has(r.locator))
      throw new TypeError('Duplicate physical locator');
    locators.add(r.locator);
    return {
      locator: r.locator,
      objectKind: r.objectKind,
      externalId: r.externalId,
      sourceRevision: r.sourceRevision,
      bytesHex: bytes(r.bytes),
      sequence: r.sequence === null ? null : count(r.sequence),
      sourceObservedAt:
        r.sourceObservedAt === null ? null : utcTime(r.sourceObservedAt),
    };
  });
  const seq = command.expectedSequence;
  if (seq && count(seq.from) > count(seq.to))
    throw new TypeError('Invalid sequence range');
  if (
    command.window &&
    utcTime(command.window.from) > utcTime(command.window.to)
  )
    throw new TypeError('Invalid source window');
  return canonicalJson({
    sourceAccountId: command.sourceAccountId,
    batchKey: command.batchKey,
    actorId: command.actorId,
    provenance: command.provenance,
    records,
    artifactHex: command.artifactBytes ? bytes(command.artifactBytes) : null,
    window: command.window ?? null,
    expectedCount:
      command.expectedCount === undefined ? null : count(command.expectedCount),
    expectedSequence: seq ?? null,
    manifestHex: command.manifestBytes ? bytes(command.manifestBytes) : null,
  });
}
