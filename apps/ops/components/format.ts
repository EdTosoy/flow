import { CURRENCIES, type Currency } from '@flow/money';
/** Aggregate minor-unit strings may exceed BIGINT; formatting never passes through Number. */
export function money(value: unknown, code: unknown): string {
  if (value === null || value === undefined) return 'UNKNOWN';
  if (
    typeof value !== 'string' ||
    !/^(-?[0-9]+)$/.test(value) ||
    typeof code !== 'string' ||
    !Object.hasOwn(CURRENCIES, code)
  )
    return 'UNKNOWN';
  const scale = CURRENCIES[code as Currency].minorUnitScale;
  const negative = value.startsWith('-');
  const raw = (negative ? value.slice(1) : value).padStart(scale + 1, '0');
  const whole = (scale ? raw.slice(0, -scale) : raw).replace(
    /\B(?=(\d{3})+(?!\d))/g,
    ',',
  );
  return `${code} ${negative ? '-' : ''}${whole}${scale ? '.' + raw.slice(-scale) : ''}`;
}
export function percentage(numerator: string, denominator: string): string {
  if (!/^\d+$/.test(numerator) || !/^\d+$/.test(denominator)) return 'UNKNOWN';
  const d = BigInt(denominator),
    n = BigInt(numerator);
  if (d === 0n) return 'Not evaluated';
  if (n > d) return 'UNKNOWN';
  const tenths = (n * 1000n) / d;
  return `${tenths / 10n}.${tenths % 10n}%`;
}
export function timestamp(value: unknown): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))
    return 'Not recorded';
  return new Date(value).toISOString().replace('T', ' ').replace('Z', ' UTC');
}
export function age(value: unknown, asOf: string): string {
  if (typeof value !== 'string') return 'Not recorded';
  const elapsed = Date.parse(asOf) - Date.parse(value);
  if (!Number.isFinite(elapsed) || elapsed < 0) return 'UNKNOWN';
  const minutes = Math.floor(elapsed / 60000);
  return minutes < 60
    ? `${minutes}m`
    : minutes < 1440
      ? `${Math.floor(minutes / 60)}h`
      : `${Math.floor(minutes / 1440)}d`;
}
