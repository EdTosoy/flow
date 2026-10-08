/** Test-only profiler: administrator capabilities stay in the disposable runner database. */
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { writeFile } from 'node:fs/promises';
import { cpus, totalmem, release } from 'node:os';
import {
  PostgresOperations,
  type ReadObservation,
} from '@flow/operations-read-postgres';
import { previousReadDefinitions } from './previous-read-definitions';
export function distribution(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    samplesMs: samples,
    medianMs: sorted[Math.floor(sorted.length / 2)]!,
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1]!,
  };
}
export async function profileReads(
  pool: Pool,
  reader: Pool,
  demo: {
    bookId: string;
    evaluationId: string;
    reconciliationRunIds: string[];
  },
  dataset: unknown,
) {
  const report: Record<string, unknown> = {
    dataset,
    sampleCount: 5,
    warmupCount: 1,
    versions: {},
  };
  const client = await pool.connect();
  const operations = [
    ['overview', { evaluation: demo.evaluationId }],
    ['controls', { evaluation: demo.evaluationId }],
    ['run', { id: demo.reconciliationRunIds[0] }],
    ['exceptions', {}],
  ] as const;
  try {
    report.context = {
      node: process.version,
      os: release(),
      cpu: cpus()[0]?.model,
      hardwareThreads: cpus().length,
      hostMemoryBytes: totalmem(),
      database: (
        await client.query(
          "SELECT version(),current_setting('track_functions') AS tracking,current_setting('fsync') AS fsync,current_setting('synchronous_commit') AS synchronous_commit",
        )
      ).rows[0],
    };
    const snapshots = new Map<string, unknown>();
    const commonTime = (
      await client.query('SELECT statement_timestamp() AS at')
    ).rows[0].at.toISOString();
    const sweepDefinition = (
      await client.query(
        "SELECT pg_get_functiondef('integrity.sweep(uuid,uuid[])'::regprocedure) AS definition",
      )
    ).rows[0].definition as string;
    const statsSql =
      'SELECT schemaname,funcname,calls,total_time,self_time FROM pg_stat_xact_user_functions';
    // Drop only read-time timestamps; all financial scopes, exact values and evidence remain compared.
    function stable(value: unknown): unknown {
      if (Array.isArray(value)) return value.map(stable);
      if (value && typeof value === 'object')
        return Object.fromEntries(
          Object.entries(value)
            .filter(([k]) => k !== 'asOf')
            .map(([k, v]) => [k, stable(v)]),
        );
      return value;
    }
    for (const phase of process.env['FLOW_PROFILE_LARGE']
      ? ['optimized']
      : ['optimized', 'baseline']) {
      const measurements: Record<string, unknown> = {};
      const run = async (operation: string, options: unknown) =>
        (
          await client.query('SELECT operations.read_v1($1,$2,$3) AS result', [
            demo.bookId,
            operation,
            options,
          ])
        ).rows[0].result;
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      if (phase === 'baseline') await previousReadDefinitions(client);
      // Rollback-only test clock: both implementations see exactly the same live aging cutoff.
      assert(
        sweepDefinition.includes('now_at timestamptz:=statement_timestamp()'),
      );
      await client.query(
        sweepDefinition.replace(
          'now_at timestamptz:=statement_timestamp()',
          "now_at timestamptz:='" + commonTime + "'::timestamptz",
        ),
      );
      try {
        for (const [operation, options] of operations) {
          await run(operation, options); // Warm caches/JIT/prepared SQL, excluded from distribution.
          // Live transaction counters, before/after deltas: no lag or global reset contamination.
          const before = (await client.query(statsSql)).rows;
          const samples: number[] = [];
          for (let i = 0; i < 5; i++) {
            const start = performance.now();
            const result = await run(operation, options);
            samples.push(performance.now() - start);
            if (phase === 'optimized') snapshots.set(operation, stable(result));
            else
              assert.deepEqual(
                stable(result),
                snapshots.get(operation),
                'complete original and optimized ' + operation + ' evidence',
              );
          }
          const functions = (await client.query(statsSql)).rows
            .map((f) => {
              const old = before.find(
                (b) =>
                  b.schemaname === f.schemaname && b.funcname === f.funcname,
              );
              return {
                ...f,
                calls: Number(f.calls) - Number(old?.calls ?? 0),
                total_time: f.total_time - (old?.total_time ?? 0),
                self_time: f.self_time - (old?.self_time ?? 0),
              };
            })
            .filter((f) => f.calls > 0)
            .sort((a, b) => b.self_time - a.self_time)
            .slice(0, 30);
          measurements[operation] = {
            ...distribution(samples),
            sqlTransportQueriesPerRead: 1,
            functions,
          };
        }
        const components: Record<string, number> = {};
        for (const [name, sql, values] of [
          [
            'integritySweep',
            'SELECT integrity.sweep($1,$2::uuid[])',
            [demo.bookId, demo.reconciliationRunIds],
          ],
          [
            'controlFreshnessSummary',
            'SELECT controls.summary($1)',
            [demo.evaluationId],
          ],
          [
            'controlSnapshot',
            'SELECT controls.snapshot(command,frozen_at) FROM controls.run WHERE id=$1',
            [demo.evaluationId],
          ],
          [
            'canonicalExposure',
            'SELECT controls.exposure($1)',
            [demo.reconciliationRunIds[0]],
          ],
          [
            'frozenMemberProjection',
            'SELECT item_id FROM reconciliation.run_member WHERE run_id=$1 ORDER BY item_id LIMIT 51',
            [demo.reconciliationRunIds[0]],
          ],
        ] as const) {
          const start = performance.now();
          await client.query(sql, [...values]);
          components[name] = performance.now() - start;
        }
        const plans: Record<string, unknown> = {};
        for (const [name, sql, values] of [
          [
            'originalActiveAllocation',
            'SELECT * FROM reconciliation.active_allocation WHERE item_id IN (SELECT item_id FROM reconciliation.run_member WHERE run_id=$1)',
            [demo.reconciliationRunIds[0]],
          ],
          [
            'batchedActiveItems',
            'SELECT * FROM reconciliation.active_items(ARRAY(SELECT item_id FROM reconciliation.run_member WHERE run_id=$1))',
            [demo.reconciliationRunIds[0]],
          ],
          [
            'controlFreshness',
            'SELECT controls.summary($1)',
            [demo.evaluationId],
          ],
          [
            'scopedRevisionStatus',
            'SELECT * FROM ingestion.fact_status WHERE source_account_id IN (SELECT id FROM ingestion.source_account WHERE book_id=$1)',
            [demo.bookId],
          ],
        ] as const) {
          plans[name] = (
            await client.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ' + sql, [
              ...values,
            ])
          ).rows[0]['QUERY PLAN'];
        }
        (report.versions as Record<string, unknown>)[phase] = {
          operations: measurements,
          componentsMs: components,
          plans,
        };
      } finally {
        await client.query('ROLLBACK');
      }
    }
    // Actual restricted adapter overhead and five bounded transport calls, including transaction setup.
    const observations: ReadObservation[] = [];
    const adapter = new PostgresOperations(reader, (o) => observations.push(o));
    for (const [operation, options] of operations) {
      await adapter.read(operation, demo.bookId, options);
      assert.equal(observations.at(-1)!.queryCount, 5);
    }
    report.adapterObservations = observations;
    report.equivalent = !process.env['FLOW_PROFILE_LARGE'];
    await writeFile(
      process.env['FLOW_PROFILE_READS']!,
      JSON.stringify(report, null, 2) + '\n',
    );
    console.log(
      'PHASE13_PROFILE ' +
        JSON.stringify({
          dataset,
          operations: Object.fromEntries(
            Object.entries(
              report.versions as Record<
                string,
                {
                  operations: Record<
                    string,
                    { medianMs: number; p95Ms: number }
                  >;
                }
              >,
            ).map(([version, v]) => [
              version,
              Object.fromEntries(
                Object.entries(v.operations).map(([op, m]) => [
                  op,
                  { medianMs: m.medianMs, p95Ms: m.p95Ms },
                ]),
              ),
            ]),
          ),
          adapterObservations: observations,
        }),
    );
  } finally {
    client.release();
  }
}
