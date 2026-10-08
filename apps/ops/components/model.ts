export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json };
export type Row = { [key: string]: Json };
export interface Model {
  version: string;
  asOf: string;
  data: Row | null;
  items: Row[] | null;
  nextCursor: string | null;
  checks?: Record<string, string>;
}
export function object(v: Json | undefined): Row {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? v : {};
}
export function rows(v: Json | undefined): Row[] {
  return Array.isArray(v)
    ? v.filter(
        (x): x is Row =>
          x !== null && typeof x === 'object' && !Array.isArray(x),
      )
    : [];
}
export function text(v: Json | undefined): string {
  return v === null || v === undefined
    ? 'UNKNOWN'
    : typeof v === 'object'
      ? JSON.stringify(v)
      : String(v);
}
