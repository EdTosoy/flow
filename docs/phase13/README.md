# Phase 13 — Measured read performance and local observability

This page preserves the Phase 13 local performance scope. [Phase 14](../phase14/README.md) subsequently added Stripe sandbox evidence; [Phase 15](../phase15/README.md) added and verified the protected ephemeral AWS demo. Deferrals below describe the original milestone, not the current repository status. Phase 16 AI remains deferred.

Phase 13 improves the existing local/internal read-only operations application. No financial policy, command identity, allocation rule, accounting workflow or external infrastructure changes. The [verification record](verification.md) contains executed measurements, query plans, acceptance mapping and limitations.

## Proof work and optimization

Overview performs an independent current integrity sweep plus the explicitly selected frozen control summary with current freshness. Controls compares the complete current input snapshot with the frozen manifest before presenting historical results. Reconciliation detail preserves frozen member evidence, exception causes, allocation proof and the run summary. The inexpensive list projections were not the bottleneck: repeated domain proof expansion inside one PostgreSQL statement was.

Migration 012 batches current proof evaluation by the original mapping and booking window. A statement-local materialized CTE builds each distinct population once and passes it to the unchanged `reconciliation.valid_against` predicate. Internal helpers share active-item results with exception-cause and canonical-exposure reads. Existing command interfaces and independent checks remain. Complete control inputs accumulate in a PostgreSQL array before producing the identically ordered JSONB manifest, avoiding repeated copying of a growing document. A settlement invocation reuses identical STABLE payment snapshots for repeated membership references. Revision status uses one scoped aggregate with the same ambiguity/conflicting-token rules.

There is no cross-request cache, materialized view, denormalized financial table, new index, planner override or new dependency. No received record, frozen member, control input or integrity check is dropped. Existing population limits and exact numeric/string representations remain. Batching is computation reuse in the same snapshot, never stored financial authority. No timestamp/latest-arrival shortcut establishes freshness.

## Runtime observations

A generated `x-flow-request-id` replaces untrusted input in the Next.js proxy, is returned to the browser, and follows server request/page composition through AsyncLocalStorage to read observations. It is metadata, never an idempotency key. Structured JSON logs contain timestamp, level, subsystem, allowlisted operation, correlation ID, duration, outcome, query count, bounded row count and stable error classification. They contain no SQL, bind values, raw source evidence, credentials, arbitrary error messages, stacks or oracle labels. Financial audit history remains separate.

`OPS_SLOW_READ_MS` configures an integer threshold from 1 to 30000 ms (default 500). Observations count each driver query call, including transaction setup, capability checks, COMMIT and failure cleanup. Read elapsed time includes acquiring a client and decoding/presenting the result; database time measures query-call elapsed time including transport/decoding, not pure PostgreSQL CPU. Slow-read counts use the whole operation duration. Observer failure cannot change financial reads or cleanup.

`/metrics` exports dependency-free Prometheus-compatible text without a database call. Fixed operation/surface labels bound counters and latency histogram storage; no individual trace storage or ID labels exist. It exposes read/error/slow/query/row counts, accumulated database duration, read latency buckets, server handler/page-composition durations and errors. These server durations exclude downstream React serialization/network/hydration; browser navigation measures those separately.

Last-observed authoritative projections expose worker states, sweep work/recoverable-expiry counts, open exceptions, control PASS/FAIL/UNKNOWN counts by fixed subsystem, structural integrity/financial assurance and selected evaluation staleness. Per-operation observation timestamps and an evaluation timestamp make their sample age visible. They describe the last requested scoped snapshot, may originate from different books/times, and are **not** global financial totals or a current assurance scrape. Scraping never refreshes financial truth. Histories, retry metadata and exact per-currency exposure remain in their existing operations views. Metrics reset on process restart; no hosted platform, OpenTelemetry, alerts or durable metrics store is introduced.

## Health and bounded resources

| Surface                     | Meaning                                                            | Work                                                                                |
| --------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `/health/live`              | Process can respond                                                | No PostgreSQL query or assurance evaluation                                         |
| `/health/ready`             | Narrow reader can connect and execute the approved read capability | Five small driver calls, no sweep/control calculation; 200 READY or 503 UNAVAILABLE |
| Existing Overview/Integrity | Supported financial/structural assurance                           | Full established read path with explicit PASS/FAIL/UNKNOWN                          |
| `/metrics`                  | Process observations and dated last-observed projections           | No database query                                                                   |

Financial FAIL or UNKNOWN does not make the process unready. Operators must still investigate failed controls. Responses use `no-store`; there is no cached health success.

The server retains one lazy process pool, max four clients, three-second acquisition/connect timeout, ten-second idle timeout and a fixed application name. Reads retain READ ONLY REPEATABLE READ with a 30-second maximum PostgreSQL statement timeout and 30-second idle-transaction timeout. Driver response deadlines add one second to the configured read deadline; readiness uses one-second PostgreSQL statement/idle limits and a 1200-ms driver response deadline. The driver option is supported by the pinned pg implementation even though its QueryConfig type declaration omits it. A stalled read transport destroys its client rather than queueing rollback behind a lost response. Ordinary SQL errors roll back; broken clients are discarded. These are bounded per-step deadlines, not a production end-to-end SLA. Query timeout/unavailability never renders healthy empty data.

## Reproduce

Use the existing pinned toolchain and disposable PostgreSQL runner. The optional profiler uses administrator capabilities only in test helpers; these never enter the application. No operator role privileges are broadened.

```sh
pnpm test:integration tests/observability.integration.test.ts
FLOW_PROFILE_READS=/tmp/flow-phase13-profile.json pnpm test:integration tests/operations-browser.integration.test.ts
FLOW_PROFILE_LARGE=1 FLOW_PROFILE_READS=/tmp/flow-phase13-large.json pnpm test:integration tests/operations-browser.integration.test.ts
pnpm verify
```

The profiler uses deterministic public artifacts, one warmup and five measured samples, transaction-local function-counter deltas and EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON). For the comparable fixture it restores original definitions and pins the sweep clock only inside rollback-only administrator transactions, comparing full returned evidence while excluding read-time asOf values. Production definitions and every earlier financial row survive. The larger profile measures optimized reads only; it is not a fabricated historical baseline. Profiling mode does not claim browser verification; the ordinary production browser test retains all previous gates and additionally exercises health/metrics, correlations, log fields, driver counts, server pool cleanup, memory and client artifact inspection.

The application stays localhost/internal under ADR-016. No new production identity boundary is claimed. Phase 14, public deployment, financial web mutations, production identity, real bank/processor integration, cloud, AI, N:M/partial allocation, new accounting/products, queues/brokers, cache/materialization and an observability platform remain deferred.

Mechanisms follow the installed Next 16.4 [proxy headers](https://nextjs.org/docs/app/api-reference/file-conventions/proxy), PostgreSQL 18 [statement-local CTE evaluation](https://www.postgresql.org/docs/18/queries-with.html) and [transaction-local function statistics](https://www.postgresql.org/docs/18/monitoring-stats.html). Installed driver code and real response-stall tests validate its deadline behavior.
