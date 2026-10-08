# Phase 11 — System resilience verification

Phase 11 adds an independent read-only verification surface and adversarial tests. It introduces no accounting, matching, case or processing workflow. PostgreSQL transactions remain financial truth; workers execute immutable durable intent at least once. Phase 12 is not authorized.

## Independent invariant sweep

`@flow/integrity-postgres` calls `integrity.sweep(book, explicitlySelectedRunIds)` in a READ ONLY REPEATABLE READ transaction. The fixed-search-path SECURITY DEFINER routine executes as the existing owner but grants its caller only this scoped read operation. `flow_integrity_reader` has no domain writer memberships, base-table access or command execution. It returns IDs, scopes, counts, exact integer-string control totals and named violations, excluding raw receipts, notes, commands and payloads. A failed/unavailable query never emits assurance.

The sweep reuses `controls.snapshot`, `controls.evaluate_input`, source-owned coverage/intrinsic controls, current allocation validity and canonical exposure. It creates no control run, case, audit, work or financial effect. It independently checks:

| Boundary             | Verification                                                                                                                                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Ledger               | Posted count/currency/balance, exact debit/credit totals, audit/outbox/receipt companions, duplicate effect identity                                                                                                     |
| Source/normalization | Physical receipt count, requested population partition, disposition/output link, original normalization intent, missing processing                                                                                       |
| Processor/bank       | Supported derivation coverage, intrinsic controls, independently reported net/closing stocks and completeness                                                                                                            |
| Reconciliation       | Every completed frozen member has an outcome; exact historical group conservation, roles/currencies/outcome links, whole current reservations and economic-item uniqueness                                               |
| Exceptions           | Initial decision, contiguous previous-state chain, resolution consistency, decision audit/outbox, historical verified-resolution proof                                                                                   |
| Controls             | Frozen manifest/hash equals stored inputs; completed input/result coverage and companions; every stored result recomputes from its original input                                                                        |
| Exposure             | Explicit one-run-per-mapping selection; stable component uniqueness and accepted-risk subset; cases remain metadata rather than additional money                                                                         |
| Work                 | Every outbox intent registered, required handler work present, no notification-only work, lifecycle/attempt history/token links, success cannot cover pending dispositions, visible expired leases and terminal failures |

`integrity: PASS` means these structural checks found no violation in the observed supported scope. `financialAssurance: PASS / FAIL / UNKNOWN` reports evidence strength separately. Missing independent period closure stays UNKNOWN; stale allocation proof, bad bank closing or missing expected receipts stay non-green. Corrected source evidence may legitimately invalidate current assurance without corrupting immutable history. Terminal work is an operational failure, even when structural history is intact. An expired lease is exposed as recoverable outstanding work, never silently passed as completed.

There is no default latest-run selection: callers explicitly choose at most one distinct run per mapping in the same book. Omitting selection preserves UNKNOWN reconciliation/exposure coverage. Current reads cannot prove that a malicious owner previously rewrote history. Test-only retained-row witnesses independently hash prior immutable rows and completed runs, and require every digest to survive subsequent scenarios. Runtime write guards and permission probes remain prevention; witnesses and the sweep remain detection. Same-database hashes are not an external tamper-proof anchor.

## Developer operations

Provision a login with only `flow_integrity_reader`; configure `DATABASE_INTEGRITY_URL` outside source. Commands use existing pinned pnpm tooling:

```sh
pnpm db:migrate
pnpm integrity <book-id> [explicit-reconciliation-run-id ...]
pnpm test:resilience
pnpm benchmark:resilience
pnpm verify
```

The integrity CLI emits concise JSON: as-of time, overall structural integrity, financial assurance, per-boundary checks, named violation evidence, open exceptions/unknown controls and work counts (including terminal/expired). Exit 0 means the sweep executed without structural violation; financial FAIL/UNKNOWN remain explicit fields. Exit 2 means an invariant violation; exit 1 means unavailable/invalid scope. Library callers can inspect individual control results. No UI, repair command or manual worker requeue is added.

## Failure harness and isolation

`tests/helpers/resilience.ts` wraps actual PostgreSQL pool/client operations only in tests. It interrupts before BEGIN, after BEGIN, before/after the guarded command or before COMMIT; disposable SQL triggers abort within partially written routines. Actual TCP COMMIT acknowledgement loss uses the existing wire proxy. Actual backend termination uses a privileged disposable administrator. Advisory/row-lock barriers observe PostgreSQL `Lock` waits before release; tiny readiness polling waits do not presume a race occurred.

Existing reconciliation/grouped/exception/control and worker suites opt into independent after-scenario sweeps. New critical crash/race cases additionally retain prior immutable-history witnesses. Failure probes never enable production hooks: all tests and the migration runner are private import targets, enforced by oracle/harness dependency rules. Runtime integrity depends on `pg` only and is forbidden from importing any domain writer or oracle package.

Trigger/function injection cleanup uses `finally`. Corruption/DDL probes remain inside explicit transactions that always ROLLBACK, including replacement of the exposure evaluator. Actor joins, lock release, socket/proxy shutdown, pool closure and child-process deadlines prevent one scenario from poisoning later tests. Existing checks/timeouts are retained. The integration runner owns only its randomly named disposable PostgreSQL container and stops it in `finally`. Its reserved localhost port is explicitly pinned across restarts; connection waits in the restart test are bounded.

## Tested failure model

The eight-operation matrix covers ledger posting, ingestion, normalization, processor interpretation, bank interpretation, reconciliation acceptance, exception resolution and control completion. Before-commit interruption leaves no logical effect; actual successful COMMIT with acknowledgement dropped leaves exactly one effect; unchanged replay reuses it. Stage-owning modules retain their existing additional failure boundaries, genuine financial deadlock, unknown COMMIT, mutation and concurrency gates.

Phase 11 additionally terminates ledger/allocation/control backends after writes, and kills a worker domain transaction. A real advisory-lock deadlock encloses actual ledger posting; PostgreSQL aborts one whole transaction, and the adapter/caller replays unchanged semantic identities. A real REPEATABLE READ freeze conflict observes a contending row update and verifies exactly two whole-stage attempts. Injected SQLSTATE tests remain enabled and are distinguished from genuine conflicts. This follows PostgreSQL's [whole-transaction retry requirement](https://www.postgresql.org/docs/18/transaction-iso.html), [deadlock behavior](https://www.postgresql.org/docs/18/explicit-locking.html) and [backend termination semantics](https://www.postgresql.org/docs/18/functions-admin.html).

Concurrent duplicate/corrected imports retain all receipts, two immutable interpretations and no authoritative unordered revision. Processor and bank arrivals after snapshot establishment cannot alter the frozen run. Correction racing current reconciliation remains explicit ineligible/stale evidence. Existing exact/grouped contention and overlapping declared groups retain allocation barriers and ambiguity, now followed by independent sweeps. Resolution/reviewer/classification/assignment/reopening/supersession races retain expected versions and immutable history. Invalid resolution preconditions are explicitly rejected; scheduling is never a substitute for evidence.

Controls race reconciliation completion, source arrival, accepted risk and worker normalization. Frozen before/after snapshots remain coherent; changed evidence requires another evaluation. Accepted-risk disposition contributes no allocation or extra money; later genuine reconciliation can independently prove the item. Existing missing-source and bad aggregate closing false-green scenarios remain enabled and independently swept. Every worker succeeding still cannot upgrade UNKNOWN source assurance.

Worker coverage retains all Phase 10 claim/handler/completion COMMIT crash windows, actual acknowledgement drops, 100-session synchronized claiming, competing reclaimers, timeout/fencing, process restart and graceful shutdown. New repeated lease churn admits one eventual interpretation and rejects old token completion/domain writes. The load combines 250 recorded transient failures, 25 expired leases, two malformed intent items and 1,000 healthy intents under sixteen workers. It verifies bounded attempts, retained failure events, no starvation, no duplicate interpretations or journals and no outstanding recoverable work after drainage. Poison work remains terminal and its unprocessed raw evidence remains visible.

The local Docker restart deliberately interrupts an open claim transaction after another handler has committed without acknowledgement. A separate CLI process reconnects and recovers pending, retryable and abandoned work while preserving prior success. This tests one local node with durable storage and enabled fsync/synchronous_commit. It does **not** prove storage loss recovery, HA/failover, replication, backup restore, multi-region disaster recovery or production SLAs. Clients may need a fresh invocation after connection failure; the existing continuous worker loop retries polls.

## Upgrade, replay and measurements

Migration 010 is additive: read-only schema/function/capability only. The populated runner still upgrades through every original migration, fingerprints prior financial/evidence/work state around 010, drains compatible historical work and sweeps affected books. Replays may append previously missing versioned normalization output; earlier immutable rows must survive unchanged. Prior applied migration hashes never change.

Properties record fixed seeds: 71111 for thirty database retry/replay schedules; 71112 for 1,000 health aggregation trials. Existing simulator seeds/golden identities and post-runtime oracle evaluation remain unchanged. Actor scheduling is explicitly synchronized where practical; nondeterministic races assert invariant outcomes rather than a particular winner. UUIDs/timestamps identify each invocation, so deterministic replay promises the logical disposition/effect counts, not identical physical IDs.

[Verification](verification.md) records executed gates, the acceptance matrix, final workload/recovery measurements and remaining assumptions. Measurements describe a synthetic local workload, not production throughput or a recovery SLA. Independent sweeps are bounded by existing Phase 9 limits (100,000 received records/20,000 controls); oversized scope fails explicitly rather than truncating. No scheduled monitor, alert deployment, heartbeat or retention policy is introduced.

Deferred: Phase 12/UI, real bank/processor integrations, additional accounting/product features, manual matching/revision authority, arbitrary N:M/partial allocation, cloud infrastructure, AI, external side effects, new queues/brokers, disaster recovery and production approval.
