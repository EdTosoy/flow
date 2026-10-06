import { Money, currency, type Currency } from '@flow/money';

export type EntrySide = 'debit' | 'credit';
export type AccountClassification =
  'asset' | 'liability' | 'equity' | 'income' | 'expense';

export interface CommandIdentity {
  readonly bookId: string;
  readonly commandKey: string;
  readonly actorId: string;
  readonly reason: string;
}
export interface CreateAccountCommand extends CommandIdentity {
  readonly code: string;
  readonly currency: Currency;
  readonly classification: AccountClassification;
  readonly normalSide: EntrySide;
}
export interface JournalEntryInput {
  readonly accountId: string;
  readonly side: EntrySide;
  readonly money: Money;
}
export interface PostJournalCommand extends CommandIdentity {
  readonly effectNamespace: string;
  readonly businessEffectKey: string;
  readonly currency: Currency;
  readonly effectiveAt: string;
  readonly policyVersion: string;
  readonly entries: readonly JournalEntryInput[];
}
export interface ReverseJournalCommand extends CommandIdentity {
  readonly originalJournalId: string;
  readonly effectiveAt: string;
  readonly policyVersion: string;
}
export interface CommandResult {
  readonly id: string;
  readonly replayed: boolean;
}
export interface PostedJournal {
  readonly id: string;
  readonly bookId: string;
  readonly currency: Currency;
  readonly state: 'posted';
  readonly reversalOf: string | null;
  readonly entries: readonly JournalEntryInput[];
}

export function validateIdentity(command: CommandIdentity): void {
  uuid(command.bookId);
  for (const value of [command.commandKey, command.actorId, command.reason]) {
    text(value);
  }
}
export function uuid(value: string): void {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    throw new TypeError('Expected UUID');
  }
}
export function text(value: string): void {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 512 ||
    value.trim() !== value ||
    value.includes('\0')
  ) {
    throw new TypeError(
      'Expected nonempty bounded text without outer whitespace',
    );
  }
}
export function effectiveTime(value: string): void {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    new Date(value).toISOString() !== value
  ) {
    throw new TypeError(
      'Expected canonical UTC timestamp with millisecond precision',
    );
  }
}
export function validatePost(command: PostJournalCommand): void {
  validateIdentity(command);
  currency(command.currency);
  text(command.effectNamespace);
  if (/^ledger(?:\.|$)/.test(command.effectNamespace))
    throw new TypeError('Reserved effect namespace');
  text(command.businessEffectKey);
  text(command.policyVersion);
  effectiveTime(command.effectiveAt);
  if (
    !Array.isArray(command.entries) ||
    command.entries.length < 2 ||
    command.entries.length > 1000
  ) {
    throw new RangeError('Journal requires 2–1000 entries');
  }
  let debits = 0n;
  let credits = 0n;
  for (const entry of command.entries) {
    uuid(entry.accountId);
    if (
      !(entry.money instanceof Money) ||
      entry.money.currency !== command.currency ||
      entry.money.amountMinor <= 0n
    ) {
      throw new TypeError('Entry requires positive Money in journal currency');
    }
    if (entry.side === 'debit') debits += entry.money.amountMinor;
    else if (entry.side === 'credit') credits += entry.money.amountMinor;
    else throw new TypeError('Invalid entry side');
  }
  if (debits !== credits) throw new RangeError('Journal does not balance');
}

/** Port for privileged commands; callers supply semantic identity, never editable rows. */
export interface LedgerCommands {
  createAccount(command: CreateAccountCommand): Promise<CommandResult>;
  post(command: PostJournalCommand): Promise<CommandResult>;
  reverse(command: ReverseJournalCommand): Promise<CommandResult>;
}
export interface LedgerReads {
  journal(id: string): Promise<PostedJournal | null>;
  accountDelta(accountId: string): Promise<bigint>;
}
