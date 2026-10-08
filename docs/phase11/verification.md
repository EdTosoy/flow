# Phase 11 verification record

Date: 2026-10-08. Scope: supported synthetic Phase 1–10 system, disposable local PostgreSQL 18.6. **Phase 11 complete: all 46 applicable acceptance criteria passed within the documented synthetic/local scope.** Phase 12 was not started. This is not production approval or HA/disaster-recovery evidence.

## Required report

| #   | Requested evidence      | Implementation / executed scope                                                                                                                                                                                                                                                                                      |
| --- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Files                   | Additive 010 integrity migration; integrity-postgres package; CLI; test-only resilience harness; three resilience suites; Phase 11 docs. Update runner, fixture/sweep hooks, five prior integration suites, boundary checks, package/TS/Nx configuration and status links. Exact manifest below.                     |
| 2   | Dependencies            | No external dependency/version added. One read-only workspace package reuses pinned pg.                                                                                                                                                                                                                              |
| 3   | Harness                 | Real-client boundary interception, partial-write SQL triggers, actual TCP ack-drop proxy, observed lock barriers, retained-row witnesses, deadline-bounded process/restart operations.                                                                                                                               |
| 4   | Sweep design            | Independent READ ONLY REPEATABLE READ, scoped SECURITY DEFINER read, existing control calculations plus structural queries, no domain writes.                                                                                                                                                                        |
| 5   | Invariants              | Ledger balance/companions/semantic effects; raw/processing partition/intent; processor/bank controls; frozen reconciliation coverage and allocation conservation/uniqueness; exception chain/proof/companions; control inputs/results/reproducibility; canonical exposure; work registration/state/history/recovery. |
| 6   | Financial crash matrix  | Eight representative operations × five client boundaries plus real partial-write trigger, actual COMMIT-ack loss and unchanged replay; sweep/witness after failure and recovery.                                                                                                                                     |
| 7   | Backend termination     | New ledger/allocation/control kills after writes, worker fenced-handler kill; all earlier domain backend-death cases retained.                                                                                                                                                                                       |
| 8   | Deadlock                | Real two-session advisory-lock cycle around ledger posting; at least one whole transaction aborted, bounded adapter retry or explicit caller replay; two distinct commands, one effect each. Original genuine Phase 1 deadlock retained.                                                                             |
| 9   | Serialization           | Genuine REPEATABLE READ concurrent run update: exactly two whole freeze attempts, unchanged run identity; original 40001/40P01 injection tests retained.                                                                                                                                                             |
| 10  | Ingestion/normalization | Eight observed contenders import duplicate/corrected bytes; eight raw receipts, two revisions/interpretations, no authoritative unordered choice. Original ingestion/version concurrency properties remain enabled.                                                                                                  |
| 11  | Evidence-arrival races  | Both processor and bank arrival after snapshot establishment; one original frozen member per side, later population two/ambiguity, immutable history; correction vs current run/control.                                                                                                                             |
| 12  | Exact/grouped           | Existing observed eight-worker alternating 1:1/N:1 overlapping runs, now independent after-scenario sweep; one whole reservation set.                                                                                                                                                                                |
| 13  | Group contention        | Existing duplicate bank/overlapping declarations and synchronized overlapping groups remain ambiguous; global allocation barrier and sweep.                                                                                                                                                                          |
| 14  | Exception races         | Two resolutions; resolution vs CLASSIFY/ASSIGN; resolve vs valid REOPEN and SUPERSEDE/precondition rejection; original review/generation races retained; immutable expected-version history.                                                                                                                         |
| 15  | Control races           | Source/reconciliation/accepted-risk races retained with sweeps; new worker normalization freeze records coherent old pending state, then reports stale rather than rewriting.                                                                                                                                        |
| 16  | Exposure races          | Accepted risk vs reconciliation completion vs control freeze; canonical components, no case addition; prior unique pair residual/subset and unknown-overlap controls swept.                                                                                                                                          |
| 17  | False green             | Original independently expected 10,000/received 9,998 and mismatching bank closing despite valid matches; new all work success with source UNKNOWN; pure status properties never hide non-green evidence.                                                                                                            |
| 18  | Retry storm             | 250 durable TRANSIENT/08006 failures in 1,002-item load; retained history, bounded attempts, healthy drainage. Fault classification is deliberately injected, not 250 naturally occurring network failures.                                                                                                          |
| 19  | Lease churn             | Repeated actual DB-clock expiry/reclaim, monotonic attempts/new tokens, stale domain/finish rejection, one interpretation after omitted acknowledgement.                                                                                                                                                             |
| 20  | Poison isolation        | Two malformed committed intent envelopes terminal; 1,000 healthy intents succeed; no hot retry loop, pending poison raw evidence remains explicit.                                                                                                                                                                   |
| 21  | Process restart         | Existing CLI exited claimant/concurrent processes/graceful active shutdown retained. New separate CLI recovers after real local database restart and prior domain COMMIT.                                                                                                                                            |
| 22  | Database scope          | Docker clean-shutdown single-node restart on pinned localhost port, outstanding uncommitted claim rolled back, idle connections discarded, new queries/process reconnect. No HA/storage-loss claim.                                                                                                                  |
| 23  | Migration/recovery      | Exact populated 1–10 upgrade checks; 010 preserves work and prior truth; existing compatible work processes; affected books sweep; prior immutable rows retained.                                                                                                                                                    |
| 24  | Corruption              | Rollback-only ledger imbalance, missing completed outcomes, bad allocation contribution, missing attempt events and deliberately inconsistent exposure evaluator; sweep detects IDs; ROLLBACK restores guards/functions/history.                                                                                     |
| 25  | Roles                   | Real non-superuser integrity role cannot read raw evidence or invoke/write any worker/domain operation; worker/reconciliation/exception/control DML attacks rejected. Existing capability tests retained.                                                                                                            |
| 26  | History attacks         | Owner ordinary SQL cannot alter ledger, raw, reconciliation, exception, controls or original outbox payload; retained-row witness survives. Explicit owner/superuser trigger bypass is outside runtime prevention.                                                                                                   |
| 27  | Cross-module result     | New major failures/races use clean(book) sweeps; existing reconciliation/grouped/exception/control/worker tests install after-scenario sweeps. Financial FAIL/UNKNOWN remains a valid explicit outcome.                                                                                                              |
| 28  | Replay                  | Fixed property/scenario identities and existing simulator golden seeds; logical effects/dispositions reproducible, UUID/time/scheduler winner not claimed identical.                                                                                                                                                 |
| 29  | Oracle isolation        | Runtime integrity depends only on pg; Nx denies writer/oracle imports; import guard now rejects all test harnesses and migration runner from runtime; explicit new probes. Earlier transitive/public-artifact gates unchanged.                                                                                       |
| 30  | Recovery measurements   | DB-clock old-expiry→new STARTED delay plus local backlog drain and database restart-to-clean recovery; final observations below, no SLA.                                                                                                                                                                             |
| 31  | Failure load            | 1,002 real durable requests, sixteen workers, 250 transient failures, 25 expirations, two poisons; throughput/latency/PG counters/RSS and zero violations/duplicates/unrecovered work.                                                                                                                               |
| 32  | Isolation               | Finally rollback/drop/release/join/end/close; only owned container; explicit pinned ephemeral port; bounded child/connection/SQL deadlines.                                                                                                                                                                          |
| 33  | Hook safety             | Pool interceptors/triggers/witnesses live only under tests; no runtime failure flags; all test/migration-runner imports denied to runtime.                                                                                                                                                                           |
| 34  | Health summary          | pnpm integrity emits structural/financial status, ledger/source/processing/processor/bank/reconciliation/allocation/exposure/worker checks and open counts; invariant violations include safe IDs/scope/evidence.                                                                                                    |
| 35  | Commands                | Frozen install, scoped Prettier, strict typecheck/lint, targeted PostgreSQL suites, clean source-copy install/full native verify; final list below.                                                                                                                                                                  |
| 36  | Verification            | PASS: clean frozen install/full native verify, 352 unique tests (82 unit/property/boundary + 270 PostgreSQL), zero failures/skips; final test-only assertion strengthening additionally passed 29 tests in the clean copy.                                                                                           |
| 37  | Architecture/ADRs       | No ADR decision changes or new ADR. Add implementation/operation/status links; no financial invariant weakened.                                                                                                                                                                                                      |
| 38  | Assumptions             | Trusted synthetic source contracts/provisioners/owners; local single node; bounded supported populations; current sweep not historical tamper proof; financial uncertainty and intentional terminal failures remain visible.                                                                                         |
| 39  | Deferred                | Phase 12 and every excluded UI/integration/cloud/AI/accounting/product/queue/streaming/N:M functionality; no production readiness/HA/DR, scheduling/alerts, manual retry or financial repair command.                                                                                                                |
| 40  | Acceptance              | All 46 applicable criteria PASS, with the precise synthetic/local failure scope and documented deliberate uncertainty/deferrals.                                                                                                                                                                                     |

## Executed verification

Early focused crash suite: twenty passed/two failed test fixtures. Corrections: the freeze holder needed REPEATABLE READ; a monotonic-attempt property incorrectly compared different work items. Final core/restart run passed thirty tests, zero failures/skips, in 63.26 seconds. It includes all eight matrices, actual backend deaths, genuine deadlock/serialization, races, rollback probes, roles/history and thirty database property schedules. Initial load passed with 1,002 items/250 transient failures/25 expirations/two terminal poisons; the final full-run observations are recorded below.

An initial anonymous Docker port changed during restart, causing subsequent test connections to use a closed endpoint. The stalled child was stopped and the runner cleaned its own container. The runner now explicitly pins a reserved localhost port; final local restart passed (4,620.96 ms to recovery in the scoped run). Test connection/query/child waits are bounded. This was a harness defect, not a financial correctness defect. No failure is waived or labeled pre-existing. Offline install initially lacked pnpm policy metadata; ordinary pinned frozen install refreshed it. No new dependency was downloaded or upgraded intentionally.

Final clean full native verification PASS, exit 0. The final crash-recovery tests then added explicit work-drain assertions and a successful-work/UNKNOWN financial-assurance assertion. Those test-only changes passed strict typecheck/scoped lint and all 29 core tests in the same clean copy. Runtime implementation/migration are unchanged. All 161 non-Markdown source/configuration files match that copy exactly.

## Acceptance mapping

| Criteria | Evidence                                                                                                                       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 1–3      | Reusable independent sweep, cross-domain structural/control queries, after-scenario checks/witnesses                           |
| 4–5      | Eight transaction matrices, real partial-write aborts, actual COMMIT acknowledgement drops and unchanged semantic replay       |
| 6–8      | Actual backend termination, real deadlock, genuine REPEATABLE READ 40001 whole-stage retry                                     |
| 9–10     | Synchronized duplicate/corrected acquisition and interpretation; immutable provenance and ambiguity                            |
| 11–14    | Both arrival sides, correction/freshness race, original synchronized 1:1/N:1 and overlapping grouped ambiguity tests now swept |
| 15–18    | Reviewer/metadata/reopening/supersession/risk races; coherent control snapshots; canonical exposure                            |
| 19–20    | Missing independently expected source population and bad aggregate closing remain non-green                                    |
| 21–23    | Retry storm, lease churn/fencing, poison/healthy load                                                                          |
| 24–26    | Actual process invocations, local database restart/reconnect and populated 1–10→11 upgrade/backlog                             |
| 27–30    | Rollback-only corruption, actual capability denials/owner history attacks, independent sweep hooks                             |
| 31–34    | Oracle/transitive/harness dependency guards, deterministic property seeds, observed contention, no production fault hooks      |
| 35–37    | Recovery/backlog measurements, failure load, no outstanding healthy recoverable work                                           |
| 38–40    | Exactly one semantic effect on replay, conservative reconciliation, retained immutable-row witnesses                           |
| 41       | PASS: clean full native Phase 1–10 regressions, 270 PostgreSQL tests; all prior gates retained                                 |
| 42–46    | Source/dependency scope: no frontend, real integrations, cloud, AI or new queue/broker                                         |

## Final executed gates

Independent clean source: `/tmp/flow-phase11-clean-gEQfDs`. Full log: `/tmp/flow-phase11-clean-verify.log`; frozen install log: `/tmp/flow-phase11-clean-install.log`; final assertion follow-up: `/tmp/flow-phase11-final-core.log`. Copy excludes dependencies, Nx/build/Git artifacts, private agent/credential directories and environment files. Offline frozen installation reused all 408 pinned packages with zero downloads. Node 24.21.0, pnpm 11.27.0, pg 8.23.1, fast-check 4.10.2 and pinned PostgreSQL 18.6; fsync/synchronous_commit on. No gate was skipped or weakened.

| Gate                                           | Executed result                                                                                                                     |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Clean frozen offline install                   | PASS, exit 0; twenty workspace projects, no dependency upgrades                                                                     |
| Native format/lint/oracle closure              | PASS, zero warnings; nineteen runtime/oracle packages checked                                                                       |
| Uncached builds/strict typecheck               | PASS; nineteen library builds                                                                                                       |
| Unit/property/boundary                         | PASS; twelve unit suites: 78 tests, plus four boundary tests = 82; counts confirmed from native Nx terminal outputs                 |
| PostgreSQL/full regression                     | PASS; 270 tests, zero failures/skips; 1,275.53 seconds PostgreSQL test runtime                                                      |
| Resilience matrix/restart focused              | PASS; thirty core/restart tests; later final core assertions PASS in 29 tests (79.56 seconds)                                       |
| Enriched cross-domain regression               | PASS; 96 existing reconciliation/grouped/exception/control tests with sweep hooks (351.07 seconds)                                  |
| Populated migration/compatible recovery        | PASS through all ten migrations, complete registration and unchanged prior history; independent affected-book sweeps                |
| Genuine conflicts/ack loss/backend termination | PASS; actual PostgreSQL, TCP and backend boundaries, separate from injected SQLSTATE tests                                          |
| Failure load and Phase 10 load                 | PASS; both benchmarks remain enabled in the native suite                                                                            |
| Source equality / links / whitespace           | PASS; 161 non-Markdown implementation/configuration files match clean copy; changed-document local links verified; git diff --check |
| Cleanup                                        | All runner-owned containers stopped; no worker/proxy/backend/corruption fixture left running                                        |

Properties: 30 new database retry/replay schedules (seed 71111), 1,000 new health aggregation trials (71112), 1,030 added configured trials. Including unchanged Phase 1–10 properties: **18,490 configured trials**. Final total: **352 unique tests**, including 32 new tests. Follow-up repeats are not counted as new tests.

## Final load and recovery observations

| Measurement                                                                      | Result                                                                                    |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Durable work / healthy / poison                                                  | 1,002 / 1,000 / 2                                                                         |
| Worker concurrency                                                               | 16                                                                                        |
| Drain runtime / throughput                                                       | 6,932.54 ms / 144.54 jobs/sec (including poison disposition)                              |
| Recorded transient failures / expired attempts / stale fences                    | 250 / 25 / 25                                                                             |
| Handler p50 / p95                                                                | 34.72 / 50.70 ms                                                                          |
| Claim p95                                                                        | 51.69 ms                                                                                  |
| Creation-to-completion p50 / p95                                                 | 46.12 / 64.65 seconds                                                                     |
| Intentional lease-clock wait                                                     | 2,967.46 ms                                                                               |
| Expiry-to-reclaim p50 / p95                                                      | 15,377.80 / 15,606.81 ms                                                                  |
| Local PostgreSQL restart-to-recovered integrity                                  | 6,576.63 ms; four work items, separate recovery process                                   |
| Final invariant violations / duplicate domain effects / unrecovered healthy work | 0 / 0 / 0                                                                                 |
| Final terminal failures / financial assurance                                    | 2 retained poisons / FAIL; uncertainty and pending poison source evidence remain explicit |
| PostgreSQL commits before / after                                                | 43,718 / 47,816                                                                           |
| PostgreSQL blocks read before / after                                            | 718 / 720                                                                                 |
| PostgreSQL block hits before / after                                             | 14,269,863 / 14,891,977                                                                   |
| PostgreSQL deadlocks before / after                                              | 1 / 1; zero load-induced deadlocks                                                        |
| Peak client RSS                                                                  | 232,960 KiB, includes test/runtime/verifier memory                                        |
| Database CPU utilization                                                         | Unavailable; transaction/cache/deadlock counters collected                                |

Creation latency includes sequential ingestion and fault preparation. Expiry-to-reclaim includes intentionally paused workers, the pre-drain sweep, eligibility ordering and remaining backlog. Drain measurement begins when workers resume. These are observations, not production SLAs; there is no claim that expiry is reclaimed within a fixed wall-clock bound without active polling. Retry delay remains the frozen integer policy; the load uses 5 ms base / 20 ms cap, eight attempts maximum and 3,000 ms leases. Policy is restored in finally. The unchanged Phase 10 benchmark also passed: 1,000 items/sixteen workers/fifty retries, 114.41 jobs/sec in this populated run; no new throughput threshold or optimization was introduced.

## Commands executed

Repository/skill/architecture/ADR/Phase 1–10/test/schema/role inspection; official PostgreSQL 18 primary documentation; then:

```sh
pnpm install --offline --lockfile-only
pnpm install --frozen-lockfile
pnpm exec prettier --write <changed TypeScript/configuration/Phase 11 documents>
pnpm typecheck
NX_DAEMON=false NX_ISOLATE_PLUGINS=false pnpm lint
pnpm exec tsx --test libs/integrity-postgres/test/index.test.ts
pnpm test:integration tests/workers.integration.test.ts
pnpm test:integration tests/resilience.integration.test.ts tests/resilience-restart.integration.test.ts
pnpm test:integration tests/resilience.integration.test.ts tests/resilience-load.integration.test.ts tests/resilience-restart.integration.test.ts
pnpm test:integration tests/grouped-reconciliation.integration.test.ts tests/exceptions.integration.test.ts tests/controls.integration.test.ts tests/reconciliation.integration.test.ts
# Independent clean source copy:
pnpm install --offline --frozen-lockfile
NX_DAEMON=false NX_ISOLATE_PLUGINS=false pnpm verify
# Final strengthened assertions, in the same clean source copy:
pnpm test:integration tests/resilience.integration.test.ts
pnpm typecheck
pnpm exec eslint tests/resilience.integration.test.ts --max-warnings 0
git diff --check
```

Successful scoped/full commands are distinguished from the disclosed early fixture/port/metadata failures. No automatic approval rejection occurred. No production resource, commit, push or deployment was performed.

## File manifest

Created (13):

- `database/migrations/010_integrity.sql`
- `libs/integrity-postgres/package.json`, `project.json`, `tsconfig.json`, `src/index.ts`, `test/index.test.ts`
- `tools/integrity.ts`
- `tests/helpers/resilience.ts`
- `tests/resilience.integration.test.ts`, `tests/resilience-load.integration.test.ts`, `tests/resilience-restart.integration.test.ts`
- `docs/phase11/README.md`, `docs/phase11/verification.md`

Modified (18):

- `AGENTS.md`, `README.md`
- `docs/architecture/README.md`, `docs/architecture/verification-and-operations.md`
- `eslint.config.mjs`, `package.json`, `pnpm-lock.yaml`, `tsconfig.base.json`, `tsconfig.json`
- `tools/test-postgres.ts`, `tools/oracle-boundary.mjs`
- `tests/helpers/reconciliation-fixture.ts`
- `tests/reconciliation.integration.test.ts`, `tests/grouped-reconciliation.integration.test.ts`, `tests/exceptions.integration.test.ts`, `tests/controls.integration.test.ts`, `tests/workers.integration.test.ts` (independent sweep hooks only)
- `tests/simulator-boundaries.test.ts`

No Phase 1–10 runtime financial implementation, simulator generator, prior verification report or applied migration is edited. The read-only verifier and developer CLI are the only new runtime surface. No external dependency or ADR was added. All 46 criteria PASS within the stated scope; no acceptance criterion was weakened. Phase 12 remains deferred.
