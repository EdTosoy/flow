import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { migrate } from './migrations';

const exec = promisify(execFile);
const image =
  'postgres:18@sha256:fc973eb97c9fd04bfa1840e0f510719a584ccb3be8debfe6a4144637a9dfe8cf';

/** Owns only its randomly named disposable container; never resets an existing database. */
async function main(): Promise<void> {
  const name = `flow-phase1-${randomUUID()}`;
  let started = false;
  let admin: Pool | undefined;
  try {
    await exec(
      'docker',
      [
        'run',
        '--detach',
        '--rm',
        '--name',
        name,
        '--publish',
        '127.0.0.1::5432',
        '--env',
        'POSTGRES_USER=flow_test_admin',
        '--env',
        'POSTGRES_DB=flow_test',
        '--env',
        'POSTGRES_HOST_AUTH_METHOD=trust',
        image,
        '-c',
        'max_connections=160',
        '-c',
        'fsync=on',
        '-c',
        'synchronous_commit=on',
      ],
      { timeout: 120000 },
    );
    started = true;
    const portResult = await exec('docker', ['port', name, '5432/tcp']);
    const port = portResult.stdout.trim().split(':').at(-1)!;
    const url = `postgresql://flow_test_admin@127.0.0.1:${port}/flow_test`;
    admin = new Pool({ connectionString: url });
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try {
        await admin.query('SELECT 1');
        ready = true;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    if (!ready) throw new Error('Disposable PostgreSQL failed to become ready');
    await migrate(admin);
    await migrate(admin); // Empty migration plus idempotent hash consistency gate.
    await admin.query(
      'CREATE ROLE flow_test_writer LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS IN ROLE flow_ledger_writer',
    );
    await admin.query(
      'CREATE ROLE flow_test_reader LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS IN ROLE flow_ledger_reader',
    );
    const version = await admin.query<{ version: string }>(
      'SHOW server_version',
    );
    console.log(
      `Disposable PostgreSQL ${Object.values(version.rows[0]!)[0]}; migration from empty + hash consistency PASS`,
    );
    await new Promise<void>((resolve, reject) => {
      const child = execFile(
        process.execPath,
        [
          '--import',
          'tsx',
          '--test',
          '--test-concurrency=1',
          'tests/ledger.integration.test.ts',
          'tests/simulator-ledger.integration.test.ts',
        ],
        {
          env: {
            ...process.env,
            FLOW_TEST_ADMIN_URL: url,
            FLOW_TEST_WRITER_URL: url.replace(
              'flow_test_admin@',
              'flow_test_writer@',
            ),
            FLOW_TEST_READER_URL: url.replace(
              'flow_test_admin@',
              'flow_test_reader@',
            ),
          },
          maxBuffer: 10 * 1024 * 1024,
        },
      );
      child.stdout?.pipe(process.stdout);
      child.stderr?.pipe(process.stderr);
      child.on('error', reject);
      child.on('exit', (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`Integration suite exited ${code}`)),
      );
    });
  } finally {
    await admin?.end();
    if (started) await exec('docker', ['stop', '--time', '2', name]);
  }
}
main().catch((error) => {
  console.error(
    error instanceof Error
      ? error.message
      : 'Integration infrastructure failed',
  );
  process.exitCode = 1;
});
