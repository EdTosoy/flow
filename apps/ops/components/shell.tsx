import Link from 'next/link';
import type { ReactNode } from 'react';
import { url } from './common';
const sections = [
  'overview',
  'reconciliation',
  'exceptions',
  'controls',
  'workers',
  'integrity',
];
export function Shell({
  section,
  book,
  evaluation,
  children,
}: {
  section: string;
  book: string | null;
  evaluation?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Link className="brand" href={url('overview', book, evaluation)}>
          <span className="brand-mark">f</span>flow
          <span className="brand-sub">OPERATIONS</span>
        </Link>
        <div className="nav-label">INVESTIGATION</div>
        <nav aria-label="Primary">
          {sections.map((s, i) => (
            <Link
              prefetch={false}
              href={url(s, book, evaluation)}
              key={s}
              aria-current={s === section ? 'page' : undefined}
            >
              <span className="nav-index">0{i + 1}</span>
              {s[0]!.toUpperCase() + s.slice(1)}
            </Link>
          ))}
        </nav>
        <div className="sidebar-footer">
          <span className="local-dot" /> Local / internal
          <br />
          <small>
            Read-only operations
            <br />
            No financial actions
          </small>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <span>
            FINANCIAL RECONCILIATION <span className="divider">/</span>{' '}
            {section.toUpperCase()}
          </span>
          <span className="readonly">READ ONLY</span>
        </header>
        <main id="main" tabIndex={-1}>
          {children}
        </main>
        <footer>
          PostgreSQL is authoritative. Case closure and worker success do not
          establish financial reconciliation.
        </footer>
      </div>
    </div>
  );
}
