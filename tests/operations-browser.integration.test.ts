import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import {
  readFile,
  writeFile,
  mkdtemp,
  rm,
  mkdir,
  readdir,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { chromium } from '@playwright/test';
import type { SystemInput } from '@flow/simulator';
import { PostgresOperations } from '@flow/operations-read-postgres';
import { seedDemo, type DemoPools } from '../tools/ops-demo';
import { clean, witness } from './helpers/resilience';
const exec = promisify(execFile);
const keys: Record<keyof DemoPools, string> = {
  admin: 'ADMIN',
  ingestion: 'INGESTION',
  processor: 'PROCESSOR',
  bank: 'BANK',
  reconciliation: 'RECONCILIATION',
  exceptions: 'EXCEPTION',
  controls: 'CONTROL',
  worker: 'WORKER',
  integrity: 'INTEGRITY',
};
const p = Object.fromEntries(
  Object.entries(keys).map(([k, v]) => [
    k,
    new Pool({ connectionString: process.env['FLOW_TEST_' + v + '_URL'] }),
  ]),
) as unknown as DemoPools;
const op = new Pool({
    connectionString: process.env['FLOW_TEST_OPERATIONS_URL'],
  }),
  reads = new PostgresOperations(op);
if (!process.env['FLOW_TEST_OPERATIONS_URL'])
  throw new Error('Run pnpm test:integration');
after(async () => {
  await Promise.all([...Object.values(p), op].map((p) => p.end()));
});
async function port() {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const a = s.address();
  if (!a || typeof a === 'string') throw new Error('No test port');
  await new Promise<void>((r) => s.close(() => r()));
  return a.port;
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null) return;
  const done = new Promise((r) => child.once('exit', r));
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  await done;
  clearTimeout(timer);
}
test(
  'public simulator demo, restricted production browser, query plans and local performance',
  { timeout: 240000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'flow-ops-public-'));
    let child: ChildProcess | undefined;
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    try {
      const configs = [
        { seed: 71200, paymentCount: 40, batchSizeRange: [5, 10] },
        {
          seed: 71201,
          paymentCount: 12,
          batchSizeRange: [1, 1],
          anomalies: {
            'missing-bank-transaction': { count: 2 },
            'duplicate-bank-observation': { count: 2 },
            'incorrect-amount': { count: 2 },
          },
        },
        { seed: 71202, paymentCount: 12, batchSizeRange: [1, 1] },
        { seed: 71203, paymentCount: 8, batchSizeRange: [2, 2] },
      ];
      const inputs: SystemInput[] = [];
      for (const [i, config] of configs.entries()) {
        const file = join(dir, 'config-' + i + '.json');
        await writeFile(file, JSON.stringify(config));
        const output = join(dir, 'public-' + i);
        await exec(
          process.execPath,
          [
            '--import',
            'tsx',
            'tools/simulator.ts',
            'generate',
            '--config',
            file,
            '--out',
            output,
            ...(i === 2 ? ['--group-size', '2'] : []),
          ],
          { timeout: 30000 },
        );
        inputs.push(
          JSON.parse(
            await readFile(join(output, 'input.json'), 'utf8'),
          ) as SystemInput,
        );
      }
      // Public synthetic USD variant exercises separate currency projections, without oracle labels.
      const usd = inputs[3]!;
      function usdCurrency(v: unknown): unknown {
        if (Array.isArray(v)) return v.map(usdCurrency);
        if (v && typeof v === 'object')
          return Object.fromEntries(
            Object.entries(v).map(([k, x]) => [
              k,
              k === 'currency' ? 'USD' : usdCurrency(x),
            ]),
          );
        return v;
      }
      inputs[3] = {
        ...(usdCurrency(usd) as SystemInput),
        processorEvents: usd.processorEvents.map((e) => ({
          ...e,
          payload: JSON.stringify(usdCurrency(JSON.parse(e.payload))),
        })),
      };
      const demo = await seedDemo(p, inputs, 'phase12-browser-benchmark', 12);
      const dataset = (
        await p.admin.query(
          'SELECT count(*)::integer AS receipts,count(DISTINCT r.revision_id)::integer AS revisions FROM ingestion.raw_record r JOIN ingestion.batch b ON b.id=r.batch_id JOIN ingestion.source_account s ON s.id=b.source_account_id WHERE s.book_id=$1',
          [demo.bookId],
        )
      ).rows[0];
      assert(dataset.receipts >= 1000);
      const exposed = await reads.read('overview', demo.bookId, {
        evaluation: demo.evaluationId,
      });
      const currencies = new Set(
        (
          exposed.data!['evaluation'] as { exposure: { currency: string }[] }
        ).exposure.map((x) => x.currency),
      );
      assert.deepEqual([...currencies].sort(), ['PHP', 'USD']);
      const grouped = await reads.read('run', demo.bookId, {
        id: demo.reconciliationRunIds[2],
      });
      assert(
        grouped.items!.some(
          (m) =>
            (m['allocation'] as { shape?: string } | null)?.shape === 'N:1',
        ),
      );
      assert(
        grouped
          .items!.filter((m) => m['allocation'])
          .every(
            (m) =>
              (m['allocation'] as { frozenDifferenceMinor: string })
                .frozenDifferenceMinor === '0',
          ),
      );
      const retain = await witness(p.admin);
      const queryMeasurements: Record<string, number> = {};
      for (const [name, kind, args] of [
        ['overview', 'overview', { evaluation: demo.evaluationId }],
        ['exceptionList', 'exceptions', {}],
        ['reconciliationDetail', 'run', { id: demo.reconciliationRunIds[0] }],
        ['controlsList', 'controls', { evaluation: demo.evaluationId }],
      ] as const) {
        const samples: number[] = [];
        for (let i = 0; i < 3; i++) {
          const begin = performance.now();
          await reads.read(kind, demo.bookId, args);
          samples.push(performance.now() - begin);
        }
        queryMeasurements[name] = samples.sort((a, b) => a - b)[1]!;
      }
      const plans: Record<string, unknown> = {};
      const queries = {
        exceptions:
          'SELECT c.id FROM exceptions.case_record c JOIN reconciliation.account_mapping m ON m.id=c.mapping_id WHERE m.book_id=$1 ORDER BY c.created_at,c.id LIMIT 51',
        controls:
          'SELECT key FROM controls.result WHERE run_id=$1 ORDER BY key LIMIT 51',
        run: 'SELECT item_id FROM reconciliation.run_member WHERE run_id=$1 ORDER BY item_id LIMIT 51',
        workers:
          'SELECT w.id FROM worker.work_item w JOIN outbox.outbox_event o ON o.id=w.event_id WHERE o.book_id=$1 ORDER BY w.created_at,w.id LIMIT 51',
      };
      for (const [name, sql] of Object.entries(queries)) {
        const id =
          name === 'controls'
            ? demo.evaluationId
            : name === 'run'
              ? demo.reconciliationRunIds[0]
              : demo.bookId;
        const plan = (
          await p.admin.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ' + sql, [
            id,
          ])
        ).rows[0]['QUERY PLAN'][0];
        plans[name] = { executionMs: plan['Execution Time'], plan: plan.Plan };
      }
      console.log(
        'PHASE12_QUERY_MEASUREMENTS ' +
          JSON.stringify({ dataset, queryMedianMs: queryMeasurements }),
      );
      const bind = await port(),
        base = 'http://127.0.0.1:' + bind;
      child = spawn(
        process.execPath,
        [
          'apps/ops/node_modules/next/dist/bin/next',
          'start',
          'apps/ops',
          '--hostname',
          '127.0.0.1',
          '--port',
          String(bind),
        ],
        {
          env: {
            ...process.env,
            DATABASE_OPERATIONS_URL: process.env['FLOW_TEST_OPERATIONS_URL'],
            NEXT_TELEMETRY_DISABLED: '1',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      child.stdout?.resume();
      child.stderr?.resume();
      const started = performance.now();
      let ready = false;
      while (performance.now() - started < 15000) {
        if (child.exitCode !== null)
          throw new Error('Production app exited (' + child.exitCode + ')');
        try {
          const r = await fetch(base, { signal: AbortSignal.timeout(1000) });
          if (r.ok) {
            ready = true;
            break;
          }
        } catch {
          /* readiness only */
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      assert(ready, 'Production server ready within bound');
      let executable = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'];
      if (!executable) {
        try {
          executable = (await exec('which', ['chromium'])).stdout.trim();
        } catch {
          /* use Playwright-managed Chromium on supported hosts */
        }
      }
      browser = await chromium.launch({
        headless: true,
        ...(executable ? { executablePath: executable } : {}),
      });
      const page = await browser.newPage({
        viewport: { width: 1440, height: 1000 },
      });
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.name));
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push('console error');
      });
      const overview =
        base + '/?book=' + demo.bookId + '&evaluation=' + demo.evaluationId;
      await page.goto(overview);
      await page
        .getByRole('heading', { name: 'Financial operations', exact: true })
        .waitFor();
      assert((await page.getByText('UNKNOWN', { exact: false }).count()) > 0);
      assert((await page.getByText('FAIL', { exact: false }).count()) > 0);
      assert(
        (await page
          .getByText('Accepted-risk subset', { exact: true })
          .count()) > 0,
      );
      await page.locator('nav a').filter({ hasText: 'Reconciliation' }).click();
      await page
        .getByRole('heading', { name: 'Reconciliation', exact: true })
        .waitFor();
      await page.locator('main table a.identifier').first().click();
      await page
        .getByRole('heading', { name: 'Frozen reconciliation population' })
        .waitFor();
      assert((await page.getByText('CURRENT', { exact: false }).count()) > 0);
      await page.locator('nav a').filter({ hasText: 'Exceptions' }).click();
      await page.getByRole('heading', { name: 'Exception queue' }).waitFor();
      await page.locator('main table a.identifier').first().click();
      await page.getByRole('heading', { name: 'Operational case' }).waitFor();
      await page
        .getByRole('heading', { name: 'Financial reconciliation', exact: true })
        .waitFor();
      assert(
        (await page.getByText('Append-only case history and notes').count()) >
          0,
      );
      for (const [nav, heading] of [
        ['Controls', 'Financial controls'],
        ['Workers', 'Durable work'],
        ['Integrity', 'Independent integrity sweep'],
      ] as const) {
        await page.locator('nav a').filter({ hasText: nav }).click();
        await page.getByRole('heading', { name: heading }).waitFor();
      }
      await page.goto(
        base + '/workers?book=' + demo.bookId + '&status=FAILED_TERMINAL',
      );
      assert(
        (await page.getByText('DEMO_POISON', { exact: true }).count()) > 0,
      );
      await page.goto(
        base +
          '/controls?book=' +
          demo.bookId +
          '&evaluation=' +
          demo.evaluationId +
          '&status=UNKNOWN',
      );
      assert((await page.getByText('UNKNOWN', { exact: false }).count()) > 0);
      await page.goto(base + '/?book=invalid');
      await page.getByRole('heading', { name: 'Invalid request' }).waitFor();
      await p.admin.query(
        'REVOKE EXECUTE ON FUNCTION operations.read_v1(uuid,text,jsonb) FROM flow_operations_reader',
      );
      try {
        await page.goto(overview);
        await page
          .getByRole('heading', { name: 'Operations data unavailable' })
          .waitFor();
        assert.equal(
          await page
            .getByRole('heading', { name: 'Financial assurance checks' })
            .count(),
          0,
        );
      } finally {
        await p.admin.query(
          'GRANT EXECUTE ON FUNCTION operations.read_v1(uuid,text,jsonb) TO flow_operations_reader',
        );
      }
      const empty = randomUUID();
      await p.admin.query(
        "INSERT INTO ledger.book(id,code,environment) VALUES($1,$2,'synthetic')",
        [empty, 'empty-browser-' + empty],
      );
      await page.goto(base + '/?book=' + empty);
      assert(
        (await page.getByText('Assurance: UNKNOWN', { exact: false }).count()) >
          0,
      );
      await page.goto(overview);
      await page.keyboard.press('Tab');
      assert.equal(
        await page.locator(':focus').textContent(),
        'Skip to content',
      );
      await page.keyboard.press('Enter');
      assert.equal(await page.locator(':focus').getAttribute('id'), 'main');
      await mkdir('docs/phase12/screenshots', { recursive: true });
      await page.evaluate(() => {
        (document.activeElement as HTMLElement)?.blur();
        window.scrollTo(0, 0);
      });
      await page.screenshot({
        path: 'docs/phase12/screenshots/overview.png',
        fullPage: true,
      });
      await page.setViewportSize({ width: 640, height: 900 });
      await page.goto(
        base +
          '/exceptions?book=' +
          demo.bookId +
          '&evaluation=' +
          demo.evaluationId,
      );
      await page.getByRole('heading', { name: 'Exception queue' }).waitFor();
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > window.innerWidth,
        ),
        false,
      );
      assert.deepEqual(errors, []);
      await retain();
      await clean(p.admin, demo.bookId, demo.reconciliationRunIds);
      // Production client artifacts never contain database ports/connection strings or privileged implementations.
      async function scan(dir: string): Promise<string[]> {
        const result: string[] = [];
        for (const e of await readdir(dir, { withFileTypes: true })) {
          const path = join(dir, e.name);
          if (e.isDirectory()) result.push(...(await scan(path)));
          else if (e.name.endsWith('.js')) result.push(path);
        }
        return result;
      }
      const chunks = await scan('apps/ops/.next/static');
      for (const file of chunks) {
        const source = await readFile(file, 'utf8');
        for (const forbidden of [
          'FLOW_TEST_OPERATIONS_URL',
          'DATABASE_OPERATIONS_URL',
          'postgresql://',
          'operations.read_v1',
          'PostgresOperations',
          'simulator-oracle',
          'pg-connection-string',
        ])
          assert(!source.includes(forbidden), file + ' contains ' + forbidden);
      }
      console.log(
        'PHASE12_READ_BENCHMARK ' +
          JSON.stringify({
            dataset,
            queryMedianMs: queryMeasurements,
            plans,
            clientChunks: chunks.length,
            browserErrors: errors.length,
            browserVersion: browser.version(),
            assurance: demo.assurance,
          }),
      );
    } finally {
      await browser?.close();
      if (child) await stop(child);
      await rm(dir, { recursive: true, force: true });
    }
  },
);
