import Link from 'next/link';
import { type ReactNode } from 'react';
import { timestamp } from './format';
export function url(
  section: string,
  book: string | null,
  evaluation?: string,
  id?: string,
  extra: Record<string, string | undefined> = {},
) {
  const q = new URLSearchParams();
  if (book) q.set('book', book);
  if (evaluation) q.set('evaluation', evaluation);
  for (const [k, v] of Object.entries(extra)) if (v) q.set(k, v);
  return `${section === 'overview' ? '/' : '/' + section}${id ? '/' + encodeURIComponent(id) : ''}${q.size ? '?' + q.toString() : ''}`;
}
export function Status({ value }: { value: string }) {
  const tone =
    value === 'PASS'
      ? 'pass'
      : value === 'FAIL'
        ? 'fail'
        : value === 'UNKNOWN'
          ? 'unknown'
          : 'neutral';
  return (
    <span className={`status ${tone}`}>
      <span aria-hidden="true">
        {tone === 'pass'
          ? '✓'
          : tone === 'fail'
            ? '!'
            : tone === 'unknown'
              ? '?'
              : '•'}
      </span>{' '}
      {value.replaceAll('_', ' ')}
    </span>
  );
}
export function Panel({
  title,
  children,
  aside,
}: {
  title: string;
  children: ReactNode;
  aside?: ReactNode | undefined;
}) {
  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}
export function Time({ value }: { value: unknown }) {
  return <span className="time">{timestamp(value)}</span>;
}
export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}
export function Notice({
  kind = 'unknown',
  children,
}: {
  kind?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={`notice ${kind}`}
      role={kind === 'fail' ? 'alert' : undefined}
    >
      {children}
    </div>
  );
}
export function Table({
  headers,
  children,
}: {
  headers: string[];
  children: ReactNode;
}) {
  return (
    <div className="table-scroll" tabIndex={0} aria-label="Scrollable results">
      <table>
        <thead>
          <tr>
            {headers.map((h) => (
              <th key={h} scope="col">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
export function Id({ value, href }: { value: string; href?: string }) {
  return href ? (
    <Link className="identifier" href={href} prefetch={false}>
      {value}
    </Link>
  ) : (
    <span className="identifier">{value}</span>
  );
}
