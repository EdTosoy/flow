# Phase 12 verification record

Date: 2026-10-08. Scope: local/internal read-only Next.js operations application over the supported synthetic Phase 1–11 PostgreSQL system. Phase 13 is not started. **Phase 12 complete: all 48 acceptance criteria PASS within this explicitly local/read-only scope.** Clean frozen install and full native verification passed; no production authentication/deployment/readiness claim.

## Required report

| #   | Requested field          | Implemented / evidence                                                                                                                                                                                                                                              |
| --- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Files                    | apps/ops application/components/server/tests/instructions; operations-read-postgres package/tests/instructions; additive migration 011; public demo provisioner; read/browser/boundary tests; workspace/gate/runner/docs changes. Final manifest below.             |
| 2   | Dependencies             | Next 16.4.0, React/React DOM 19.3.0, server-only 0.0.1, matching React types; test-only Playwright 1.63.0. Existing pg/Money/integrity reused. No UI/chart/state/auth framework.                                                                                    |
| 3   | Application architecture | One App Router app, Server Components, minimal error-retry client, localhost-only dev/start. No separate NestJS service.                                                                                                                                            |
| 4   | Read model               | Versioned approved reads; parameterized PostgreSQL allowlist; each approved read in READ ONLY REPEATABLE READ; owning domain summaries/calculations reused.                                                                                                         |
| 5   | Permissions              | flow_operations_reader: usage/one execute only, no table select/write or domain/worker command memberships. Adapter refuses owner/writer/unsafe role.                                                                                                               |
| 6   | Server/client            | server-only markers, Nx/module/transitive closure guards, built static chunk inspection; presentation contains no SQL.                                                                                                                                              |
| 7   | Routes                   | Overview, reconciliation list/detail, exceptions list/detail, controls list/result detail, workers list/attempt detail, integrity.                                                                                                                                  |
| 8   | Overview                 | Current sweep financial/structural status, subsystem checks, open cases/terminal work, explicit frozen evaluation/exposure and timestamps.                                                                                                                          |
| 9   | Reconciliation summary   | Frozen side populations/outcomes, exact/grouped counts and current proof; no invented global latest selection or unsafe combined money.                                                                                                                             |
| 10  | Exposure                 | Phase 9 canonical per-mapping/currency totals, accepted-risk subset, source claims and unique residual; NULL/ambiguity/overlap remains UNKNOWN.                                                                                                                     |
| 11  | Exceptions               | Validated queue filters, assignment, age/activity, item value/non-additive label, financial-vs-operational state, immutable history/notes/evidence/control links.                                                                                                   |
| 12  | Reconciliation detail    | Versioned rule/window/hash, bounded frozen members, processor/bank/revision/reference/history identifiers, established discrepancy, whole group contribution/current proof.                                                                                         |
| 13  | Controls                 | Evaluation/version/time/current reason, PASS/FAIL/UNKNOWN/category/currency filters; exact expected/observed/discrepancy/unit and evidence/linked cases.                                                                                                            |
| 14  | Workers                  | Counts, oldest pending, bounded metadata/state/attempts/retry/lease recovery, safe failure class/code and append-only attempt history; no payload or requeue.                                                                                                       |
| 15  | Integrity                | Independent current engineering sweep, financial uncertainty and supported structural checks; no tamper-proof/HA claim. Unavailable execution is explicit.                                                                                                          |
| 16  | Status                   | Text/symbol/color distinctions; UNKNOWN has dedicated amber/question semantics, never zero/success.                                                                                                                                                                 |
| 17  | Money                    | Exact minor-unit strings and metadata scale formatting; bigint count-percentage helper; no unsafe monetary Number conversion.                                                                                                                                       |
| 18  | Currency                 | Separate PHP/USD fields/rows and no FX sum. Browser/read tests exercise both currencies.                                                                                                                                                                            |
| 19  | Pagination               | 50 default/100 maximum; tuple created/start-time+UUID, control keys, member IDs and history versions; precision-preserving cursors. No OFFSET.                                                                                                                      |
| 20  | Filters/search           | Validated UUID equality and enum selections; no payload LIKE scan or interpolated request SQL.                                                                                                                                                                      |
| 21  | Freshness                | Query/sweep/frozen/completed timestamps and domain current reason; historical values do not look live.                                                                                                                                                              |
| 22  | Refresh                  | Dynamic server navigation plus manual full-page refresh; no polling/streaming infrastructure.                                                                                                                                                                       |
| 23  | Empty/errors             | Fresh books/unselected population UNKNOWN; malformed scope/foreign entity/unavailable query explicitly non-green; safe browser errors.                                                                                                                              |
| 24  | Auth scope               | Local/internal, localhost binding, production identity/authorization/TLS deferred. Valid book input is not a claim of operator authorization.                                                                                                                       |
| 25  | Accessibility            | Semantic landmarks/headings/tables, labels, textual statuses, keyboard skip/focus/navigation; production smoke verifies skip link.                                                                                                                                  |
| 26  | Responsive               | Desktop density plus adaptive navigation/cards and table-contained overflow; 640px browser smoke.                                                                                                                                                                   |
| 27  | Styling                  | Native CSS/system fonts, reusable status/number/time/table/evidence components; no remote assets/UI framework.                                                                                                                                                      |
| 28  | Charts                   | None; exact scoped tables/counts are clearer for this boundary.                                                                                                                                                                                                     |
| 29  | Queries/indexes          | Approved direct projections reuse existing indexes/functions; actual EXPLAIN ANALYZE/BUFFERS for core list/member queries. No new indexes/denormalized truth.                                                                                                       |
| 30  | Demo                     | Public deterministic simulator artifacts → existing worker/domain pipeline → recon/cases/controls/integrity; audited synthetic risk and persisted named retry/poison demonstrations.                                                                                |
| 31  | Security                 | No raw payloads/errors/secrets/owner credentials; safe logging, headers, parameter validation, runtime/oracle/privileged closure and static artifacts. Local inline hydration CSP is explicitly not production nonce policy.                                        |
| 32  | Permission tests         | Actual restricted login denies raw reads, financial DML, schema creation, ledger/recon/exception/control/worker functions; rejects owner and foreign-book detail.                                                                                                   |
| 33  | Unit/read tests          | Exact large/currency/sign/UNKNOWN and 1,000 property trials; render/error/risk/escaped notes; PG counts/canonical risk/pagination/filter/freshness/history.                                                                                                         |
| 34  | Browser                  | Production Chromium on deterministic data, navigation/drill-down, UNKNOWN/FAIL/terminal, malformed/empty, keyboard, narrow screens, console/runtime error assertions.                                                                                               |
| 35  | Boundary/oracle          | Existing gates retained plus client static/dynamic/transitive/private-tool/server-writer denial; built chunk forbidden strings checked.                                                                                                                             |
| 36  | Production build         | PASS: strict scoped and clean-native uncached production builds; all three data route shapes dynamic.                                                                                                                                                               |
| 37  | Performance              | 1,168 receipts / 204 revisions / four mappings and two currencies; three-sample read medians and actual core-query plans below.                                                                                                                                     |
| 38  | Commands                 | Install, Chromium setup, production build, strict checks, targeted read/browser/unit/boundary tests, full native verify; exact commands below.                                                                                                                      |
| 39  | Verification             | PASS: clean frozen install/full native verify; 362 unique tests (87 unit/property/boundary + 275 PostgreSQL), 19,490 configured property trials, zero failures/skips; all Phase 1–11 gates retained. Earlier failed fixtures/host/timeout findings disclosed below. |
| 40  | Architecture             | ADR-016 accepted read-only app instead of extra API; ADR-001/overview/status/operations links clarified. No financial invariant change.                                                                                                                             |
| 41  | Risks                    | Trusted provisioners/owners, local/internal auth scope, supported population limits, expensive freshness/sweeps, snapshot-per-read, possibly newer auxiliary navigation lists, no pagination-wide snapshot.                                                         |
| 42  | Deferred                 | Phase 13, web mutations/manual matching/requeue, real integrations, cloud, AI, new accounting, public UI, new queues, production identity/deployment.                                                                                                               |
| 43  | Acceptance               | All 48 criteria PASS within the precise local/read-only scope. No criterion weakened; Phase 13 not begun.                                                                                                                                                           |

## Executed findings and corrections

- Initial read migration omitted the customary final RESET ROLE, preventing migration bookkeeping. Corrected only the new unapplied migration. Populated upgrade subsequently preserved prior truth/work exactly.
- Initial JSX tests used the root compiler's classic JSX defaults; the app test target now uses the app's actual JSX configuration. Three presentation tests passed, including 1,000 exact formatting trials.
- Current Next framework declaration names required ESNext type libraries and two type-only URLPattern aliases with the pinned Node 24/TypeScript 5.9 types. Strict library checking remains enabled; no skipLibCheck/ignoreBuildErrors was introduced.
- Initial browser boundary rule incorrectly rejected the intentional Server Component page→server composition edge. It now permits only non-client page wrappers while checking transitive client reachability and requiring server-only in server modules; server folders cannot bypass the rule with use client.
- Restricted-role tests revealed work detail could return another book's attempt metadata when the work header was absent. The approved function now rejects absent/foreign work before reading attempts; explicit cross-book test passes. No existing financial runtime defect or guarantee change.
- First public dataset attempted 200 individual settlement matches and hit the existing 30-second reconciliation transaction deadline. Deadline/gates are preserved; the workload uses many receipts with smaller settlement populations. No scale claim beyond the measured scope.
- Generic downloaded Chromium cannot execute directly on NixOS. The existing system Chromium launches; harness supports an explicit executable or detected system Chromium, otherwise the managed browser. No browser skip fallback.
- A clean offline install lacked pinned Playwright packages. The frozen registry install completed without changing the lockfile. Next-generated type imports required excluding the generated file from source formatting; strict type/build checks remain enabled.
- Latest Playwright 1.64 triggered the dependency-age policy. Final pin 1.63 uses mature packages and no policy exceptions; existing policies remain intact.

## Acceptance mapping

| Criteria | Evidence                                                                                               |
| -------- | ------------------------------------------------------------------------------------------------------ |
| 1–5      | Next app, server-only approved read package, narrow real role, no duplicate financial calculation      |
| 6–12     | Overview/status/control selection/canonical exposure/risk/currency/UNKNOWN read and presentation tests |
| 13–21    | Case/run/group/control/worker/integrity investigation surfaces, immutable and current distinctions     |
| 22–28    | Exact Money, currencies, bounded parameterized paging/filtering, error/freshness/empty states          |
| 29–32    | Oracle/client capability/static-artifact gates and restricted-role permission tests                    |
| 33–40    | Core production navigation/accessibility/build/public demo/render/browser/performance evidence         |
| 41       | Unchanged full Phase 1–11 native verification PASS (all old gates/tests retained)                      |
| 42–48    | No UI resolution/matching/requeue; no real integration/cloud/AI/new broker                             |

## Commands executed

Skills applied: implement-feature, repository verify-financial-change, and verify-changes. Root/applicable nested instructions, Phase 8–11 reports, financial architecture/ADRs, roles, migration state and clean baseline were inspected before edits.

```sh
pnpm view next version
pnpm view react version
pnpm view @types/react version
pnpm view @types/react-dom version
pnpm view @playwright/test version
pnpm view next@16.4.0 peerDependencies
pnpm install --no-frozen-lockfile
pnpm install --offline --frozen-lockfile # first clean attempt: missing cached packages
pnpm install --frozen-lockfile # clean source copy: PASS, final lock unchanged
pnpm exec playwright install chromium
pnpm exec prettier --write <changed files>
pnpm --filter @flow/ops typecheck
pnpm exec tsc -p tsconfig.check.json --noEmit
pnpm --filter @flow/ops build
pnpm exec tsx --tsconfig apps/ops/tsconfig.json --test apps/ops/test/presentation.test.tsx
pnpm exec tsx --test libs/operations-read-postgres/test/index.test.ts
pnpm test:integration tests/operations.integration.test.ts
pnpm test:integration tests/operations.integration.test.ts tests/operations-browser.integration.test.ts
pnpm test:boundaries
NX_DAEMON=false NX_ISOLATE_PLUGINS=false pnpm lint
pnpm typecheck
pnpm build
# In an isolated source-only /tmp copy (dependencies/artifacts/secrets excluded):
NX_DAEMON=false NX_ISOLATE_PLUGINS=false NEXT_TELEMETRY_DISABLED=1 pnpm verify
# Shared workspace aligned with the final lock using cached packages:
pnpm install --offline --frozen-lockfile
git diff --check
```

No commit, push, production deployment or external financial resource operation. All containers/processes are locally owned test resources. Production/read/browser measurements, final regression completion and the full file manifest are recorded below. Final non-documentation source matches the clean tested source copy byte-for-byte (44 changed/new source/config files).

## Final executed gates

| Gate                                         | Result                                                                                                                                                                                     |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Clean source-only copy / frozen pnpm install | PASS; all 22 workspace projects; final lockfile unchanged                                                                                                                                  |
| Format                                       | PASS; all prior source/report patterns retained, TSX/CSS/Phase 12 added; only new Next-generated files ignored                                                                             |
| Lint / dependency graph / oracle manifests   | PASS; all actual 21 library/application package manifests checked; generated build manifests excluded                                                                                      |
| Production build                             | PASS; 21 uncached build targets, 45.5 seconds total; Next App Router data routes dynamic                                                                                                   |
| Strict financial and application typecheck   | PASS; no skipLibCheck, ignoreBuildErrors or old check exclusions                                                                                                                           |
| Unit/property + boundary gates               | PASS; 14 unit targets and five boundary tests; 87 unique unit/property/boundary tests total                                                                                                |
| Real PostgreSQL / populated upgrades         | PASS; all migrations through 011, populated financial/work preservation; 275 tests, zero failures/cancellations/skips, 1,469.52 seconds                                                    |
| New PostgreSQL reads/permissions             | PASS; four canonical exposure/risk/UNKNOWN/count/filter/pagination/freshness/capability/history tests                                                                                      |
| Production browser + benchmark               | PASS; one public-data scenario, all six navigation surfaces, drill-down/errors/UNKNOWN/keyboard/narrow-screen/runtime/artifact assertions                                                  |
| Existing Phase 1–11 resilience and load      | PASS; real deadlocks/serialization/backend termination/commit-ack loss, frozen/correction/case/control races, roles/history/oracle, workers/leases/fencing/restart and load remain enabled |
| Final source equivalence / diff              | PASS; all 44 non-documentation changed/new files match the clean verified copy; no financial runtime/applied migration edited; whitespace check passed                                     |

Unique test total is **362**, including ten new tests: one read validation unit, three presentation/property tests, one boundary test, four PostgreSQL read tests and one production browser/benchmark scenario. Repeated focused executions are not counted as additional tests. Configured property trials are **19,490**: the unchanged Phase 1–11 total of 18,490 plus 1,000 exact display trials (seed 71212). Existing database failure hooks remain test-only and unchanged.

Retained load observations in this full run: Phase 11 processed 1,002 work items with sixteen workers, 250 transient failures and 25 expirations; 1,000 healthy items succeeded and two poison items remained terminal. Drain throughput 141.86 jobs/sec; zero invariant violations, duplicate effects or unrecovered work. Local single-node restart recovery measured 4.91 seconds. Phase 10's unchanged 1,000-item / sixteen-worker / fifty-retry benchmark also passed at 116.27 jobs/sec. These are regression observations, not new throughput promises or production HA claims.

The full native verify command exited **0**. No old test was removed, skipped, weakened or given a larger financial deadline. After final documentation/screenshot recording, source formatting and whitespace checks are repeated; application/financial code is identical to the tested clean copy. Cleanup PASS: no remaining disposable Docker container, owned Next.js process, or clean-copy worker process.

## Local performance and browser observations

Clean production run: Next 16.4.0 / React 19.3.0 / Node 24.21.0 / pnpm 11.27.0, PostgreSQL 18.6, Linux 6.18.53 x86_64 on an Intel Core i7-8700B (12 available hardware threads, approximately 35 GiB host memory). PostgreSQL runs in the native disposable Docker container with fsync/synchronous_commit enabled, after earlier regression populations. This is a local single-node observation, not an internet-scale or production SLA.

The public deterministic fixture uses seeds 71200–71203, 72 configured payments across four account mappings, an explicit synthetic USD variant, unchanged delivery replays, healthy exact and grouped matches, missing/duplicate/wrong-amount evidence, audited accepted risk and labelled worker retry/poison injection. It yields **1,168 immutable receipts and 204 distinct source revisions**. The larger receipt count represents repeated deliveries rather than 1,168 unique economic items. Settlement populations remain bounded by the existing transaction deadlines.

| Approved read                                            | Median of three completed calls |
| -------------------------------------------------------- | ------------------------------: |
| Overview (current sweep plus selected frozen controls)   |                     9,713.43 ms |
| Exception list                                           |                         4.94 ms |
| Reconciliation detail                                    |                     1,614.40 ms |
| Controls list (includes authoritative freshness summary) |                     3,857.46 ms |

The benchmark inspects actual EXPLAIN ANALYZE/BUFFERS core projection predicates: exceptions 0.102 ms / four rows; controls 0.101 ms / first 51 rows; run members 0.042 ms / twelve rows; workers 1.302 ms / 35 rows. Control-key and frozen-member primary-key indexes are used; small book-scoped case/work populations use scans and joins/sorts. These inexpensive core plans **exclude the expensive domain-summary/sweep internals** and do not explain away the full read latency. No new index or denormalized financial result is justified by these measurements. Further performance work must preserve frozen/current semantics and independent verification.

Production Chromium 153.0.8010.52 completed the combined fixture/read/plan/browser scenario in 178.94 seconds. All six navigation sections and case/run drill-downs worked; UNKNOWN and FAIL remained visible; terminal poison metadata remained queryable. Malformed input, empty-book UNKNOWN and actual revoked-read permission produced distinct correct states. Keyboard skip-to-main and 640px contained overflow passed. There were **zero browser runtime/console errors**. All **23 built client JavaScript chunks** passed the database/oracle/credential-identifier inspection. The captured screenshot is actual queried synthetic state, with financial assurance FAIL and separate structural PASS; no fabricated counts or private labels.

## File manifest

Created (38):

- `apps/ops/AGENTS.md`
- `apps/ops/app/[section]/[id]/page.tsx`
- `apps/ops/app/[section]/page.tsx`
- `apps/ops/app/error.tsx`
- `apps/ops/app/global.css`
- `apps/ops/app/layout.tsx`
- `apps/ops/app/loading.tsx`
- `apps/ops/app/page.tsx`
- `apps/ops/components/common.tsx`
- `apps/ops/components/filters.tsx`
- `apps/ops/components/format.ts`
- `apps/ops/components/model.ts`
- `apps/ops/components/shell.tsx`
- `apps/ops/components/views.tsx`
- `apps/ops/next-env.d.ts`
- `apps/ops/next-platform.d.ts`
- `apps/ops/next.config.mjs`
- `apps/ops/package.json`
- `apps/ops/project.json`
- `apps/ops/server/page.tsx`
- `apps/ops/server/read.ts`
- `apps/ops/test/presentation.test.tsx`
- `apps/ops/tsconfig.json`
- `database/migrations/011_operations_reads.sql`
- `docs/architecture/adr/016-operations-read-application.md`
- `docs/phase12/README.md`
- `docs/phase12/screenshots/overview.png`
- `docs/phase12/verification.md`
- `libs/operations-read-postgres/AGENTS.md`
- `libs/operations-read-postgres/package.json`
- `libs/operations-read-postgres/project.json`
- `libs/operations-read-postgres/src/index.ts`
- `libs/operations-read-postgres/test/index.test.ts`
- `libs/operations-read-postgres/tsconfig.json`
- `tests/operations-boundaries.test.ts`
- `tests/operations-browser.integration.test.ts`
- `tests/operations.integration.test.ts`
- `tools/ops-demo.ts`

Modified (18):

- `.gitignore`
- `.prettierignore`
- `AGENTS.md`
- `README.md`
- `docs/architecture/README.md`
- `docs/architecture/adr/001-modular-monolith.md`
- `docs/architecture/adr/README.md`
- `docs/architecture/verification-and-operations.md`
- `eslint.config.mjs`
- `package.json`
- `pnpm-lock.yaml`
- `pnpm-workspace.yaml`
- `tools/check-oracle-dependencies.mjs`
- `tools/oracle-boundary.mjs`
- `tools/test-postgres.ts`
- `tsconfig.base.json`
- `tsconfig.check.json`
- `tsconfig.json`

No applied Phase 1–11 migration, existing financial runtime package, public simulator generator, prior verification report or existing correctness assertion was edited. New formatter ignores cover only Next-generated artifacts/type declarations; oracle manifest discovery ignores build output while checking all actual workspace packages.
