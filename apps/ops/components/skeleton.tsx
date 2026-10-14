import type { CSSProperties, ReactNode } from 'react';

/** Neutral decoration only: no counts, financial status, or implied results. */
export function Skeleton({
  width = '100%',
  shape = 'line',
}: {
  width?: CSSProperties['width'];
  shape?: 'line' | 'label' | 'value' | 'badge' | 'input';
}) {
  return (
    <span
      aria-hidden="true"
      className={`skeleton skeleton-${shape}`}
      style={{ width }}
    />
  );
}

function PanelSkeleton({ children }: { children: ReactNode }) {
  return (
    <section className="panel">
      <div className="panel-heading">
        <Skeleton width="min(240px, 65%)" />
      </div>
      {children}
    </section>
  );
}

function SummarySkeleton({ lines = 2 }: { lines?: number }) {
  return (
    <div className="skeleton-summary">
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} width={i % 2 ? '62%' : '84%'} />
      ))}
    </div>
  );
}

function FootnoteSkeleton() {
  return (
    <p className="footnote">
      <Skeleton width="95%" />
    </p>
  );
}

function MetricsSkeleton({ notes = false }: { notes?: boolean }) {
  // These labels describe the view, not its results. Keeping the real copy
  // preserves wrapping and card heights at every viewport width.
  const labels = notes
    ? [
        'Financial assurance · current sweep',
        'Structural integrity',
        'Open operational cases',
        'Terminal work',
      ]
    : ['PENDING', 'PROCESSING', 'RETRYABLE', 'FAILED TERMINAL'];
  const descriptions = [
    'Evidence strength, independent of worker success',
    'Current-state verification, not tamper-proof attestation',
    'Case count ≠ economic discrepancy count',
    'Retained for investigation',
  ];
  return (
    <div className="metric-grid">
      {labels.map((label, i) => (
        <div className="metric" key={label}>
          <span>{label}</span>
          <Skeleton width={i < 2 && notes ? 95 : 55} shape="value" />
          {notes && <small>{descriptions[i]}</small>}
        </div>
      ))}
    </div>
  );
}

function ChecksSkeleton() {
  return (
    <div className="check-grid">
      {Array.from({ length: 9 }, (_, i) => (
        <div key={i}>
          <Skeleton width={`${48 + (i % 3) * 7}%`} shape="label" />
          <Skeleton width={55} shape="badge" />
        </div>
      ))}
    </div>
  );
}

function TableSkeleton({
  columns = 6,
  tall = false,
}: {
  columns?: number;
  tall?: boolean;
}) {
  return (
    <div className="table-scroll">
      <table className={`skeleton-table${tall ? ' skeleton-table-tall' : ''}`}>
        <thead>
          <tr>
            {Array.from({ length: columns }, (_, i) => (
              <th key={i}>
                <Skeleton width={i === 0 ? 150 : 75} shape="label" />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: 3 }, (_, row) => (
            <tr key={row}>
              {Array.from({ length: columns }, (_, col) => (
                <td key={col}>
                  <Skeleton
                    width={col === 0 ? 210 : 75 + ((row + col) % 3) * 15}
                  />
                  {(col < 2 || col === columns - 1) && (
                    <Skeleton width={col === 0 ? 120 : 65} shape="label" />
                  )}
                  {tall && col === 0 && <Skeleton width={80} shape="badge" />}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DetailsSkeleton({ fields = 10 }: { fields?: number }) {
  return (
    <dl className="details">
      {Array.from({ length: fields }, (_, i) => (
        <div key={i}>
          <dt>
            <Skeleton width={95 + (i % 3) * 20} shape="label" />
          </dt>
          <dd>
            <Skeleton width={`${55 + (i % 3) * 15}%`} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

function FiltersSkeleton({ section }: { section: string }) {
  const widths =
    section === 'workers'
      ? [166, 230]
      : section === 'reconciliation'
        ? [139, 128, 230]
        : [170, 190, 128, ...(section === 'exceptions' ? [230] : [])];
  return (
    <div className="filters">
      {widths.map((width, i) => (
        <div className="skeleton-filter" key={i}>
          <Skeleton width={60 + i * 10} shape="label" />
          <Skeleton width={width} shape="input" />
        </div>
      ))}
      <Skeleton width={113} shape="input" />
      <Skeleton width={30} />
    </div>
  );
}

function DetailSkeleton({ section }: { section: string }) {
  return (
    <>
      <p>
        <Skeleton width={150} />
      </p>
      <PanelSkeleton>
        {section === 'exceptions' && (
          <div className="two-column">
            {[0, 1].map((i) => (
              <SummarySkeleton key={i} lines={3} />
            ))}
          </div>
        )}
        <DetailsSkeleton
          fields={
            section === 'exceptions' ? 7 : section === 'controls' ? 13 : 10
          }
        />
      </PanelSkeleton>
      {section !== 'controls' && (
        <PanelSkeleton>
          {section === 'workers' ? (
            <TableSkeleton columns={4} />
          ) : section === 'exceptions' ? (
            <ol className="timeline">
              {[0, 1, 2].map((i) => (
                <li key={i}>
                  <SummarySkeleton lines={4} />
                </li>
              ))}
            </ol>
          ) : (
            <article className="evidence-item">
              <SummarySkeleton lines={3} />
              <DetailsSkeleton fields={12} />
            </article>
          )}
        </PanelSkeleton>
      )}
    </>
  );
}

export function PageSkeleton({
  section,
  detail = false,
  book = true,
  evaluation = false,
}: {
  section: string;
  detail?: boolean;
  book?: boolean;
  evaluation?: boolean;
}) {
  const choices =
    section === 'overview' ||
    section === 'integrity' ||
    (section === 'controls' && !evaluation);
  return (
    <div
      className="page-skeleton"
      aria-busy="true"
      aria-label="Loading operational evidence"
    >
      <span className="sr-only" role="status">
        Loading operational evidence. Assurance is not established by loading.
      </span>
      <div aria-hidden="true">
        {!book ? (
          <>
            <div className="page-heading">
              <div className="skeleton-book-heading">
                <Skeleton width={130} shape="label" />
                <Skeleton width="85%" shape="value" />
                <Skeleton width="95%" />
              </div>
            </div>
            <PanelSkeleton>
              <ul className="book-list">
                {[0, 1, 2].map((i) => (
                  <li key={i}>
                    <Skeleton width={160} />
                    <Skeleton width={240} />
                    <Skeleton width={70} />
                  </li>
                ))}
              </ul>
            </PanelSkeleton>
          </>
        ) : (
          <>
            <div className="scope-strip">
              <Skeleton width={260} shape="label" />
              <Skeleton width={240} shape="label" />
              <Skeleton width={70} shape="label" />
            </div>
            {!detail &&
              ['reconciliation', 'exceptions', 'controls', 'workers'].includes(
                section,
              ) && <FiltersSkeleton section={section} />}
            {detail ? (
              <DetailSkeleton section={section} />
            ) : section === 'overview' ? (
              <>
                <MetricsSkeleton notes />
                <PanelSkeleton>
                  <ChecksSkeleton />
                  <FootnoteSkeleton />
                </PanelSkeleton>
                <PanelSkeleton>
                  {evaluation ? (
                    <>
                      <SummarySkeleton />
                      <TableSkeleton columns={7} />
                    </>
                  ) : (
                    <SummarySkeleton />
                  )}
                </PanelSkeleton>
                <PanelSkeleton>
                  <SummarySkeleton />
                </PanelSkeleton>
              </>
            ) : section === 'integrity' ? (
              <>
                <div className="skeleton-notice">
                  <SummarySkeleton />
                </div>
                <PanelSkeleton>
                  <SummarySkeleton />
                  <ChecksSkeleton />
                  <FootnoteSkeleton />
                </PanelSkeleton>
                <PanelSkeleton>
                  <SummarySkeleton />
                </PanelSkeleton>
              </>
            ) : (
              <>
                {section === 'workers' && <MetricsSkeleton />}
                <PanelSkeleton>
                  {(section === 'controls' || section === 'workers') && (
                    <SummarySkeleton />
                  )}
                  <TableSkeleton tall={section === 'reconciliation'} />
                  {section !== 'exceptions' && <FootnoteSkeleton />}
                </PanelSkeleton>
              </>
            )}
            {choices && (
              <PanelSkeleton>
                <TableSkeleton columns={5} />
              </PanelSkeleton>
            )}
          </>
        )}
      </div>
    </div>
  );
}
