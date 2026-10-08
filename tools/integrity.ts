import { Pool } from 'pg';
import { PostgresIntegrity, health } from '@flow/integrity-postgres';

async function main() {
  const [book, ...runs] = process.argv.slice(2);
  const url = process.env['DATABASE_INTEGRITY_URL'];
  if (!url || !book)
    throw new Error(
      'Usage: integrity <book-id> [explicit-reconciliation-run-id ...]',
    );
  const pool = new Pool({ connectionString: url });
  try {
    const summary = await new PostgresIntegrity(pool).sweep(book, runs);
    const { controls: details, ...concise } = summary;
    console.log(
      JSON.stringify({
        ...concise,
        checks: health(summary),
        controlCount: details.length,
      }),
    );
    if (summary.integrity === 'FAIL') process.exitCode = 2;
  } finally {
    await pool.end();
  }
}
main().catch(() => {
  console.error('Integrity sweep unavailable; no assurance claimed');
  process.exitCode = 1;
});
