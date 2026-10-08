import 'server-only';
import { Pool } from 'pg';
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
export async function read(
  kind: Operation,
  book: string | null,
  filters: Record<string, string | undefined> = {},
) {
  const url = process.env['DATABASE_OPERATIONS_URL'];
  if (!url) throw new ReadUnavailable('UNAVAILABLE');
  if (!pool) {
    pool = new Pool({
      connectionString: url,
      max: 4,
      connectionTimeoutMillis: 3000,
      idleTimeoutMillis: 10000,
    });
    pool.on('error', () =>
      console.error(
        JSON.stringify({ event: 'operations_idle_connection_reset' }),
      ),
    );
  }
  try {
    return await new PostgresOperations(pool).read(kind, book, filters);
  } catch (error) {
    // Intentionally omit error messages, SQL, connection strings, payloads and stack traces.
    console.error(
      JSON.stringify({
        event: 'operations_read_failed',
        operation: kind,
        category:
          error instanceof InvalidRead
            ? 'INVALID_REQUEST'
            : error instanceof ReadUnavailable
              ? error.category
              : 'UNAVAILABLE',
      }),
    );
    throw error;
  }
}
