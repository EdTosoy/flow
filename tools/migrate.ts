import { Pool } from 'pg';
import { migrate } from './migrations';

async function main(): Promise<void> {
  if (!process.env['DATABASE_ADMIN_URL'])
    throw new Error(
      'Set DATABASE_ADMIN_URL explicitly; migration credentials must never be runtime credentials',
    );
  const pool = new Pool({
    connectionString: process.env['DATABASE_ADMIN_URL'],
  });
  try {
    await migrate(pool);
    console.log('Migration hashes and application complete');
  } finally {
    await pool.end();
  }
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Migration failed');
  process.exitCode = 1;
});
