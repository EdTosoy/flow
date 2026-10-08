# Phase 13 verification record

Phase 13 is complete and verified within the documented local/internal synthetic scope. A fresh source-only copy passed the full native `pnpm verify` gate with 367 tests and no failures, skips or cancellations. Preferred Overview/Controls latency targets remain unmet, with measured limiting work documented below; these observations are not production SLAs.

## Baseline and methodology

Phase 12 reported 9,713.43 ms Overview, 3,857.46 ms Controls, 1,614.40 ms reconciliation detail and 4.94 ms Exceptions. The interrupted task retained a three-sample reproduction of 10,836.42 / 4,327.70 / 2,016.69 / 2.90 ms with the same 1,168 receipts and 204 revisions. The final comparison below runs original and optimized definitions against the same freshly provisioned public fixture. Different planning/warmup/host activity explains differences from the prior local observations; no Phase 12 dataset or deadline is removed.

Public seeds 71200–71203 configure 72 payments, four mappings and PHP/USD, exact/grouped matches, missing/duplicate/wrong-amount evidence, accepted risk, retryable/terminal synthetic work and twelve processor delivery replays. Receipt count includes redeliveries; it does not mean 1,168 independent economic movements. No simulator oracle enters runtime or telemetry.

One warmup and five completed samples per operation; median is the middle sorted sample, p95 the nearest-rank value (with five samples this is the maximum, a coarse tail observation). No fastest-run selection or CI wall-clock target is used. Both versions use track_functions=all, the same database state and the same test-only sweep aging cutoff. Original definitions and clock substitution exist only inside rolled-back administrator transactions. Returned book/control/integrity/member/allocation/case evidence is deeply compared, dropping only read-time asOf values. All authoritative evidence, money, status and frozen timestamps remain compared. Actual adapter observations separately verify permissions, read-only transactions and driver round trips. Profile mode exercises SQL/equivalence and does not claim browser navigation; the ordinary browser scenario is a separate native gate.

[Complete before/after samples, transaction-local function counts and EXPLAIN plans](profiles/before-after.json). PostgreSQL 18.6, pg 8.23.1, Node 24.21.0, Next 16.4.0, pnpm 11.27.0, Linux 6.18.53 x86_64, Intel Core i7-8700B, twelve available threads, approximately 35 GiB host memory; fsync/synchronous_commit on. No production SLA, throughput or capacity claim follows.

| Read                  | Phase 12 reference median | Reproduced original median | Optimized median | Optimized p95 | Reduction |
| --------------------- | ------------------------: | -------------------------: | ---------------: | ------------: | --------: |
| Overview              |               9,713.43 ms |                8,965.43 ms |      1,457.00 ms |   1,564.23 ms |    83.75% |
| Controls              |               3,857.46 ms |                3,672.65 ms |        679.85 ms |     682.70 ms |    81.49% |
| Reconciliation detail |               1,614.40 ms |                1,590.69 ms |        144.33 ms |     158.06 ms |    90.93% |
| Exceptions            |                   4.94 ms |                    1.10 ms |          1.03 ms |       1.18 ms |     6.58% |

The sub-second Overview and 500-ms Controls preferences are **not reached**. Reconciliation detail reaches its local preference. The limiting work is the retained full current integrity sweep and exact control-manifest freshness comparison, including supported domain proofs and independent historical verification. A snapshot/version timestamp alone cannot prove unchanged evidence. Correctness takes precedence over speculative markers, stale caches or omitted evidence.

## Additional deterministic scale

The two-times public fixture configures 144 payments and retains meaningful exact/grouped reconciliation, exceptions, controls and worker history. It produced **2,332 receipts and 408 revisions**; five warm samples measured Overview **4,231.31 ms median / 4,335.52 ms p95**, Controls **1,725.24 / 1,737.17 ms**, detail **323.15 / 324.27 ms**, and Exceptions **1.32 / 1.35 ms**. Each restricted adapter observation retained five driver calls; detail returned 22 bounded members. [Complete scale report and plans](profiles/larger.json).

The optional four-times fixture did not complete within the unchanged 240-second test deadline and is not a verified capacity observation. The two-times fixture completed in 171.83 seconds including seeding/profiling. Its unique-evidence growth increases full sweep/freshness work; it demonstrates a scaling limitation, not linear throughput or a production capacity guarantee. No historical larger-scale baseline is invented.

## Complete call graph and query work

Browser navigation → Next proxy (fresh correlation ID) → server-only page/route composition → singleton bounded pool → PostgresOperations read-only repeatable-read transaction → capability check → operations.read_v1 → established owning-domain functions → safe authoritative projections → server presentation. Each normal adapter read is five driver calls: BEGIN, one combined SET command, capability SELECT, one approved read SELECT, COMMIT. There are six SQL statements because the SET call contains two statements. These are application transport counts; database-internal function calls are different measurements.

Overview/Controls additionally fetch one bounded independent evaluation-choice list: ten driver calls per composition, preserving the documented separate navigation snapshot. Detail/Exceptions use five. Readiness uses five small calls; liveness/metrics use zero. There is no application per-row round-trip N+1. The expensive N+1 was rebuilding a whole reconciliation population for individual groups/items inside the approved statement. No identical application reads were found to justify request-level React caching or parallelism. Statement-local scope/payment reuse removes repetition without joining independent financial snapshots.

| Operation             | Original population_v6 calls/read | Optimized calls/read | Original payment_snapshot calls/read | Optimized calls/read |
| --------------------- | --------------------------------: | -------------------: | -----------------------------------: | -------------------: |
| Overview              |                               226 |                   28 |                               12,360 |                1,296 |
| Controls              |                                85 |                   12 |                                4,716 |                  576 |
| Reconciliation detail |                                30 |                    3 |                                3,600 |                  240 |

Counts come from live pg_stat_xact_user_functions before/after deltas, excluding warmups. Earlier cumulative reports could attribute unflushed prior-operation counters to a later operation; the final profiler avoids resets/flush timing entirely. SQL inlining can omit functions from statistics; the observed PL/pgSQL work and complete read durations remain measured.

## Bottleneck breakdown and plans

Inclusive times overlap and must not be added across parent/child calls. Self times attribute exclusive instrumented function work; opaque SQL function plans do not expose all nested nodes, so function counters and separate components accompany EXPLAIN.

- Overview: current integrity sweep 5,337.43 → 838.86 ms; selected control freshness summary 3,614.50 → 624.16 ms (separate warm component calls). Optimized average exclusive work includes payment snapshots 305.78 ms, settlement assembly 195.41 ms, grouped proof 179.53 ms, complete snapshot assembly 175.17 ms, sweep checks 101.68 ms and summary/result assembly 85.68 ms. Two control snapshots remain necessary: current sweep time and frozen evaluation time have different claims.
- Controls: exact input snapshot 3,530.36 → 529.69 ms. Optimized average exclusive payment work 143.57 ms, settlement work 92.70 ms, snapshot assembly 90.42 ms, summary assembly 87.47 ms and group proof 74.72 ms dominate; bounded result retrieval is inexpensive. No historical result or exception linkage is dropped.
- Reconciliation detail: frozen member projection is 0.47 ms optimized; the previous cost was repeated freshness/allocation/cause expansion. Populations fall from thirty to three, while all member evidence and complete groups remain. Canonical exposure component 647.30 → 41.58 ms retains exact pair residual, accepted-risk subset and UNKNOWN overlap semantics.
- Exceptions stays fast and its read branch is unchanged. Integrity remains a full independent read-only sweep, not a fast substitute; it creates no financial/control/work/audit state.

| EXPLAIN ANALYZE/BUFFERS query                               |    Original | Optimized | Relevant evidence                                                                                                                                                           |
| ----------------------------------------------------------- | ----------: | --------: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Original active-allocation projection                       |   643.43 ms | 497.25 ms | Twelve actual rows, one estimated; Nested Loop; 169,761 → 86,391 shared hits. The legacy view remains for original callers.                                                 |
| Batched active-items replacement on the same twelve members |           — |  43.54 ms | Function Scan, twelve actual rows, default estimate 1,000; 7,351 shared hits, zero shared reads.                                                                            |
| Control freshness summary                                   | 3,649.66 ms | 598.29 ms | One Result row; 637,065 → 65,846 shared hits, zero shared reads.                                                                                                            |
| Complete scoped revision-status projection                  |     3.36 ms |  12.69 ms | 204 actual rows, estimate one; rewrite removes repeated revision subqueries but this standalone projection is slower in this observation. No standalone speedup is claimed. |

Plans retain all scans/joins/sort/buffer nodes in the JSON artifact. No index, statistics tuning, speculative expression/partial index or global planner setting is added. Cardinality misestimates are disclosed; they do not explain the dominant repeated function work. Existing member/control keys and bounded projection plans remain adequate at this size. No index write/storage cost is introduced.

## Decisions, tests and limitations

Migration 012 adds private proof-batching helpers and replaces read implementations/view while retaining command interfaces, original valid_against, constraints/locks/guards, immutable history and prior migration hashes. It has no new table, financial lifecycle state, role grant, writable read port or event architecture. PUBLIC cannot execute the new helpers; the operator role still has only the approved read capability. Reconciliation rules, whole-item uniqueness, financial isolation/idempotency/fencing/audit/outbox remain unchanged. No new ADR is warranted for computation reuse; ADR-016's boundary remains in force.

Tests cover complete original/optimized snapshots/exposure/summary/fact-status equivalence, superseded allocations, ambiguous later revisions, retained historical digests, five driver calls, observer failure, actual locked-table statement timeout, capability rejection and client release. A real TCP proxy withholds PostgreSQL responses after BEGIN to test driver deadlines and destruction, without mocking PostgreSQL. The public comparison additionally includes N:1, two currencies, FAIL/UNKNOWN, accepted risk and worker history. Existing Phase 1–12 tests retain exact money, canonical exposure, accepted-risk, frozen snapshots, concurrency, crash, acknowledgement loss, restart, permission and oracle boundaries.

Production browser extensions assert distinct liveness/readiness/assurance, readiness despite financial FAIL/UNKNOWN, permission-revoked 503 while liveness stays 200, explicit unavailable pages, safe metrics, bounded fields/labels, replaced untrusted correlation ID and browser→server→read propagation. It reports pool state, two RSS/high-water samples, navigation timing and client JS bytes while retaining every prior navigation/accessibility/runtime/artifact gate. These sparse memory observations cannot establish leak freedom or production capacity. The final clean production browser observed Overview 1,710.20 ms median / 1,719.34 ms p95, Controls 757.41 / 773.81 ms, detail 176.39 / 176.59 ms and Exceptions 2.35 / 4.82 ms. Initial populated navigation took 2,246.27 ms; streamed TTFB was 14.90 ms and load event 2,239.90 ms. Server RSS/high-water grew from 111,416 to 152,632 KiB over the scenario. Twenty-six client chunks total 932,931 bytes, 902 bytes above the retained Phase 12 production build. There were zero browser errors, 77 allowlisted log records, 18,918 metrics bytes and one server pool connection with no stranded transaction. [Full production-browser observation](profiles/production-browser.json). Optional four-times scale exceeded the unchanged 240-second benchmark deadline; the additional practical fixture uses two-times scale. No normal verification timeout is weakened.

No dependencies, index, cross-request cache, materialized view, denormalization, OpenTelemetry/client instrumentation library, dashboard mutation, new queue or deployment is introduced. Internal metrics are dated last-observed scopes, not a global financial scrape; no exact monetary gauge is aggregated. Worker attempt/retry/age details remain in existing read views rather than an invented new authority. Metrics are process-local and reset after restart. Full integrity/freshness complexity can grow with unique evidence; redelivery volume is distinct from financial population growth.

Skills: implement-feature, fix-bug (test-proxy diagnosis) and verify-changes. The conditional verify-financial-change skill was not present in installed/project skill locations; no semantic change is authorized or implemented. Equivalence, invariant review, retained history and the full real PostgreSQL regression gates supply explicit verification without claiming that unavailable skill ran.

## Executed findings

- Initial retained-history test compared two witness closures instead of invoking the original witness. The corrected assertion verifies retained row digests; focused equivalence checks passed.
- The sandboxed Nx build returned zero after socket errors but produced no new route artifacts. It was not accepted as a successful build. Escalated native builds/typechecking exposed a pg QueryConfig declaration omission; a structurally typed config uses the option supported by the installed driver, without suppressing types. The clean production build includes all three new route artifacts.
- The first full run found the new response-stall proxy connecting to its own rewritten port. A focused reproduction confirmed failure; capturing the original destination port repaired it. All three focused observability tests then passed. The superseded full run was deliberately stopped after this failure and its runner released the disposable database; cancelled later suites from that interrupted run are not regression findings or successful verification. A fresh source-only copy subsequently passed the complete native gate.
- The four-times optional benchmark exceeded the unchanged 240-second deadline. The two-times fixture passed; no existing check, timeout or population bound was weakened.

## Executed gates

The final source-only checkout is `/tmp/flow-phase13-final-clean-j8e82iy7`. It excludes dependencies, build artifacts, Nx caches, Git metadata and environment/credential files. `pnpm install --offline --frozen-lockfile` succeeded without dependency changes, followed by `pnpm verify` **exit 0**. The working tree and clean copy matched across all 212 implementation/configuration files; later edits only finalize documentation and the recorded browser artifact.

| Native gate                         | Executed result                                                                  |
| ----------------------------------- | -------------------------------------------------------------------------------- |
| Format                              | PASS, all matched files conform                                                  |
| Lint/dependency closure             | PASS, including server/private/oracle boundaries                                 |
| Uncached builds                     | PASS, 21 projects; production Next build includes live/ready/metrics routes      |
| Typecheck                           | PASS, repository and operations app                                              |
| Unit/property                       | PASS, 84 tests across 14 Nx targets                                              |
| Runtime/dependency boundaries       | PASS, 5 tests                                                                    |
| Real PostgreSQL                     | PASS, 278 tests; 0 failed/cancelled/skipped/todo; 1,330.12 seconds               |
| Complete `pnpm verify`              | PASS, 367 total tests; clean disposable PostgreSQL, browser/server/pool cleanup  |
| Source equality and diff whitespace | PASS, 212 implementation/configuration files identical, `git diff --check` clean |

The real PostgreSQL gate includes populated migration-history/manifest checks, all earlier financial/concurrency/failure gates, narrow permissions, the new three-test observability suite and the unchanged production browser gate with Phase 13 extensions. Phase 11's 1,002-item/16-worker failure load reported zero invariant violations, duplicate effects and unrecovered work; local restart recovered all four items without duplicate effects. Financial assurance remained FAIL during load, correctly distinct from technical health.

Executed command families (all successful final runs):

```sh
pnpm install --offline --frozen-lockfile
pnpm verify
pnpm test:integration tests/observability.integration.test.ts
FLOW_PROFILE_READS=<local-report-path> pnpm test:integration tests/operations-browser.integration.test.ts
FLOW_PROFILE_LARGE=1 FLOW_PROFILE_READS=<local-report-path> pnpm test:integration tests/operations-browser.integration.test.ts
pnpm build
pnpm exec prettier --write docs/phase13/verification.md docs/phase13/profiles/production-browser.json
pnpm format:check
git diff --check
```

`<local-report-path>` denotes the actual temporary output path supplied to each profile run; the complete resulting artifacts are retained above. The independent working-directory `pnpm build` also passed uncached for all 21 projects; log: `/tmp/flow-phase13-workspace-build.log`. The final documentation-format check follows the report/artifact update. No commit, push or deployment is performed. Local final verification log: `/tmp/flow-phase13-final-clean-verify.log`; install log: `/tmp/flow-phase13-final-clean-install.log`; repaired focused gate: `/tmp/flow-phase13-observability-repaired.log`. The earlier failed/interrupted log remains `/tmp/flow-phase13-clean-verify.log` and is not used as a pass.

## Required 43-item completion report

| #   | Required item         | Result                                                                                                                                                                                                                                                           |
| --- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Files                 | Grouped manifest below; changes are limited to read-side batching, server observations/health, tests/profiles and phase documentation.                                                                                                                           |
| 2   | Dependencies          | None added; package/lock/workspace pins remain unchanged. Only phase13 formatting coverage changes package scripts.                                                                                                                                              |
| 3   | Baseline              | Exact Phase 12 dataset retained. Historical medians, interrupted reproduction and five-sample original/optimized comparison are all disclosed above.                                                                                                             |
| 4   | Profiling             | Full request/domain call graph, transport counts, live transaction function-counter deltas, full evidence equivalence, components and EXPLAIN ANALYZE/BUFFERS.                                                                                                   |
| 5   | Overview bottleneck   | Repeated full populations/payment proofs, growing control-document copies and retained independent sweep plus selected control freshness. Detailed exclusive/inclusive times above.                                                                              |
| 6   | Controls bottleneck   | Exact fresh-input manifest/proof work dominates bounded frozen-result retrieval; no per-control transport queries.                                                                                                                                               |
| 7   | Detail bottleneck     | Repeated allocation/current-proof/cause population expansion; frozen member projection itself is sub-millisecond.                                                                                                                                                |
| 8   | Query counts          | Five driver calls/read; ten for Overview/Controls plus choices, five for detail/Exceptions; five cheap readiness calls; zero liveness/metrics queries. Counts are structurally asserted.                                                                         |
| 9   | Plans                 | Full original/batched allocation, control freshness and scoped revision plans retained; actual/estimated rows, scans/joins/sorts and buffers disclosed above.                                                                                                    |
| 10  | Indexes               | None added/changed; no additional index write/storage cost or planner override.                                                                                                                                                                                  |
| 11  | Rewrites              | Scope-batched original proof predicate, shared active-item/cause/exposure context, array control assembly, per-invocation payment reuse and equivalent revision aggregate.                                                                                       |
| 12  | N+1                   | No application round-trip N+1; database-internal population repetition reduced from 226/85/30 to 28/12/3 calls per Overview/Controls/detail.                                                                                                                     |
| 13  | Request deduplication | No duplicated identical application reads found; no React request cache added. Identical domain reads reuse only invocation-local values.                                                                                                                        |
| 14  | Caching               | No cross-request cache. Original database state remains authoritative and every navigation observes fresh proof.                                                                                                                                                 |
| 15  | Materialized views    | None. No refresh/invalidation/stale financial projection introduced.                                                                                                                                                                                             |
| 16  | Integrity performance | Full sweep component 5,337.43 → 838.86 ms in the comparable profile. Coverage, independent history checks and UNKNOWN semantics unchanged.                                                                                                                       |
| 17  | Control freshness     | Full snapshot equality and original expiry remain; component 3,614.50 → 624.16 ms. No timestamp/version shortcut asserts current financial truth.                                                                                                                |
| 18  | Metrics               | Dependency-free Prometheus-compatible counters/read histogram; fixed operation/surface labels; dated scoped worker/control/integrity/exception/staleness projections. Not global financial totals.                                                               |
| 19  | Logging               | Structured allowlisted fields, stable classifications, slow indication; no SQL/binds/raw payload/oracle/secrets/stacks. Financial audit remains separate.                                                                                                        |
| 20  | Correlation           | Proxy replaces untrusted input with UUID; response header, server request context and approved read log carry the same identity. Never a financial command key.                                                                                                  |
| 21  | Health                | Zero-query liveness, bounded capability/connectivity readiness, separate existing financial assurance; FAIL/UNKNOWN does not make operators unable to access the app.                                                                                            |
| 22  | Slow operations       | OPS_SLOW_READ_MS integer 1..30000 (default 500); slow count and logs; operation names only.                                                                                                                                                                      |
| 23  | Pool                  | One lazy process pool, max four, 3-second acquisition/connect and 10-second idle bounds; fixed application name; release/discard checked in real PostgreSQL and production browser.                                                                              |
| 24  | Timeouts              | 30-second maximum SQL statement/idle bounds, driver deadline timeout+1000 ms; readiness SQL 1000/driver1200 ms; explicit unavailable response and destroyed stalled clients.                                                                                     |
| 25  | Dataset               | Seeds 71200–71203, 72/144 configured payments; 1,168/2,332 receipts, 204/408 revisions; exact/grouped, two currencies, exceptions, accepted risk, controls and worker failure history.                                                                           |
| 26  | Methodology           | Pinned local context, one warmup/five samples, median/nearest-rank p95; complete successful samples, no hard wall-clock optimization gate or production claim.                                                                                                   |
| 27  | Overview before/after | Profile original 8,965.43 → 1,457.00 ms median (83.75%); p95 1,564.23 ms. Preferred <1s unmet and limiting work explicitly documented.                                                                                                                           |
| 28  | Controls before/after | 3,672.65 → 679.85 ms median (81.49%); p95 682.70 ms. Preferred <500ms unmet and limiting work explicitly documented.                                                                                                                                             |
| 29  | Detail before/after   | 1,590.69 → 144.33 ms median (90.93%); p95 158.06 ms; preferred <500ms reached.                                                                                                                                                                                   |
| 30  | Other performance     | Canonical exposure 647.30 → 41.58 ms; Exceptions remains fast; two-times scale and direct revision-projection regression disclosed, no unsupported standalone speedup claim.                                                                                     |
| 31  | Tails                 | All five raw samples and nearest-rank p95 retained; five samples provide coarse local tail evidence, not a production percentile guarantee.                                                                                                                      |
| 32  | Memory                | Two production server RSS/high-water observations are recorded in the browser artifact; module warmup/limited samples do not prove leak freedom or production capacity.                                                                                          |
| 33  | Browser/server        | Production navigation, time to populated load and streamed TTFB, bundle bytes/chunks, safe log/metric checks and zero browser errors; page-composition timing is not full HTTP latency.                                                                          |
| 34  | Permissions           | Actual narrow login, owner/writer/raw-table/command and cross-book denial; helper PUBLIC EXECUTE revoked; readiness tests approved function capability.                                                                                                          |
| 35  | Oracle/boundaries     | Runtime/test/oracle/module closure and built client artifact inspections retained; route handlers consume the existing server-only boundary.                                                                                                                     |
| 36  | Resilience            | Full Phase 11 matrix, synchronized conflicts, backend failures, acknowledgment loss, fencing, load and local restart remain in the repaired native gate; final status recorded above.                                                                            |
| 37  | Production build      | Fresh clean uncached library/Next builds produce liveness/readiness/metrics routes; runtime browser uses only the narrow database URL.                                                                                                                           |
| 38  | Commands              | Executed command families and clean copy paths/logs above; formatting, lint, build, typecheck, units/boundaries and all PostgreSQL integration files through pnpm verify.                                                                                        |
| 39  | Full verification     | PASS, fresh source-only offline-installed checkout; 84 unit/property + 5 boundary + 278 real PostgreSQL tests = 367; zero failures/cancellations/skips.                                                                                                          |
| 40  | Architecture/ADRs     | Root status/workflow and architecture operations/overview docs updated for actual Phase 13 behavior. ADR-016 unchanged; no new consequential architectural policy/ADR.                                                                                           |
| 41  | Risks                 | Trusted DB owners, localhost/internal access, dated mixed last-observed scopes, coarse tails, sparse memory sampling, full-evidence scaling and unmet preferred Overview/Controls targets.                                                                       |
| 42  | Deferred              | Phase14, real processor/bank integration, cloud/deployment, AI, public UI/production identity, web financial mutations/manual matching/requeue, new products/accounting, 1:N/N:M/partials, brokers/queues, hosted telemetry and durable caching/materialization. |
| 43  | Acceptance            | All fifty criteria satisfied within the documented local/synthetic scope, including full repaired clean regression gates. Preferred local Overview/Controls targets remain unmet; measured improvements and limiting factors meet criteria 38–40.                |

## File manifest

- `apps/ops/app/health/live/route.ts`
- `apps/ops/app/health/ready/route.ts`
- `apps/ops/app/metrics/route.ts`
- `apps/ops/proxy.ts`
- `apps/ops/server/telemetry.ts`
- `database/migrations/012_read_proof_batching.sql`
- `docs/phase13/README.md`
- `docs/phase13/profiles/before-after.json`
- `docs/phase13/profiles/larger.json`
- `docs/phase13/profiles/production-browser.json`
- `docs/phase13/verification.md`
- `libs/operations-read-postgres/src/telemetry.ts`
- `libs/operations-read-postgres/test/telemetry.test.ts`
- `tests/helpers/previous-read-definitions.ts`
- `tests/helpers/profile-reads.ts`
- `tests/helpers/read-delay-proxy.ts`
- `tests/observability.integration.test.ts`
- `AGENTS.md`
- `README.md`
- `apps/ops/server/page.tsx`
- `apps/ops/server/read.ts`
- `docs/architecture/README.md`
- `docs/architecture/verification-and-operations.md`
- `libs/operations-read-postgres/src/index.ts`
- `package.json`
- `tests/operations-browser.integration.test.ts`
- `tools/oracle-boundary.mjs`
- `tools/test-postgres.ts`

## Acceptance mapping

| Criteria | Evidence / result                                                                                                                                             |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1–9      | Comparable original/optimized profiles, function counts/components/plans, structural driver count checks; no new index to justify                             |
| 10–15    | Full original/optimized evidence comparisons, retained witnesses and unchanged exact-money/currency/canonical-exposure/accepted-risk tests                    |
| 16–22    | Correlated safe JSON logs, bounded metric property test, dated authoritative worker/control/integrity projections; production route/log checks                |
| 23–28    | Distinct health meanings, failed readiness while live, financial FAIL/UNKNOWN readiness, bounded pool, real SQL/transport deadlines and cleanup               |
| 29–31    | Client artifacts, transitive server/private/oracle gates and actual capability/raw/command/cross-book denials                                                 |
| 32–33    | PASS, full unchanged Phase 1–12/native Phase11 regression suite in repaired clean verification                                                                |
| 34–40    | Deterministic comparable and doubled fixture; all samples/medians/coarse tails, improvements and precisely documented remaining work, no SLA claim            |
| 41–42    | Exact populated upgrade snapshots/history/work plus retained witness; immutable completed inputs/results/allocations and original predicate/snapshot controls |
| 43–48    | No dependency/infrastructure/integration/product/AI/web mutation added; change scope inspected                                                                |
| 49       | Fresh production build and actual restricted browser/routes/client artifact gates                                                                             |
| 50       | PASS, repaired full clean pnpm verify exit 0, 367 tests, zero failed/cancelled/skipped                                                                        |
