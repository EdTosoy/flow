import { Money, currency, type Currency, type MoneyJson } from '@flow/money';
import { boundedText, utcTime, type NormalizationResult } from './index';

export interface BankEntryObservation {
  readonly type: 'bank-entry';
  readonly externalId: string | null;
  /** Signed source flow, retained exactly. Bank domain exposes direction plus magnitude. */
  readonly amount: MoneyJson;
  readonly occurredAt: string;
  readonly direction: 'inflow' | 'outflow';
  readonly sourceOccurredAt: string | null;
  readonly valueDate: string | null;
  readonly bankReference: string | null;
  readonly statementReference: string | null;
  readonly lineIdentity: string | null;
  readonly sequence: number | null;
  readonly runningBalance: MoneyJson | null;
}
export interface BankStatementObservation {
  readonly type: 'bank-statement';
  readonly externalId: string;
  /** Common monetary projection is the supplied closing stock, never a flow. */
  readonly amount: MoneyJson | null;
  readonly currency: Currency;
  readonly occurredAt: string;
  readonly direction: null;
  readonly period: { readonly from: string; readonly to: string } | null;
  readonly opening: MoneyJson | null;
  readonly closing: MoneyJson | null;
  readonly expectedLineCount: number | null;
  readonly lineIds: readonly string[] | null;
  readonly sequenceRange: { readonly from: number; readonly to: number } | null;
}
function text(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  boundedText(value);
  return value;
}
function count(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 2147483647
  )
    throw new TypeError('Exact nonnegative source count required');
  return value;
}
function balance(value: unknown, code: Currency): MoneyJson | null {
  if (value === undefined || value === null) return null;
  const m = Money.fromJSON(value);
  if (m.currency !== code) throw new TypeError('Balance currency mismatch');
  return m.toJSON();
}
export function normalizeBank(
  parsed: unknown,
  externalId: string | null,
  version: string,
): NormalizationResult {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    return { state: 'FAILED', code: 'INVALID_STRUCTURE' };
  const r = parsed as Record<string, unknown>;
  try {
    if (text(r['id']) !== externalId)
      return { state: 'FAILED', code: 'IDENTITY_MISMATCH' };
  } catch {
    return { state: 'FAILED', code: 'INVALID_STRUCTURE' };
  }
  if (version === 'synthetic-bank-entry-v1') {
    let amount: Money, runningBalance: MoneyJson | null;
    try {
      amount = Money.fromJSON(r['amount']);
      if (amount.amountMinor === 0n)
        throw new TypeError('Zero is not a movement');
      // Both signs must have a representable positive Money magnitude.
      Money.of(
        amount.amountMinor < 0n ? -amount.amountMinor : amount.amountMinor,
        amount.currency,
      );
      runningBalance = balance(r['runningBalance'], amount.currency);
      if (
        r['direction'] !== undefined &&
        r['direction'] !== (amount.amountMinor > 0n ? 'CREDIT' : 'DEBIT')
      )
        throw new TypeError('Contradictory direction');
    } catch {
      return { state: 'FAILED', code: 'INVALID_MONEY' };
    }
    let occurredAt: string,
      sourceOccurredAt: string | null,
      valueDate: string | null;
    try {
      occurredAt = utcTime(r['bookedAt']);
      sourceOccurredAt =
        r['sourceOccurredAt'] == null ? null : utcTime(r['sourceOccurredAt']);
      valueDate = r['valueDate'] == null ? null : text(r['valueDate']);
      if (valueDate !== null) utcTime(valueDate + 'T00:00:00.000Z');
    } catch {
      return { state: 'FAILED', code: 'INVALID_TIMESTAMP' };
    }
    try {
      if (r['status'] !== 'booked')
        throw new TypeError('Only booked synthetic claims supported');
      const statementReference = text(r['statementReference']),
        lineIdentity = text(r['lineIdentity']),
        sequence = count(r['sequence']);
      if (
        statementReference === null &&
        (lineIdentity !== null || sequence !== null)
      )
        throw new TypeError('Statement context required for line identifiers');
      return {
        state: 'NORMALIZED',
        observation: {
          type: 'bank-entry',
          externalId,
          amount: amount.toJSON(),
          occurredAt,
          direction: amount.amountMinor > 0n ? 'inflow' : 'outflow',
          sourceOccurredAt,
          valueDate,
          bankReference: text(r['bankReference'] ?? r['transferReference']),
          statementReference,
          lineIdentity,
          sequence,
          runningBalance,
        },
      };
    } catch {
      return { state: 'FAILED', code: 'INVALID_STRUCTURE' };
    }
  }
  if (externalId === null) return { state: 'FAILED', code: 'MISSING_IDENTITY' };
  let code: Currency, opening: MoneyJson | null, closing: MoneyJson | null;
  try {
    code = currency(r['currency']);
    opening = balance(r['opening'], code);
    closing = balance(r['closing'], code);
  } catch {
    return { state: 'FAILED', code: 'INVALID_MONEY' };
  }
  let occurredAt: string, period: BankStatementObservation['period'];
  try {
    occurredAt = utcTime(r['reportedAt']);
    const p = r['period'] as Record<string, unknown> | null | undefined;
    period =
      p == null ? null : { from: utcTime(p['from']), to: utcTime(p['to']) };
    // Retain provably reversed periods for the bank control, rather than repairing them.
  } catch {
    return { state: 'FAILED', code: 'INVALID_TIMESTAMP' };
  }
  try {
    const lineIds = r['lineIds'] == null ? null : r['lineIds'];
    if (lineIds !== null) {
      if (!Array.isArray(lineIds) || lineIds.length > 10000)
        throw new TypeError('Bounded source lines required');
      lineIds.forEach(boundedText);
    }
    const seq = r['sequenceRange'] as
      Record<string, unknown> | null | undefined;
    const from = seq == null ? null : count(seq['from']),
      to = seq == null ? null : count(seq['to']);
    if (seq != null && (from === null || to === null))
      throw new TypeError('Both sequence endpoints required');
    return {
      state: 'NORMALIZED',
      observation: {
        type: 'bank-statement',
        externalId,
        amount: closing,
        currency: code,
        occurredAt,
        direction: null,
        period,
        opening,
        closing,
        expectedLineCount: count(r['expectedLineCount']),
        lineIds: lineIds as string[] | null,
        sequenceRange: seq == null ? null : { from: from!, to: to! },
      },
    };
  } catch {
    return { state: 'FAILED', code: 'INVALID_STRUCTURE' };
  }
}
