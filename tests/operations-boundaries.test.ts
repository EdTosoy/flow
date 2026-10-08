import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ESLint } from 'eslint';
import { writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
test('browser closures and presentation modules cannot reach database, privileged ports or private tools', async () => {
  const eslint = new ESLint({
    overrideConfig: { rules: { '@nx/enforce-module-boundaries': 'off' } },
  });
  const probe = path.resolve('apps/ops/components/client-probe.tsx'),
    helper = path.resolve('apps/ops/components/boundary-probe-helper.ts');
  await writeFile(
    helper,
    "export {PostgresOperations} from '@flow/operations-read-postgres';\n",
  );
  try {
    for (const code of [
      "'use client'; import {Pool} from 'pg'; void Pool;",
      "'use client'; export * from './boundary-probe-helper';",
      "'use client'; const x=import('../server/read'); void x;",
      "export * from '@flow/ledger-postgres';",
      "export * from '../../../tools/ops-demo';",
      "export * from '../../../tests/helpers/resilience';",
      "'use client'; export * from '@flow/simulator-oracle';",
    ]) {
      const [r] = await eslint.lintText(code, { filePath: probe });
      assert(r!.errorCount > 0, code);
    }
  } finally {
    await unlink(helper);
  }
  const [server] = await eslint.lintText(
    "'use client'; import {Pool} from 'pg'; void Pool;",
    { filePath: path.resolve('apps/ops/server/unsafe-probe.ts') },
  );
  assert(server!.errorCount > 0);
  const [allowed] = await eslint.lintText(
    "import 'server-only'; import {PostgresOperations} from '@flow/operations-read-postgres'; void PostgresOperations;",
    { filePath: path.resolve('apps/ops/server/safe-probe.ts') },
  );
  assert.equal(allowed!.errorCount, 0);
  const [writer] = await eslint.lintText(
    "import 'server-only'; import {PostgresLedger} from '@flow/ledger-postgres'; void PostgresLedger;",
    { filePath: path.resolve('apps/ops/server/write-probe.ts') },
  );
  assert(writer!.errorCount > 0);
});
