# Phase 10: durable PostgreSQL workers

Database transaction = financial truth. Async work = processing of durable intent. Delivery is **at least once**. No broker, financial projection, external side effect or Phase 11 is introduced. [Verification and required report](verification.md).

## Scope and durable intent inventory

Migration 009 adds `worker.contract`, `policy`, `registration`, `work_item`, append-only `attempt_event`, and read-only `status`/`metrics` views. Original migrations 001–008, outbox rows/payloads/versions/timestamps, domain commands and financial invariants are unchanged. Runtime package `@flow/worker-postgres` depends only on existing ingestion-domain and pg; lower domains never import workers.

The installed explicit contract registry has one effect handler: `normalize-batch` version 1 consumes `ingestion.normalization_requested`, schema/aggregate version 1. It uses the exact existing pinned normalizer (movement v1/v2, settlement v1/group v1, bank entry/statement v1). Unsupported versions become durable terminal `UNSUPPORTED`; malformed envelopes become `POISON`. Raw parse failures are successful execution of the normalization request with existing durable `FAILED` ingestion dispositions; they are never discarded or marked normalized.

All other existing events describe completed actions: ledger account/journal creation/reversal, processor/bank interpretation, reconciliation decision/completion, exception created/updated/resolved/reopened, and controls completion. These have explicit immutable `NO_LOCAL_HANDLER` registrations, not fake no-op success jobs. No existing event requests exception generation or a new control/reconciliation run. Their DRAFT/partial runs remain durable caller-owned staged executions; incomplete runs are not mistaken for outbox consumer requests. New follow-up policy/handler registration requires an explicit future migration and backfill decision. Phase 10 does not fabricate chain reactions, auto-resolve cases, refresh historical controls or post journals.

An AFTER INSERT trigger registers intent in the originating domain transaction. Unique registration/event and work/event keys preserve existing semantic command replay. Migration backfills every historical outbox row: normalization requests receive pending work even if synchronous normalization already completed; existing semantic outputs are safely reused. Notification rows receive `NO_LOCAL_HANDLER`. Unknown contracts get `unsupported` work, terminal on dispatch. No best-effort publish gap or in-memory scheduler exists. A missing policy rejects the originating transaction rather than silently omitting required work.

## Lifecycle, claiming and history

```text
PENDING -> PROCESSING -> SUCCEEDED
                     -> RETRYABLE -> PROCESSING
                     -> FAILED_TERMINAL
PROCESSING with expired lease -> PROCESSING (new attempt/token)
PROCESSING with expired exhausted lease -> FAILED_TERMINAL
```

SUCCEEDED and FAILED_TERMINAL are final. Manual terminal retry is explicitly deferred; there is no history reset or force-success command. CHECKs enforce coherent lease/delay/completion/failure fields. Transition guards preserve identity/configuration, increasing attempt counts, due eligibility and immutable final state. Deferred checks require corresponding started/terminal history; operational attempts are not financial audit entries.

Claims use READ COMMITTED and `FOR UPDATE OF work_item SKIP LOCKED`, scoped only to the queue. One item is claimed per short transaction. Order is eligibility time (retry due time / lease expiry / creation), then creation/id. No global FIFO or global queue lock. Future retries are excluded, preventing one failed item from monopolizing claims. Different workers can process different jobs. Each poll can terminalize up to 32 exhausted abandoned leases before returning; polling continues to sweep any remaining backlog. Stopping pollers delays recovery but never loses intent; expired counts and oldest pending age expose this condition.

Each claim records owner, actual database principal, claimed/expiry timestamps, a unique UUID lease token, and increasing attempt number. One current valid lease exists per item. An expired claim becomes eligible again; its `EXPIRED` event is appended before the next attempt. An exhausted abandoned item remains terminal and queryable. Tokens are capabilities bound to the claiming database principal; runtime process owner text is diagnostic. No heartbeat is required for the bounded v1 handler; leases cannot be extended indefinitely.

## Fencing and transaction boundaries

1. Claim/started-history commit together, then release queue locks.
2. Load immutable raw evidence for still-pending receipts and compute normalization outside a transaction; committed dispositions reuse their existing output.
3. For each raw receipt, `worker.complete_normalization` locks work, validates state/token/principal and DB-clock lease validity **at entry**, checks the exact outbox batch/version scope, then calls the existing controlled ingestion command. Keep the work lock through domain COMMIT. Reclaimers skip that locked row. Domain receipt/disposition/interpretation remain atomic and use `(revision, normalizer version)` semantic identity. Partial batch progress is safe and durable.
4. Complete or record failure in a separate short transaction, validating the same lease. Successful acknowledgement requires all requested processing dispositions to be terminal. It is execution success, not evidence of source completeness or reconciliation.

A domain transaction admitted while the lease is valid can finish while holding the row lock after wall-clock expiry; no newer claim can pass it concurrently. A stale computation cannot enter another domain write or finalize reclaimed work. Expiry is permission to reclaim once the row is unlocked, not cancellation or proof of failure. Statement, lock and idle-in-transaction timeouts bound ordinary database waits; privileged administration and server/storage failures remain trust/availability boundaries.

Crash before claim COMMIT rolls back claim and started history. Crash after claim leaves an expiring lease. Crash before/during a domain transaction leaves no partial domain effect; previous completed raw receipts remain committed. Crash after domain COMMIT/before work acknowledgement reuses the existing semantic output/disposition on retry. Original outbox is untouched. Completion COMMIT acknowledgement loss is resolved by same `(work ID, lease token, outcome)` against append-only history; it cannot change SUCCEEDED back into retry. Claim acknowledgement loss leaves a discoverable abandoned lease; a new poller recovers it. Whole deadlock/serialization transactions retry with unchanged identity, up to five transaction attempts.

There is no handler requiring global or per-aggregate queue ordering. Existing domain preconditions, revision locks and uniqueness arbitrate duplicated/reordered requests. Notification events do not infer prerequisites for new workflows. Future handlers must express dependencies through durable domain state and explicit transient outcomes.

## Retry, time and timeout policy

Offline provisioners configure the single policy for **future** items; items freeze their own policy. Default: 5 claims, 100 ms base backoff, 30,000 ms cap, 30,000 ms lease, 10,000 ms handler deadline. Claims including crashes consume the attempt budget. Delay = min(cap, base × 2^(attempt−1)), computed with bounded integer arithmetic. No jitter. Valid policy ranges are database-enforced. Durations are integral milliseconds, not monetary arithmetic. Database `clock_timestamp()` alone controls eligibility and ownership, including after lock waits. Local monotonic timing measures performance and cooperatively stops execution, never determines lease ownership. Tests use tiny DB-clock delays rather than long real waits.

TRANSIENT includes network/unknown commit, deadlock/serialization, lock/statement timeout and unknown infrastructure errors. Unknown errors retry to a bounded visible terminal outcome rather than being prematurely assumed permanent. DOMAIN_REJECTION (known deterministic validation/conflict SQLSTATE), POISON and UNSUPPORTED are immediately terminal. TIMEOUT is retryable. LEASE_EXPIRED is crash recovery, and ultimately terminal at exhaustion. Store classifications and safe codes, not arbitrary error messages or payloads.

Handler deadline stops new steps; it cannot prove that a COMMIT in flight rolled back. Completion/failure waits for its work-row lock; any late new domain step is fenced after the attempt closes. A request that needs more runtime must use an explicitly provisioned bounded policy. Defaults and synthetic measurements are not production SLA guarantees.

## Permissions, audit and observation

`flow_worker` is a non-login capability role for provisioned non-owner logins. It can read raw evidence and operational state and EXECUTE only claim, fenced normalization and finish. No domain writer role, base-table write, ledger posting, reconciliation allocation, exception decisions, control mutation, schema creation or owner membership. SECURITY DEFINER search paths are fixed `pg_catalog,pg_temp` and PUBLIC execution is revoked. Existing domain audit remains in domain transactions; work STARTED/SUCCEEDED/FAILED/EXPIRED/FENCED history is append-only operational evidence, without noisy lease heartbeat financial audit.

`metrics` exposes pending/processing/retryable/terminal counts, success/failure counts, oldest pending age, current expired leases, observed lease-expiration/fence counts and retries. `WorkerTelemetry` provides `claim_latency`, `handler_duration`, and structured completion logging with work/event/handler identity, attempt/token, duration, classification/code and outcome. Exporter failures do not change work outcomes. No raw payloads, arbitrary exception messages or credentials are logged. Counts are PostgreSQL integer strings. No observability deployment, automatic paging or production operations claim.

## Developer commands

Use provisioned synthetic/test database URLs; migration credentials are separate. No automatic runtime role provisioning.

```sh
pnpm db:migrate
pnpm simulator generate --seed 71008 --payments 100 --out <new-public-directory>
pnpm worker enqueue <public-input.json> <book-id> <stable-batch-key>
pnpm worker once <book-id>
pnpm worker batch 100 <book-id>
pnpm worker start <book-id>
pnpm worker status PENDING
pnpm worker status RETRYABLE
pnpm worker status FAILED_TERMINAL
pnpm worker metrics
pnpm benchmark:workers
pnpm verify
```

`db:migrate` requires offline `DATABASE_ADMIN_URL`. Generated public input is `<new-public-directory>/input.json`; oracle output is optional, separate and never a worker input. `enqueue` requires `DATABASE_INGESTION_URL`; all processing/status commands require `DATABASE_WORKER_URL`. `once` processes one item; `batch` processes an explicit 1–10,000 limit, optionally scoped to a book. Status is bounded to 1,000 rows; direct authorized SQL can inspect complete work/history. SIGINT/SIGTERM stop new claims and wait for the current bounded operation; forced termination relies on lease recovery. Polling sleeps 250 ms and wakes for shutdown. No arbitrary executable handler/payload dispatch.

Terminal failures remain original identity/type/version/payload plus every attempt, classification/code, principal/owner and timestamps. Investigate with status/history; do not reset or mutate financial evidence. Phase 8 cases require mapped financial subjects; generic operational work-failure cases and audited manual requeue are deferred instead of manufacturing reconciliation subjects.

Limitations: one installed internal workflow, polling-dependent recovery, bounded batches/runtime, no heartbeat/soak/capacity guarantee, trusted synthetic adapters/provisioners/DB owners, no authentication/production TLS/backup/restore verification, no retention pruning. External publication/email/webhooks/payment/bank commands, new downstream domain workflows, manual requeue, frontend, real integrations, cloud, AI and Phase 11 remain deferred.

PostgreSQL 18 mechanism references: [queue-like SKIP LOCKED](https://www.postgresql.org/docs/18/sql-select.html), [authoritative clock semantics](https://www.postgresql.org/docs/18/functions-datetime.html), [restricted SECURITY DEFINER](https://www.postgresql.org/docs/18/sql-createfunction.html). Tests, rather than documentation alone, establish the implemented boundary.
