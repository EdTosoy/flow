import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  readFileSync,
  readdirSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { ESLint } from 'eslint';
import * as publicApi from '@flow/simulator';

const root = process.cwd();
test('oracle isolation rejects static, relative, dynamic, require and harness imports from untagged applications', async () => {
  const eslint = new ESLint({
    overrideConfig: { rules: { '@nx/enforce-module-boundaries': 'off' } },
  });
  for (const code of [
    "import { generateSimulation } from '@flow/simulator-oracle'; void generateSimulation;",
    "export * from '../../libs/simulator-oracle/src/index';",
    "const truth = import('@flow/simulator-oracle'); void truth;",
    "const truth = require('@flow/simulator-oracle'); void truth;",
    "export type Truth = import('@flow/simulator-oracle').Oracle;",
    "export * from '../../tools/simulator';",
    "export * from '../../tests/simulator-ledger.integration.test';",
    "export * from '../../tests/helpers/resilience';",
    "export * from '../../tests/resilience.integration.test';",
    "export * from '../../tools/test-postgres';",
    "export * from '../../libs/simulator-oracle/dist/index.js';",
  ] as const) {
    const [result] = await eslint.lintText(code, {
      filePath: path.join(root, 'apps/probe/index.ts'),
    });
    assert(
      result!.messages.some(
        (m) => m.ruleId === 'flow-boundaries/no-oracle-import',
      ),
      code,
    );
  }
  const [allowed] = await eslint.lintText(
    "import type { SystemInput } from '@flow/simulator'; export type Input = SystemInput;",
    { filePath: path.join(root, 'apps/probe/index.ts') },
  );
  assert.equal(allowed!.errorCount, 0);
  for (const file of [
    'stripe-worker.ts',
    'stripe-backfill.ts',
    'stripe-config.ts',
  ]) {
    const [result] = await eslint.lintText(
      "import { generateSimulation } from '@flow/simulator-oracle'; void generateSimulation;",
      { filePath: path.join(root, 'tools', file) },
    );
    assert(
      result!.messages.some(
        (m) => m.ruleId === 'flow-boundaries/no-oracle-import',
      ),
      file,
    );
  }
});
test('Nx prevents runtime simulator from depending on oracle and financial core from simulator', async () => {
  const eslint = new ESLint();
  for (const [file, code] of [
    [
      'libs/integrity-postgres/src/probe.ts',
      "import { generateSimulation } from '@flow/simulator-oracle'; void generateSimulation;",
    ],
    [
      'libs/integrity-postgres/src/write-probe.ts',
      "import { PostgresLedger } from '@flow/ledger-postgres'; void PostgresLedger;",
    ],
    [
      'libs/control-domain/src/probe.ts',
      "import { generateSimulation } from '@flow/simulator-oracle'; void generateSimulation;",
    ],
    [
      'libs/control-postgres/src/probe.ts',
      "import { generateSimulation } from '@flow/simulator-oracle'; void generateSimulation;",
    ],
    [
      'libs/control-postgres/src/ledger-probe.ts',
      "import { PostgresLedger } from '@flow/ledger-postgres'; void PostgresLedger;",
    ],
    [
      'libs/control-domain/src/recon-probe.ts',
      "import { evaluate } from '@flow/reconciliation-domain'; void evaluate;",
    ],
    [
      'libs/reconciliation-domain/src/control-probe.ts',
      "import { serializeControl } from '@flow/control-domain'; void serializeControl;",
    ],
    [
      'libs/exception-domain/src/probe.ts',
      "import { generateSimulation } from '@flow/simulator-oracle'; void generateSimulation;",
    ],
    [
      'libs/exception-postgres/src/probe.ts',
      "import { generateSimulation } from '@flow/simulator-oracle'; void generateSimulation;",
    ],
    [
      'libs/exception-domain/src/reconciliation-probe.ts',
      "import { evaluate } from '@flow/reconciliation-domain'; void evaluate;",
    ],
    [
      'libs/exception-postgres/src/reconciliation-probe.ts',
      "import { PostgresReconciliation } from '@flow/reconciliation-postgres'; void PostgresReconciliation;",
    ],
    [
      'libs/reconciliation-domain/src/exception-probe.ts',
      "import { nextState } from '@flow/exception-domain'; void nextState;",
    ],
    [
      'libs/exception-postgres/src/ledger-probe.ts',
      "import { PostgresLedger } from '@flow/ledger-postgres'; void PostgresLedger;",
    ],
    [
      'libs/simulator/src/probe.ts',
      "import { generateSimulation } from '@flow/simulator-oracle'; void generateSimulation;",
    ],
    [
      'libs/money/src/probe.ts',
      "import { captureCommand } from '@flow/simulator'; void captureCommand;",
    ],
    [
      'libs/ingestion-domain/src/probe.ts',
      "import { generateSimulation } from '@flow/simulator-oracle'; void generateSimulation;",
    ],
    [
      'libs/ingestion-postgres/src/probe.ts',
      "import { generateSimulation } from '@flow/simulator-oracle'; void generateSimulation;",
    ],
    [
      'libs/ingestion-domain/src/probe.ts',
      "import { captureCommand } from '@flow/simulator'; void captureCommand;",
    ],
    [
      'libs/ingestion-postgres/src/probe.ts',
      "import { PostgresLedger } from '@flow/ledger-postgres'; void PostgresLedger;",
    ],
    [
      'libs/processor-domain/src/probe.ts',
      "import { generateSimulation } from '@flow/simulator-oracle'; void generateSimulation;",
    ],
    [
      'libs/processor-postgres/src/probe.ts',
      "import { generateSimulation } from '@flow/simulator-oracle'; void generateSimulation;",
    ],
    [
      'libs/processor-domain/src/probe.ts',
      "import { PostgresLedger } from '@flow/ledger-postgres'; void PostgresLedger;",
    ],
    [
      'libs/processor-postgres/src/probe.ts',
      "import { PostgresLedger } from '@flow/ledger-postgres'; void PostgresLedger;",
    ],
    [
      'libs/bank-domain/src/probe.ts',
      "import { generateSimulation } from '@flow/simulator-oracle'; void generateSimulation;",
    ],
    [
      'libs/bank-postgres/src/probe.ts',
      "import { generateSimulation } from '@flow/simulator-oracle'; void generateSimulation;",
    ],
    [
      'libs/bank-domain/src/probe.ts',
      "import { PostgresProcessor } from '@flow/processor-postgres'; void PostgresProcessor;",
    ],
    [
      'libs/bank-postgres/src/probe.ts',
      "import { PostgresLedger } from '@flow/ledger-postgres'; void PostgresLedger;",
    ],
    [
      'libs/money/src/probe.ts',
      "import { movement } from '@flow/bank-domain'; void movement;",
    ],
    [
      'libs/reconciliation-domain/src/grouped-probe.ts',
      "import { generateGroupedSimulation } from '@flow/simulator-oracle'; void generateGroupedSimulation;",
    ],
    [
      'libs/reconciliation-postgres/src/grouped-probe.ts',
      "import { generateGroupedSimulation } from '@flow/simulator-oracle'; void generateGroupedSimulation;",
    ],
    [
      'libs/reconciliation-domain/src/probe.ts',
      "import { generateSimulation } from '@flow/simulator-oracle'; void generateSimulation;",
    ],
    [
      'libs/reconciliation-postgres/src/probe.ts',
      "import { generateSimulation } from '@flow/simulator-oracle'; void generateSimulation;",
    ],
    [
      'libs/reconciliation-postgres/src/probe.ts',
      "import { PostgresLedger } from '@flow/ledger-postgres'; void PostgresLedger;",
    ],
    [
      'libs/money/src/probe.ts',
      "import { evaluate } from '@flow/reconciliation-domain'; void evaluate;",
    ],
    [
      'libs/bank-domain/src/probe.ts',
      "import { evaluate } from '@flow/reconciliation-domain'; void evaluate;",
    ],
    [
      'libs/money/src/probe.ts',
      "import { lifecycle } from '@flow/processor-domain'; void lifecycle;",
    ],
    [
      'libs/worker-postgres/src/probe.ts',
      "import { generateSimulation } from '@flow/simulator-oracle'; void generateSimulation;",
    ],
    [
      'libs/worker-postgres/src/probe.ts',
      "import { PostgresLedger } from '@flow/ledger-postgres'; void PostgresLedger;",
    ],
    [
      'libs/ingestion-domain/src/probe.ts',
      "import { PostgresWorker } from '@flow/worker-postgres'; void PostgresWorker;",
    ],
  ] as const) {
    const [result] = await eslint.lintText(code, {
      filePath: path.join(root, file!),
    });
    assert(
      result!.messages.some(
        (m) => m.ruleId === '@nx/enforce-module-boundaries',
      ),
      JSON.stringify(result!.messages),
    );
  }
});
test('runtime package dependency closure contains neither oracle nor generation harness', () => {
  const packages = new Map<
    string,
    { dependencies: Record<string, string>; oracle: boolean }
  >();
  for (const dir of readdirSync(path.join(root, 'libs'), {
    withFileTypes: true,
  })) {
    if (!dir.isDirectory()) continue;
    const pkg = JSON.parse(
      readFileSync(path.join(root, 'libs', dir.name, 'package.json'), 'utf8'),
    );
    const project = JSON.parse(
      readFileSync(path.join(root, 'libs', dir.name, 'project.json'), 'utf8'),
    );
    packages.set(pkg.name, {
      dependencies: pkg.dependencies ?? {},
      oracle: project.tags.includes('trust:oracle'),
    });
  }
  function visit(name: string, seen = new Set<string>()): void {
    if (seen.has(name)) return;
    seen.add(name);
    const pkg = packages.get(name);
    if (!pkg) return;
    assert(!pkg.oracle, `Runtime dependency closure reaches ${name}`);
    for (const dep of Object.keys(pkg.dependencies)) visit(dep, seen);
  }
  for (const [name, pkg] of packages) if (!pkg.oracle) visit(name);
  assert.deepEqual(
    Object.keys(publicApi)
      .filter((k) => k !== 'default')
      .sort(),
    ['captureCommand', 'sha256', 'stableJson'],
  );
});

test('manifest guard rejects an untagged app with a transitive oracle dependency', () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), 'flow-oracle-boundary-'));
  for (const [directory, name, dependencies, tags] of [
    ['apps/runtime', '@probe/app', { '@probe/bridge': 'workspace:*' }, []],
    ['libs/bridge', '@probe/bridge', { '@probe/oracle': 'workspace:*' }, []],
    ['libs/oracle', '@probe/oracle', {}, ['trust:oracle']],
  ] as const) {
    const target = path.join(fixture, directory);
    mkdirSync(target, { recursive: true });
    writeFileSync(
      path.join(target, 'package.json'),
      JSON.stringify({ name, dependencies }),
    );
    writeFileSync(path.join(target, 'project.json'), JSON.stringify({ tags }));
  }
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        [path.join(root, 'tools/check-oracle-dependencies.mjs')],
        { cwd: fixture, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      ),
    /Runtime dependency reaches oracle/,
  );
});
