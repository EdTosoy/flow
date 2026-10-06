export const MIN_MINOR_UNITS = -9223372036854775808n;
export const MAX_MINOR_UNITS = 9223372036854775807n;

export const CURRENCIES = Object.freeze({
  PHP: Object.freeze({ minorUnitScale: 2, metadataVersion: 1 }),
  USD: Object.freeze({ minorUnitScale: 2, metadataVersion: 1 }),
});
export type Currency = keyof typeof CURRENCIES;
export interface MoneyJson {
  readonly amountMinor: string;
  readonly currency: Currency;
}

export function currency(value: unknown): Currency {
  if (typeof value !== 'string' || !Object.hasOwn(CURRENCIES, value)) {
    throw new TypeError('Unsupported currency');
  }
  return value as Currency;
}

/** Exact signed BIGINT amount; ledger entry magnitude and direction are separate. */
export class Money {
  private constructor(
    readonly amountMinor: bigint,
    readonly currency: Currency,
  ) {
    Object.freeze(this);
  }

  static of(amountMinor: bigint, code: Currency): Money {
    if (typeof amountMinor !== 'bigint')
      throw new TypeError('Amount must be bigint');
    if (amountMinor < MIN_MINOR_UNITS || amountMinor > MAX_MINOR_UNITS) {
      throw new RangeError('Amount outside PostgreSQL signed BIGINT range');
    }
    return new Money(amountMinor, currency(code));
  }

  static parse(amountMinor: string, code: Currency): Money {
    if (
      typeof amountMinor !== 'string' ||
      amountMinor.length > 20 ||
      !/^(0|[1-9][0-9]*|-[1-9][0-9]*)$/.test(amountMinor)
    ) {
      throw new TypeError('Amount must be a canonical base-10 integer string');
    }
    return Money.of(BigInt(amountMinor), code);
  }

  static fromJSON(value: unknown): Money {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError('Invalid Money JSON');
    }
    const record = value as Record<string, unknown>;
    if (
      Object.keys(record).sort().join(',') !== 'amountMinor,currency' ||
      typeof record['amountMinor'] !== 'string'
    ) {
      throw new TypeError('Invalid Money JSON');
    }
    return Money.parse(record['amountMinor'], currency(record['currency']));
  }

  equals(other: Money): boolean {
    return (
      this.currency === other.currency && this.amountMinor === other.amountMinor
    );
  }

  add(other: Money): Money {
    this.assertCurrency(other);
    return Money.of(this.amountMinor + other.amountMinor, this.currency);
  }

  subtract(other: Money): Money {
    this.assertCurrency(other);
    return Money.of(this.amountMinor - other.amountMinor, this.currency);
  }

  toJSON(): MoneyJson {
    return {
      amountMinor: this.amountMinor.toString(),
      currency: this.currency,
    };
  }

  private assertCurrency(other: Money): void {
    if (this.currency !== other.currency)
      throw new TypeError('Currencies differ');
  }
}
