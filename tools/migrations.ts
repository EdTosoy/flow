import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Pool } from 'pg';

const migrationDirectory = resolve(__dirname, '../database/migrations');

/** Reviewed SQL is authoritative. Hashes detect edits; each migration is one transaction. */
export async function migrate(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('flow-schema-migrations',0))",
    );
    await client.query(`CREATE TABLE IF NOT EXISTS public.flow_schema_migration (
      name text PRIMARY KEY, checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
      applied_at timestamptz NOT NULL DEFAULT transaction_timestamp()
    )`);
    await client.query(
      'REVOKE ALL ON public.flow_schema_migration FROM PUBLIC',
    );
    const names = (await readdir(migrationDirectory))
      .filter((n) => /^\d{3}_[a-z_]+\.sql$/.test(n))
      .sort();
    const applied = await client.query<{ name: string; checksum: string }>(
      'SELECT name,checksum FROM public.flow_schema_migration ORDER BY name',
    );
    if (applied.rows.some((r, i) => names[i] !== r.name))
      throw new Error('Applied migrations are not a prefix of this checkout');
    for (const name of names) {
      const sql = await readFile(resolve(migrationDirectory, name), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const existing = applied.rows.find((r) => r.name === name);
      if (existing) {
        if (existing.checksum !== checksum)
          throw new Error(`Applied migration checksum changed: ${name}`);
      } else {
        await client.query(sql);
        await client.query(
          'INSERT INTO public.flow_schema_migration(name,checksum) VALUES($1,$2)',
          [name, checksum],
        );
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
