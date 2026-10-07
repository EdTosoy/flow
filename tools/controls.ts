import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { PostgresControls } from '@flow/control-postgres';
import type { ControlCommand } from '@flow/control-domain';
async function main() {
  const [operation, ...args] = process.argv.slice(2),
    url = process.env['DATABASE_CONTROL_URL'];
  if (!url) throw new Error('Missing control runtime URL');
  const pool = new Pool({ connectionString: url }),
    controls = new PostgresControls(pool);
  try {
    if (operation === 'run' && args[0])
      console.log(
        JSON.stringify(
          await controls.run(
            JSON.parse(await readFile(args[0], 'utf8')) as ControlCommand,
          ),
        ),
      );
    else if (operation === 'summary' && args[0])
      console.log(JSON.stringify(await controls.summary(args[0])));
    else if (operation === 'pipeline') {
      const runtime = JSON.parse(
        (
          await promisify(execFile)(
            process.execPath,
            ['--import', 'tsx', 'tools/exceptions.ts', 'pipeline', ...args],
            { env: process.env, maxBuffer: 16 * 1024 * 1024 },
          )
        ).stdout,
      );
      const result = await controls.run({
        bookId: args[1]!,
        runKey: args[2]! + ':controls',
        actorId: 'control-developer',
        reconciliationRunIds: [runtime.reconciliation.id],
        createCases: true,
      });
      console.log(JSON.stringify({ ...runtime, financialControls: result }));
    } else
      throw new Error(
        'Usage: controls run <command-json> | summary <id> | pipeline <reconciliation arguments>',
      );
  } finally {
    await pool.end();
  }
}
main().catch(() => {
  console.error(
    'Control workflow failed; inspect durable run and retry unchanged identity',
  );
  process.exitCode = 1;
});
