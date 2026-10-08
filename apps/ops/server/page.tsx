import 'server-only';
import Link from 'next/link';
import { read, scope, type Search } from './read';
import {
  InvalidRead,
  ReadUnavailable,
  classifications,
  controlTypes,
  type Operation,
} from '@flow/operations-read-postgres';
import { Shell } from '../components/shell';
import { Panel, Notice, Empty, Time, Id, url } from '../components/common';
import { Filters } from '../components/filters';
import * as Views from '../components/views';
const titles: Record<string, [string, string]> = {
  overview: [
    'Financial operations',
    'Financial assurance, unexplained exposure and processing health.',
  ],
  reconciliation: [
    'Reconciliation',
    'Frozen outcomes and current allocation proof.',
  ],
  exceptions: [
    'Exceptions',
    'Human attention around unresolved financial evidence.',
  ],
  controls: [
    'Control center',
    'Independent completeness and financial total assertions.',
  ],
  workers: [
    'Worker operations',
    'Durable intent, processing lag and retained failures.',
  ],
  integrity: [
    'System integrity',
    'Independent current-state verification across financial domains.',
  ],
};
const operations: Record<string, Operation> = {
  overview: 'overview',
  reconciliation: 'reconciliation',
  exceptions: 'exceptions',
  controls: 'controls',
  workers: 'workers',
  integrity: 'integrity',
};
const detailOps: Record<string, Operation> = {
  reconciliation: 'run',
  exceptions: 'case',
  controls: 'control',
  workers: 'work',
};
const states: Record<string, string[]> = {
  reconciliation: ['DRAFT', 'SEALED', 'RUNNING', 'COMPLETED'],
  exceptions: ['OPEN', 'UNDER_REVIEW', 'AWAITING_EVIDENCE', 'RESOLVED'],
  controls: ['FAIL', 'UNKNOWN', 'PASS'],
  workers: [
    'PENDING',
    'PROCESSING',
    'RETRYABLE',
    'FAILED_TERMINAL',
    'SUCCEEDED',
  ],
};
export async function OpsPage({
  section,
  search,
  id,
}: {
  section: string;
  search: Search;
  id?: string | undefined;
}) {
  let book: string | null = null,
    evaluation: string | undefined;
  try {
    if (!operations[section] || (id && !detailOps[section]))
      throw new InvalidRead();
    const selection = scope(search);
    book = selection.book;
    evaluation = selection.evaluation;
    const filters = { ...selection.filters };
    if (id && section !== 'controls') filters['id'] = id;
    const title = titles[section]!;
    if (!book) {
      const books = await read('books', null, { cursor: filters['cursor'] });
      return (
        <Shell section={section} book={null}>
          <div className="page-heading">
            <span className="eyebrow">INTERNAL OPERATIONS</span>
            <h1>Select a financial book</h1>
            <p>No population selected. Assurance: UNKNOWN.</p>
          </div>
          <Panel title="Available books">
            {books.items?.length ? (
              <ul className="book-list">
                {books.items.map((b) => (
                  <li key={String(b['id'])}>
                    <Link href={url(section, String(b['id']))}>
                      {String(b['code'])} →
                    </Link>
                    <Id value={String(b['id'])} />
                    <span>{String(b['environment'])}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty>
                No books exist yet. No financial population evaluated; assurance
                UNKNOWN.
              </Empty>
            )}
            {books.nextCursor && (
              <Link
                href={url(section, null, undefined, undefined, {
                  cursor: books.nextCursor,
                })}
              >
                Next books →
              </Link>
            )}
          </Panel>
        </Shell>
      );
    }
    const operation = id ? detailOps[section]! : operations[section]!;
    const model = await read(operation, book, filters);
    const ctx = { model, book, evaluation };
    let content;
    if (id) {
      content =
        section === 'exceptions' ? (
          <Views.Case {...ctx} />
        ) : section === 'reconciliation' ? (
          <Views.Run {...ctx} />
        ) : section === 'controls' ? (
          <Views.Control {...ctx} />
        ) : (
          <Views.Work {...ctx} />
        );
    } else
      content =
        section === 'overview' ? (
          <Views.Overview {...ctx} />
        ) : section === 'exceptions' ? (
          <Views.Exceptions {...ctx} />
        ) : section === 'reconciliation' ? (
          <Views.Reconciliation {...ctx} />
        ) : section === 'controls' ? (
          <Views.Controls {...ctx} />
        ) : section === 'workers' ? (
          <Views.Workers {...ctx} />
        ) : (
          <Views.Integrity {...ctx} />
        );
    const choices =
      section === 'overview' ||
      (section === 'controls' && !evaluation) ||
      section === 'integrity'
        ? await read('evaluations', book, {
            cursor: section === 'overview' ? filters['cursor'] : undefined,
          })
        : null;
    return (
      <Shell section={section} book={book} evaluation={evaluation}>
        <div className="page-heading">
          <div>
            <span className="eyebrow">
              {id
                ? 'EVIDENCE INVESTIGATION'
                : 'OPERATIONS / ' + section.toUpperCase()}
            </span>
            <h1>{title[0]}</h1>
            <p>{title[1]}</p>
          </div>
          <a
            className="button secondary"
            href={url(section, book, evaluation, id, filters)}
          >
            Refresh data ↻
          </a>
        </div>
        <div className="scope-strip">
          <span>
            Book <Id value={book} />
          </span>
          <span>
            Queried <Time value={model.asOf} />
          </span>
          <Link href="/">Change book</Link>
        </div>
        {!id && states[section] && (
          <Filters
            section={section}
            book={book}
            evaluation={evaluation}
            values={filters}
            states={states[section]}
            categories={
              section === 'controls'
                ? controlTypes
                : section === 'exceptions'
                  ? classifications
                  : []
            }
          />
        )}
        {id && (
          <p>
            <Link href={url(section, book, evaluation)}>
              ← Back to {section}
            </Link>
          </p>
        )}
        {content}
        {model.nextCursor && (
          <div className="pagination">
            <span>Bounded results · stable keyset order</span>
            <Link
              className="button"
              href={url(section, book, evaluation, id, {
                ...filters,
                cursor: model.nextCursor,
              })}
            >
              Next results →
            </Link>
          </div>
        )}
        {choices && (
          <>
            <Views.Evaluations model={choices} book={book} section={section} />
            {choices.nextCursor && section === 'overview' && (
              <Link
                href={url(section, book, evaluation, undefined, {
                  cursor: choices.nextCursor,
                })}
              >
                More evaluations →
              </Link>
            )}
          </>
        )}
      </Shell>
    );
  } catch (error) {
    const invalid = error instanceof InvalidRead;
    const missing =
      error instanceof ReadUnavailable && error.category === 'NOT_FOUND';
    return (
      <Shell
        section={titles[section] ? section : 'overview'}
        book={book}
        evaluation={evaluation}
      >
        <div className="page-heading">
          <h1>
            {invalid
              ? 'Invalid request'
              : missing
                ? 'Scope not found'
                : 'Operations data unavailable'}
          </h1>
        </div>
        <Notice kind="fail">
          {invalid
            ? 'An identifier, filter or pagination value is malformed. Correct the request to continue.'
            : missing
              ? 'The requested entity is not available in this book.'
              : 'The database or a required verification query could not complete. Financial assurance is unavailable; this is not an empty healthy result.'}
        </Notice>
        <p>
          <Link href={url('overview', book)}>Return to overview →</Link>
        </p>
      </Shell>
    );
  }
}
