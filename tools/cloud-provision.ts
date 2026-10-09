/** One-shot offline deployment administrator. Never imported by a serving application. */
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { PostgresIngestion } from '@flow/ingestion-postgres';
import { migrate } from './migrations';
import { seedDemo, type DemoPools } from './ops-demo-seed';
import type { SystemInput } from '@flow/simulator';

const capabilities = {
  operations: 'flow_operations_reader',
  ingress: 'flow_stripe_ingress',
  stripeWorker: 'flow_stripe_worker',
  ingestion: 'flow_ingestion_writer',
  processor: 'flow_processor_writer',
  bank: 'flow_bank_writer',
  reconciliation: 'flow_reconciliation_writer',
  exceptions: 'flow_exception_writer',
  controls: 'flow_control_writer',
  worker: 'flow_worker',
  integrity: 'flow_integrity_reader',
} as const;
type Capability = keyof typeof capabilities;
interface Configuration {
  bookId: string;
  accountId: string;
  passwords: Record<Capability, string>;
}

async function main(): Promise<void> {
  const url = process.env['DATABASE_ADMIN_URL'];
  if (!url || process.env['STRIPE_MODE'] !== 'sandbox')
    throw new Error('One-shot admin configuration required');
  const config = JSON.parse(
    process.env['FLOW_PROVISIONING_CONFIG'] ?? '{}',
  ) as Configuration;
  if (
    !/^[0-9a-f-]{36}$/.test(config.bookId) ||
    !/^acct_[A-Za-z0-9]+$/.test(config.accountId)
  )
    throw new Error('Invalid scope');
  const admin = new Pool({
    connectionString: url,
    max: 2,
    connectionTimeoutMillis: 10000,
  });
  const entries: [Capability, Pool][] = [];
  let owner: Pool | undefined;
  try {
    // RDS master is not a PostgreSQL superuser. Explicit owner membership is confined to this administrator.
    await admin.query(`DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='flow_ledger_owner') THEN
      CREATE ROLE flow_ledger_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; END IF; END $$`);
    const grant = await admin.query<{ sql: string }>(
      "SELECT format('GRANT flow_ledger_owner TO %I WITH SET TRUE', current_user) AS sql",
    );
    await admin.query(grant.rows[0]!.sql);
    await migrate(admin);
    for (const [kind, capability] of Object.entries(capabilities) as [
      Capability,
      string,
    ][]) {
      const login = 'flow_demo_' + kind.toLowerCase();
      const password = config.passwords[kind];
      if (!/^[A-Za-z0-9_-]{40,100}$/.test(password))
        throw new Error('Strong scoped password required');
      if (
        !(await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [login]))
          .rowCount
      ) {
        const statement = await admin.query<{ sql: string }>(
          "SELECT format('CREATE ROLE %I LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', $1::text, $2::text) AS sql",
          [login, password],
        );
        await admin.query(statement.rows[0]!.sql);
      }
      await admin.query(`GRANT ${capability} TO ${login}`);
      const connection = new URL(url);
      connection.username = login;
      connection.password = password;
      const pool = new Pool({
        connectionString: connection.toString(),
        max: 2,
        connectionTimeoutMillis: 10000,
      });
      entries.push([kind, pool]);
      const roles = await admin.query<{ role: string }>(
        `SELECT r.rolname AS role FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid JOIN pg_roles p ON p.oid=m.member WHERE p.rolname=$1`,
        [login],
      );
      if (roles.rows.length !== 1 || roles.rows[0]!.role !== capability)
        throw new Error('Unexpected runtime membership');
      const safe = await pool.query<{ safe: boolean }>(
        `SELECT NOT(rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls) AND NOT pg_has_role(current_user,'flow_ledger_owner','MEMBER') AS safe FROM pg_roles WHERE rolname=current_user`,
      );
      if (!safe.rows[0]!.safe) throw new Error('Unsafe runtime principal');
      try {
        await pool.query('DELETE FROM ledger.book WHERE false');
        throw new Error('Forbidden write allowed');
      } catch (error) {
        if ((error as { code?: string }).code !== '42501') throw error;
      }
    }
    owner = new Pool({
      connectionString: url,
      max: 2,
      options: '-c role=flow_ledger_owner',
    });
    await owner.query(
      "INSERT INTO ledger.book(id,code,environment) VALUES($1,'aws-stripe-sandbox','test') ON CONFLICT(id) DO NOTHING",
      [config.bookId],
    );
    const sourceAccountId = await new PostgresIngestion(owner).registerSource({
      bookId: config.bookId,
      environment: 'test',
      provider: 'stripe',
      externalAccountId: config.accountId,
    });
    await owner.query(
      "SELECT stripe.configure($1::uuid,$2,'flow_demo_ingress','ingress')",
      [sourceAccountId, config.accountId],
    );
    await owner.query(
      "SELECT stripe.configure($1::uuid,$2,'flow_demo_stripeworker','worker')",
      [sourceAccountId, config.accountId],
    );
    const byKind = Object.fromEntries(entries) as Record<Capability, Pool>;
    const pools: DemoPools = {
      admin: owner,
      ingestion: byKind.ingestion,
      processor: byKind.processor,
      bank: byKind.bank,
      reconciliation: byKind.reconciliation,
      exceptions: byKind.exceptions,
      controls: byKind.controls,
      worker: byKind.worker,
      integrity: byKind.integrity,
    };
    const input = JSON.parse(
      await readFile('/app/demo/input.json', 'utf8'),
    ) as SystemInput;
    const demo = await seedDemo(pools, [input], 'phase15-public-synthetic');
    console.log(
      JSON.stringify({
        operation: 'cloud-provision',
        outcome: 'PASS',
        migrations: 13,
        permissions: 'PASS',
        stripeBookId: config.bookId,
        sourceAccountId,
        syntheticBookId: demo.bookId,
        assurance: demo.assurance,
        bank: 'synthetic only',
      }),
    );
  } finally {
    await Promise.all([
      admin.end(),
      owner?.end(),
      ...entries.map(([, p]) => p.end()),
    ]);
  }
}
void main().catch(() => {
  console.error(
    JSON.stringify({ operation: 'cloud-provision', outcome: 'FAILED' }),
  );
  process.exitCode = 1;
});
