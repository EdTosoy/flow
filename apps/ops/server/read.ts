import 'server-only';
import { Pool } from 'pg';
import { observe, telemetry, log } from './telemetry';
import {
  PostgresOperations,
  identifier,
  InvalidRead,
  ReadUnavailable,
  type Operation,
} from '@flow/operations-read-postgres';
export type Search = Record<string, string | string[] | undefined>;
let pool: Pool | undefined;
export function scope(search: Search): {
  book: string | null;
  evaluation: string | undefined;
  filters: Record<string, string | undefined>;
} {
  const filters: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(search)) {
    if (Array.isArray(value)) throw new InvalidRead();
    if (key === 'book') continue;
    if (
      ![
        'evaluation',
        'status',
        'category',
        'currency',
        'cursor',
        'limit',
        'id',
        'key',
      ].includes(key)
    )
      throw new InvalidRead();
    filters[key] = value;
  }
  const book = search['book'] ?? process.env['OPS_BOOK_ID'];
  if (Array.isArray(book)) throw new InvalidRead();
  return {
    book: book ? identifier(book) : null,
    evaluation: filters['evaluation'],
    filters,
  };
}
function reader() {
  const url = process.env['DATABASE_OPERATIONS_URL'];
  if (!url) throw new ReadUnavailable('UNAVAILABLE');
  if (!pool) {
    pool = new Pool({
      connectionString: url,
      max: 4,
      connectionTimeoutMillis: 3000,
      idleTimeoutMillis: 10000,
      application_name: 'flow-operations',
    });
    pool.on('error', () =>
      log('idle_connection', 'FAILURE', {
        classification: 'DATABASE_UNAVAILABLE',
      }),
    );
  }
  return new PostgresOperations(pool, observe);
}
export async function ready() {
  await reader().ready();
}
export async function read(
  kind: Operation,
  book: string | null,
  filters: Record<string, string | undefined> = {},
) {
  const result = await reader().read(kind, book, filters);
  telemetry.observedModel(kind, result);
  return result;
}
