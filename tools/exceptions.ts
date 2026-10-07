import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { PostgresExceptions } from '@flow/exception-postgres';
import type { CaseCommand } from '@flow/exception-domain';
async function main(): Promise<void> {
  const [operation, ...args] = process.argv.slice(2);
  const url = process.env['DATABASE_EXCEPTION_URL'];
  if (!url) throw new Error('Missing exception runtime URL');
  const pool = new Pool({ connectionString: url });
  const exceptions = new PostgresExceptions(pool);
  try {
    if (operation === 'pipeline') {
      const result = JSON.parse(
        (
          await promisify(execFile)(
            process.execPath,
            ['--import', 'tsx', 'tools/reconciliation.ts', ...args],
            { env: process.env, maxBuffer: 16 * 1024 * 1024 },
          )
        ).stdout,
      );
      const ids = await exceptions.generate(
        result.reconciliation.id,
        'exception-developer',
      );
      console.log(
        JSON.stringify({
          ...result,
          exceptions: await exceptions.summary(args[3]!),
          exceptionCaseIds: ids,
        }),
      );
    } else if (operation === 'generate' && args[0]) {
      console.log(
        JSON.stringify({
          caseIds: await exceptions.generate(args[0], 'exception-developer'),
        }),
      );
    } else if (operation === 'apply' && args[0]) {
      const command = JSON.parse(
        await readFile(args[0], 'utf8'),
      ) as CaseCommand;
      const view = await exceptions.apply(command);
      console.log(JSON.stringify(view));
    } else if (operation === 'summary' && args[0])
      console.log(JSON.stringify(await exceptions.summary(args[0])));
    else
      throw new Error(
        'Usage: exceptions pipeline <reconciliation arguments> | generate <run-id> | apply <command-json> | summary <mapping-id>',
      );
  } finally {
    await pool.end();
  }
}
main().catch(() => {
  console.error(
    'Exception workflow failed; retry unchanged identity or inspect durable case/version and safe database codes',
  );
  process.exitCode = 1;
});
