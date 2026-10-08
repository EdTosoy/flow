# Phase 10 verification and required completion report

Status: **COMPLETE AND VERIFIED** within the documented synthetic internal normalization worker boundary. Final clean frozen install and full native `pnpm verify` passed, exit 0, on 2026-10-08. All forty-two acceptance criteria pass. No Phase 11 work is included. [Protocol and limitations](README.md).

## Required report

1. **Files created/modified.** Twelve created and eighteen modified files; exact manifest below. Existing untracked `libs/control-domain/AGENTS.md` is preserved, read as guidance and excluded from this change. Applied migrations 001–008, prior financial runtime libraries and original financial assertions are unchanged.
2. **Dependencies added.** No external dependency/version. One private workspace importer uses existing pg 8.23.1 and ingestion-domain; existing fast-check/Node/Nx/TypeScript/tsx suffice.
3. **Package/module changes.** `@flow/worker-postgres` is runtime-tagged and depends only on ingestion-domain + pg. Eighteen build targets, eleven test targets. Added explicit Nx prohibitions for workers → oracle/ledger and ingestion → workers; transitive oracle checks remain enabled.
4. **Schema migration.** Additive 009 adds immutable contract/registration, offline configurable policy, operational work state and append-only attempt events plus status/metrics. Immediate outbox registration and deferred completeness guard; explicit historical backfill. No original payload/identity/version/timestamp rewrite.
5. **Lifecycle.** PENDING → PROCESSING → SUCCEEDED / RETRYABLE / FAILED_TERMINAL; due RETRYABLE → PROCESSING; expired PROCESSING → new PROCESSING or exhausted FAILED_TERMINAL. Final states cannot reopen automatically.
6. **Claim algorithm.** READ COMMITTED; one ordered eligible work row with `FOR UPDATE OF work_item SKIP LOCKED`; short claim/started-event transaction. Queue-only skipping, no global lock/FIFO or omitted financial population.
7. **Leases.** Database-clock finite expiry, UUID capability token, owner, actual login principal, claim time and monotonic attempt count. Each new claim creates new identity; expiry recovery is part of polling, not process memory.
8. **Fencing.** Each domain write locks work and checks current state/token/principal/unexpired lease at entry through domain COMMIT; completion checks same ownership. Stale completion is refused and recorded as FENCED. Reclaim cannot pass an in-flight locked domain write.
9. **Retry policy.** Default five claims; deterministic min(30,000 ms, 100 ms × 2^(attempt−1)). Offline policy freezes per item; database validates configuration. Whole deadlock/serialization transaction retries separately bound at five attempts, preserving the original identity.
10. **Failure classification.** TRANSIENT, DOMAIN_REJECTION, POISON, UNSUPPORTED, TIMEOUT and LEASE_EXPIRED. Unknown infrastructure errors remain bounded-retryable. Known validation/conflict/poison/version failures terminate immediately.
11. **Terminal semantics.** FAILED_TERMINAL retains work/event/handler/version, classification/code, timestamps, and all attempts. No deletion, history reset or force-success. Manual audited requeue is deliberately deferred.
12. **Version handling.** Explicit event/schema/aggregate/handler contracts; exact pinned existing normalizer allowlist. Unknown versions/types become UNSUPPORTED; malformed envelopes become POISON. Original historical data stays unchanged. Current outbox CHECKs themselves prohibit unsupported event schema versions; worker dispatch denial is additionally exercised in unit/property tests rather than weakening those constraints.
13. **Handler registry.** One genuine handler, normalize-batch v1 for normalization_requested v1. Completed ledger/processor/bank/reconciliation/exception/control notifications are explicitly NO_LOCAL_HANDLER. No fabricated async follow-ups or new financial command policies.
14. **Handler idempotency.** Reuse existing `(revision, normalizer version)` interpretation and `(raw, normalizer version)` disposition. Pending scans reuse committed progress; explicit repeated fenced domain calls return the same effect. No weaker worker-level effect key.
15. **Transaction boundaries.** Claim commit; compute outside locks; fenced per-receipt domain commit; separate fenced work acknowledgement/failure. Original ingestion/audit/outbox/registration stay atomic. Separation supports real post-domain-COMMIT/pre-ack replay.
16. **Crash after claim.** Committed lease survives; DB-clock expiry makes work discoverable/reclaimable. Actual separate-process claim-and-exit plus restart test and expired-lease exhaustion retain original intent/history.
17. **Crash during handler.** Actual PostgreSQL backend death after domain writes before COMMIT rolls back output/disposition. Previously committed receipts remain durable, and unchanged retry completes.
18. **Post-handler-COMMIT crash.** Domain output exists while work remains PROCESSING; expiry/reclaim/replay returns/reuses one interpretation, then succeeds. Explicit duplicates and property schedules verify no duplicate domain effect.
19. **Lost acknowledgement.** Actual TCP proxy drops successful claim/domain/completion COMMIT acknowledgements. Claim recovers by expiry; domain replay uses original semantic identity; completion replays same token/outcome from durable history. Success never becomes available again.
20. **Restart/recovery.** Actual new CLI process drains pending, due retry and an abandoned claim from an exited worker process; prior succeeded and terminal items retain states/attempt counts. SIGTERM during a deliberately blocked active handler drains it and leaves the next item pending.
21. **Ordering/dependencies.** No global FIFO or aggregate order assumption. Normalization depends on immutable accepted raw records and explicit existing requested versions, not insertion timing. Original domain revision locks/preconditions arbitrate concurrency. No invented downstream dependency.
22. **Time/backoff.** DB `clock_timestamp()` controls claims, leases, retry eligibility and timestamps. Integer milliseconds and capped integer shift implement reproducible backoff. Local monotonic timers measure performance/cooperatively stop steps; timeout never asserts a COMMIT definitely rolled back. Tiny actual DB-clock waits keep tests bounded.
23. **Permissions.** Non-login flow_worker capability role; actual non-superuser test login. Read evidence/operational state, execute only claim/fenced normalization/finish; no base writes, owner privileges, domain writer membership or ledger/reconciliation/exception/control mutations. Fixed privileged search paths and revoked PUBLIC execution.
24. **Audit/history.** Append-only operational STARTED/SUCCEEDED/FAILED/EXPIRED/FENCED events; unique start/terminal rows, tokens and deferred history completeness. Financial/domain audit retains existing ownership and atomicity. No heartbeat audit noise or synthetic mapped exception for a worker poison item.
25. **Metrics/logging.** Counts/age/expired/fence/retry/success/failure SQL view; timing interface for claim latency/handler duration; structured work/type/handler/attempt/token/duration/outcome/class/code logs. Payloads, credentials and arbitrary exception messages excluded; exporter failures cannot alter work.
26. **Existing outbox compatibility.** Populated Phase 9→10 upgrade compares prior ledger/raw/interpretation/disposition/reconciliation/allocation/exception/control/audit/outbox snapshots exactly and checks every outbox row has registration. Earlier populated migration and drift/reapplication gates retained.
27. **End-to-end workflow.** Public deterministic simulator → existing ingestion transaction/audit/outbox/registration → claim → existing versioned normalization/disposition → completion. Duplicate/malformed public inputs remain explicitly accounted for, source completeness UNKNOWN, no ledger posting; oracle consulted only by the independent verifier afterward. CLI enqueue/once/batch/start/status/metrics exercise actual runtime roles.
28. **Concurrency tests.** 100 PostgreSQL sessions observed waiting on a shared test barrier before release: one claim/handler. Twelve workers drain 100 jobs. Three actual concurrent CLI processes drain thirty requests from one shared queue; persisted attempt intervals from different owners must overlap and all claims have attempt count one. Two barrier-synchronized reclaimers converge on one new token. Stale domain write and acknowledgement rejected; load uses sixteen concurrent workers.
29. **Failure injection.** Pre-claim/pre-completion transaction rollback; suppressed required registration/source rollback; before handler; actual backend kill during domain transaction; handler commit/crash; three actual COMMIT-ack drops; lease/reclaim; timeout against a held domain lock; claim/domain/finish 40001/40P01 injections; malformed envelope and unknown pinned normalizer. Existing Phase 1 actual deadlock and financial failure gates remain enabled. Injected SQLSTATEs are not mislabeled new naturally occurring production anomalies.
30. **Property trials.** 1,000 incompatible contract/payload immutability trials, seed 71001; 1,000 log classification/redaction trials, 71002; 30 real PostgreSQL generated retry/replay schedules, 71003. Monotonic counts/unique tokens/final success/history/one semantic interpretation and immutable payload. 2,030 new configured trials; 17,460 including unchanged Phases 1–9.
31. **Load benchmark.** 1,000 real durable normalization requests, sixteen workers, fifty injected durable transient failures. Report drain jobs/sec, handler/claim/completion latency, retries, PostgreSQL transaction/cache/deadlock counters and peak client RSS. Database CPU utilization unavailable. Final result is recorded below; this is synthetic local load, not soak or production capacity/SLA.
32. **Commands executed.** Read instructions/skills/architecture/Phase 1–9/schema/adapters/tests; official PostgreSQL 18 lookup; Git scope/whitespace review; offline lockfile/frozen install; targeted Prettier; strict typecheck; worker unit/property tests; native focused disposable PostgreSQL suites; full native pnpm verify; independent clean frozen install/full verify. Exact final gates below.
33. **Verification results.** PASS: final frozen clean install/full native verify, exit 0. Format/lint/eighteen uncached builds/typecheck/eleven test targets/oracle probes/empty and populated migrations/all Phase 1–9 regressions/final load passed. 81 unit/property/boundary tests and 238 PostgreSQL tests: 319 tests in the complete clean run. A final clean-copy follow-up suite passed five simulator/CLI worker tests after adding the real concurrent-process case; strict typecheck and scoped lint also passed. Together 320 unique tests (81 unit/property/boundary + 239 PostgreSQL), including 32 new tests; 17,460 configured property trials. Zero failures/skips, no weakened gate.
34. **Architecture/ADR changes.** Clarify ADR-005 immediate registration/separate idempotent acknowledgement, ADR-006 existing semantic identity and unknown outcomes, ADR-007 concrete leases/fencing/recovery/history. Update current model/state/invariants/sequence/overview/transactions/root status. No new ADR or financial invariant change.
35. **Risks/assumptions.** Trusted synthetic adapters/provisioners/DB owners; no production security/restore/availability claim. Polling-dependent recovery, finite lease/runtime/budget, bounded v1 handler and status output, no heartbeat/soak/capacity promise. Terminal work remains an operational failure, never financial truth. Repeated failures may intentionally stop with visible pending domain dispositions.
36. **Deferred functionality.** Manual terminal requeue; new reconciliation/exception/control consumer policies; generic operational cases; external publishing/email/webhooks/payment/bank commands; frontend, real integrations, cloud, AI, Redis/BullMQ, Kafka/Redpanda and Phase 11. No commit/push/deployment or persistent database reset.
37. **Acceptance result.** All forty-two criteria PASS within the documented internal synthetic scope. Mapping below distinguishes tested behavior and explicitly permitted deferrals. Worker state never replaces financial truth; no later phase started.

## Final executed gates

Independent clean source `/tmp/flow-phase10-clean-Pgx9WG`; full log `/tmp/flow-phase10-clean-verify.log`; final process-concurrency log `/tmp/flow-phase10-processes.log`. Frozen offline install PASS: 408 existing packages reused, zero downloads. No dependency/cache/output/build-info/Git/private agent/environment/credential directories copied. Node 24.21.0, pnpm 11.27.0, PostgreSQL 18.6 pinned image, fsync/synchronous_commit on. NX_DAEMON=false/NX_ISOLATE_PLUGINS=false accommodate execution without disabling gates.

```sh
pnpm install --offline --lockfile-only
pnpm install --offline --frozen-lockfile
pnpm exec prettier --write <changed TypeScript/configuration/Phase 10 documents>
pnpm typecheck
pnpm exec tsx --test libs/worker-postgres/test/index.test.ts
NX_DAEMON=false NX_ISOLATE_PLUGINS=false pnpm test:integration tests/workers.integration.test.ts tests/simulator-workers.integration.test.ts tests/workers-load.integration.test.ts
NX_DAEMON=false NX_ISOLATE_PLUGINS=false pnpm test:integration tests/workers.integration.test.ts tests/simulator-workers.integration.test.ts
NX_DAEMON=false NX_ISOLATE_PLUGINS=false pnpm verify
NX_DAEMON=false NX_ISOLATE_PLUGINS=false pnpm test:integration tests/simulator-workers.integration.test.ts
pnpm typecheck
pnpm exec eslint tests/simulator-workers.integration.test.ts --max-warnings 0
git diff --check
```

Development failures were repaired, never waived: upgrade-control fixture initially selected another book; a stale-fencing fixture's 80 ms replacement lease expired during assertions and now uses 500 ms; inserted SQL dollar quoting and an unparenthesized CASE expression in a history guard failed compilation and were corrected; CLI summary repeated a property and was corrected. Initial sandbox pnpm store/local socket access used ordinary approved escalation. No automatic approval rejection occurred. The earlier full workspace run passed format/lint/build/typecheck/unit/oracle checks then failed migration compilation; it is not reported as a passing full run. Final focused run passed every worker failure/concurrency/restart gate after the fixes. The final clean full run passed every gate and all 238 PostgreSQL tests in 960.30 seconds. All 150 non-Markdown implementation/configuration files match that copy by SHA-256; a final test-only multi-process coverage addition followed, verified in the same clean copy with five passing CLI worker tests, strict typecheck and scoped lint. Runtime implementation and migration are unchanged. Final documentation results/status refinements, formatting/link/whitespace checks followed. The runner stopped its own disposable container.

| Gate                                                         | Status                                                                                                           |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Frozen offline clean install                                 | PASS                                                                                                             |
| Worker unit/property / focused PostgreSQL                    | PASS: four / twenty-six tests                                                                                    |
| Clean native format/lint/build/typecheck/unit/oracle         | PASS, exit 0; 18 uncached builds, strict checks, 81 unit/property/boundary tests                                 |
| Empty/repeated/drift/populated migrations                    | Populated Phase 1–9 and Phase 10 registration PASS in focused run                                                |
| Final full PostgreSQL and Phase 1–9 regressions              | PASS: 238 in full run, plus five final CLI tests including one new process-concurrency case; zero failures/skips |
| Final load benchmark                                         | PASS: 1,000 requests, 16 workers, 50 retries, 126.73 jobs/sec                                                    |
| Final source equality / documentation links / Git whitespace | PASS: 150 SHA-256 source/configuration matches, 148 local links, final format and whitespace checks              |

## Final load measurements

The final full-suite load test uses a previously populated disposable PostgreSQL database. Each of 1,000 requests contains one real synthetic movement, ingested with durable normalization intent. Sixteen worker lanes drain the queue; fifty requests first record a durable TRANSIENT failure. Every item succeeds; retry history is retained. Counts and metrics below are observed, not production guarantees.

| Measurement                           | Result                                                             |
| ------------------------------------- | ------------------------------------------------------------------ |
| Work items / worker concurrency       | 1,000 / 16                                                         |
| Queue drain runtime / throughput      | 7,890.97 ms / 126.73 jobs/sec                                      |
| Handler duration p50 / p95            | 36.06 / 63.93 ms                                                   |
| Claim latency p95                     | 62.83 ms                                                           |
| Creation-to-completion p50 / p95      | 22.56 / 41.58 seconds                                              |
| Durable retries / final failures      | 50 / 0                                                             |
| PostgreSQL xact_commit before / after | 60,692 / 64,403                                                    |
| PostgreSQL block reads / hits before  | 7,659 / 47,482,088                                                 |
| PostgreSQL block reads / hits after   | 7,671 / 48,130,236                                                 |
| PostgreSQL deadlocks before / after   | 1 / 1 (zero additional; earlier Phase 1 deliberately creates one)  |
| Peak client memory                    | 153,188 KiB RSS (includes test/runtime)                            |
| Database CPU utilization              | Unavailable; collected transaction/cache/deadlock counters instead |

Completion latency includes sequential initial ingestion and initial retry injection before queue draining. PostgreSQL activity counters are asynchronous operational observations, not financial proof. No contention/throughput optimization, soak or new queue infrastructure was introduced.

## Acceptance mapping

All criteria use the implemented synthetic internal workflow boundary, including conditional deferrals that the request explicitly permits.

| #   | Criterion                           | Implemented/executed evidence                                                       |
| --- | ----------------------------------- | ----------------------------------------------------------------------------------- |
| 1   | Authoritative transactional outbox  | Atomic registration/source rollback, unchanged original outbox                      |
| 2   | At-least-once                       | Separate domain/ack commits, duplicate and crash replay                             |
| 3   | Recoverable lifecycle               | SQL allowlist/CHECKs/history and restart                                            |
| 4   | Concurrent PostgreSQL claims        | Barrier-synchronized 100 sessions, 12/16-worker drainage                            |
| 5   | One valid lease                     | Unique row lock/current token, one contender claim                                  |
| 6   | Recover abandoned leases            | DB expiry, EXPIRED events, new worker/process                                       |
| 7   | Fence stale workers                 | Stale domain write and completion denied                                            |
| 8   | Retry versus terminal               | Explicit classifications and exhaustion tests                                       |
| 9   | Bounded/configurable retries        | Frozen policy ranges, three-attempt test, capped backoff                            |
| 10  | Visible terminal failures           | Retained row/history/status, no deletion/requeue                                    |
| 11  | Unknown versions/types safe         | Unit/property dispatch denial, DB-supported unknown normalizer terminal             |
| 12  | Immutable original intent           | Original guards unchanged; migration snapshots and payload properties               |
| 13  | Idempotent handlers                 | Original revision/version routine, direct repeated call                             |
| 14  | No duplicate effects                | Commit/crash/replay, duplicate and generated schedules                              |
| 15  | Crash after claim safe              | Actual exited claiming process and abandoned lease                                  |
| 16  | Crash during handler safe           | Actual backend termination rolls back output                                        |
| 17  | Post-domain-commit crash safe       | Committed interpretation replay/reuse and success                                   |
| 18  | Completion ack loss recoverable     | Actual dropped successful COMMIT, same-token recovery                               |
| 19  | Worker restart recovery             | CLI process covers pending/retry/expired/succeeded/terminal                         |
| 20  | Independent concurrent processing   | 100-job twelve-worker test, three overlapping CLI processes and sixteen-worker load |
| 21  | No global FIFO dependency           | Eligibility ordering only; no global lock                                           |
| 22  | Explicit domain prerequisites       | Existing requested raw/version state; no event-timing cascade                       |
| 23  | Poison isolation                    | One malformed request terminal, other work succeeds                                 |
| 24  | Authoritative clock                 | DB-clock leases/due eligibility, including after row waits                          |
| 25  | Enforced state combinations         | CHECK/transition/deferred history and adversarial SQL                               |
| 26  | Narrow permissions                  | Non-superuser flow_worker denials and fenced-only functions                         |
| 27  | Originating retries deduplicate     | Same ingestion/request command produces one work                                    |
| 28  | Observable operations               | Status/metrics/structured timing/log interface and CLI                              |
| 29  | Explainable failures                | Immutable started/end/expired/fence evidence, classes/codes/principals              |
| 30  | Real PostgreSQL contention          | Observed barrier waits before 100/2 claims and recovery                             |
| 31  | Fencing tested                      | Old token cannot write/finish or replace newer lease                                |
| 32  | Handler commit/crash/retry tested   | Explicit domain commit without work ack, single result                              |
| 33  | Malformed payload tested            | Poison envelope terminal, raw parse FAILED preserved                                |
| 34  | Property invariants                 | 2,030 added generated trials, including 30 real DB schedules                        |
| 35  | Throughput measured                 | 1,000 requests/16 workers/50 retries, final metrics below                           |
| 36  | Phases 1–9 green                    | PASS: complete native clean verification, all unchanged financial regressions       |
| 37  | No Redis/BullMQ                     | Dependency/source scope, existing pg only                                           |
| 38  | No Kafka/Redpanda                   | Dependency/source scope                                                             |
| 39  | No frontend                         | Library/SQL/CLI/tests/docs only                                                     |
| 40  | No external production integrations | Synthetic public-input normalization only                                           |
| 41  | No cloud                            | No infrastructure introduced                                                        |
| 42  | No AI                               | Deterministic existing normalizers; no AI dependencies                              |

## File manifest

Created (12):

- `database/migrations/009_workers.sql`
- `libs/worker-postgres/package.json`, `project.json`, `tsconfig.json`, `src/index.ts`, `test/index.test.ts`
- `tests/workers.integration.test.ts`, `tests/simulator-workers.integration.test.ts`, `tests/workers-load.integration.test.ts`
- `tools/worker.ts`
- `docs/phase10/README.md`, `docs/phase10/verification.md`

Modified (18):

- `AGENTS.md`, `README.md`
- `docs/architecture/README.md`, `data-model.md`, `implementation-sequence.md`, `invariants.md`, `state-machines.md`, `transactions-and-outbox.md`
- `docs/architecture/adr/005-transactional-outbox.md`, `006-at-least-once-idempotency.md`, `007-postgresql-workers.md`
- `eslint.config.mjs`, `package.json`, `pnpm-lock.yaml`, `tsconfig.base.json`, `tsconfig.json`
- `tests/simulator-boundaries.test.ts`, `tools/test-postgres.ts`

No prior verification document, financial runtime library, simulator generator or applied migration is modified. No production credentials are emitted; runtime errors use redacted fixed codes/messages.
