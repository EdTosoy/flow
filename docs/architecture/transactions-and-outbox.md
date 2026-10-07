# PostgreSQL transactions, concurrency and durable asynchronous work

Phase 1 uses reviewed SQL routines and a `pg` adapter, with a typed caller-owned transaction port for later application composition. Drizzle adds no value to this controlled-write slice and remains available for later ordinary persistence. Only immutable outbox intent is implemented; all handler/work/lease/publication behavior below remains planned. [Concrete transactions and tests](../phase1/README.md).

## Durability and access boundary

PostgreSQL primary is the authoritative write/read boundary for financial decisions. Financial commits require durable WAL/storage settings (`fsync` and synchronous commit on); local Docker volumes are disposable test infrastructure, not production durability. Availability/replication and accepted disaster-recovery RPO are separate product/operations decisions. Backups, point-in-time recovery and restore verification must cover audit, source evidence, ledger and work together. See [PostgreSQL WAL reliability](https://www.postgresql.org/docs/18/wal-reliability.html).

Use separate runtime importer, application/worker and verifier roles, plus an offline migration/owner role. Runtime roles cannot mutate immutable evidence/history, bypass triggers, DDL in financial schemas, or ledger tables directly. Grant EXECUTE on narrow posting/transition routines where needed. Any SECURITY DEFINER routine must have a fixed trusted search path with pg_temp explicitly last, schema-qualified objects, no caller-selected SQL, restricted EXECUTE and owner, and explicit book/actor validation. Phase 1 uses `pg_catalog, pg_temp` and tests a caller-owned temporary type shadowing attack. Triggers and privileges are complementary controls, not protection against the DB owner.

No transaction stays open while reading a file, waiting for a network call or human review. Parse/compute candidates outside a transaction; revalidate authoritative facts under locks inside the final write transaction. Adapters share one transaction handle in application coordination; nested module calls must not open independent transactions that commit halfway through a command.

## Atomic operation catalog

| Operation | Must commit together | Lock/isolation strategy |
| --- | --- | --- |
| Accept batch/receipt chunk | Batch locator receipts + immutable source bytes/hash + initial processing disposition/work + ingestion audit/required outbox | READ COMMITTED, unique batch/locator and request key; short chunks. Final seal locks batch; chunks may not write after seal. A partially imported file remains loading/blocked, never claimed complete. |
| Canonicalize/normalize receipt | Canonical identity/revision or conflict evidence + normalized outputs + disposition + required downstream work/outbox/receipt | READ COMMITTED, unique identity/version/output keys; lock source_fact before selecting current revision. Conflicting payload cannot be `ON CONFLICT DO NOTHING` success. |
| Authorize internal refund | New activity/approval + cumulative refund validation + audit + work intent | Lock parent capture/payment first, then activities in sorted order. External invalid refund remains importable separately. |
| Post journal | Semantic idempotency outcome + all journal/entry rows + causal links + relevant internal state + audit + outbox and local consumer receipt/work completion | READ COMMITTED, unique effect key + locks on involved account state and journal parent; no balance caches to update. |
| Correct journal | Full reversal + replacement (if provided) + correction execution + approval consumption + audit + outbox | One transaction; lock original/correction request; unique reversal_of and command key. Original unchanged. |
| Seal reconciliation run | Run/rule selection + actual member rows with immutable snapshots + counts/hash/totals + coverage evidence | REPEATABLE READ snapshot; serialize same scheduled run key with a scope row/advisory transaction lock if needed. No SKIP LOCKED population selection. |
| Confirm/revoke group | Decisions/group/member proof + all current allocations + current outcome changes + affected case changes + audit + outbox | READ COMMITTED; lock run coordination row, stable items sorted by ID and current claims; revalidate revisions/state/version/rule. Unique allocation PK across runs. |
| Finalize run | Partition/totals validation + completed state/version + summary/audit/outbox | Lock run coordination row; workers changing that run must use same row protocol. Deferred/controlled cross-row checks prevent premature completion. |
| Activate corrected source revision | Current revision pointer + invalidation marker for affected proof + revocation of directly affected allocations/decisions + audit + reevaluation work/outbox | Lock source identity and affected items. Broader dependency reevaluation may be asynchronous, but current assurance must become stale/invalid atomically and stale proofs cannot be newly confirmed. |
| Close/reopen case | Guarded case state/disposition + decision/current assurance changes if relevant + audit + required work/outbox | Row lock + expected version; approval binds to exact command. |
| Local handler completion | Idempotent handler receipt + all local financial/domain effects + next outbox intents + delivery done | Lock work row and validate current lease generation before any effect; all-or-nothing commit. |

Ingestion chunks need not import 10,000 records in one huge transaction. Each accepted chunk is atomic/durable; only batch sealing/control evaluation can assert population receipt. Failed chunk retry preserves locators and resumes safely.

## Ledger write protocol

1. Validate authorization, exact bigint input, currency/accounts and policy version before calling PostgreSQL. Use a stable semantic effect key and canonical input hash, excluding receipt-specific volatile fields. Include amount, currency, account mapping, effective date and policy.
2. In the command transaction, acquire/resolve the unique command/effect identity. Concurrent attempts either wait on uniqueness or return an already committed outcome. Same key/different hash creates a conflict error/case; never silently accept it. A rolled-back identity reservation must not leave a fake successful effect.
3. Check involved accounts under `FOR SHARE` locks in sorted order for open state and currency/book. These shared locks allow concurrent ordinary journals but block account closure; closure uses `FOR UPDATE`. The correction routine alone can post an approved exact reversal to an original closed account; replacement entries require open accounts. Create an uncommitted journal in internal `constructing` state; insert all entries; transition to `posted` via controlled routine. `constructing` is an internal transaction-only condition, not a committed draft or public lifecycle. Runtime callers cannot write entries or transition this state directly.
4. Immediate guards reject entry changes once parent is posted. Journal-parent locking coordinates every entry operation. Deferred constraint triggers on header creation/state change and affected entry operations re-read final state at commit: require posted, >=2 entries, correct book/currency, equal debit and credit sums. A committed constructing/header-only journal is rejected. Cross-row CHECK is not used.
5. Append evidence, audit, domain state change and outbox work as part of that same transaction. Commit gives the external lifecycle `posted`; otherwise no journal exists.

The design intentionally combines one controlled routine with database backstops. Implementation must prove trigger coverage under direct SQL, inserts, updates, deletes and multi-session writes; declaring a trigger is not proof of correctness. Drizzle must preserve bigint/string types and the real transaction connection.

Account trial balances and financial projections are derived. Posting does not require serializing all journals to a hot global balance row. If later product scope requires preventing withdrawals/negative available balances, it needs a separate locked balance/reservation control; this observation system does not claim such a money-movement guarantee.

## Isolation and retries

READ COMMITTED is the default for short writes with stable parent row locks, unique keys and immutable facts. Each statement can see a new snapshot; a multi-statement absence check is not a correctness guarantee. [PostgreSQL isolation semantics](https://www.postgresql.org/docs/18/transaction-iso.html) motivate consistent snapshot capture and explicit coordination rather than a global strongest-isolation default.

Use REPEATABLE READ for frozen population capture and independent multi-query verification snapshots. Use SERIALIZABLE only if a future invariant involves predicates/absence across a changing set that cannot be serialized through an explicit aggregate/scope row (for example a global exposure cap). It still needs full transaction retries; stronger isolation cannot prove source completeness or a valid match rule.

Row locks are primary for existent domain aggregates. Transaction-scoped advisory locks may serialize a scheduled scope when no row exists yet; document key generation and collision behavior (collision may reduce concurrency, never weaken correctness). They are coordination aids, not the sole uniqueness control. Future application coordination acquires work/scope/source/domain locks before invoking ledger commands and uses one documented order across modules. Phase 1 makes the ledger order concrete: command-alias lock, original-journal lock for reversal, unique effect reservation, sorted shared account locks, then new-journal entry locks. This refines the initial generic ordering to serialize semantic identity before construction. Multi-command use cases should order their commands consistently and still retry the whole transaction after a deadlock; a real two-session deadlock/replay test verifies victim rollback. Lease recovery claims no domain rows, preventing a reverse dependency from recovery to posting.

On SQLSTATE `40001` (serialization failure) or `40P01` (deadlock), roll back and retry the **whole command** with the same business/command identity, bounded exponential backoff and jitter. A uniqueness error is not automatically transient: resolve the existing effect and compare hash. Connection loss during commit means unknown outcome: query/retry by stable command key, never create a fresh one. Bound attempts and persist a recoverable error/case after exhaustion. Retry generation may rerun computation but must not re-send non-idempotent network side effects.

The locking mechanisms are described in [PostgreSQL explicit locking](https://www.postgresql.org/docs/18/explicit-locking.html). `ON CONFLICT` is useful for identity convergence, but does not replace payload validation or auditing conflicts; see [INSERT](https://www.postgresql.org/docs/18/sql-insert.html).

## Transactional outbox V1

### Intent creation and registration

Create an immutable `outbox_event` in the authoritative transaction for every accepted change requiring downstream action. Store schema version, aggregate identity/version, cause, trace correlation, stable event key and payload/hash. Payload is either necessary immutable data or references to exact immutable revisions; a pointer to “whatever is current later” is insufficient for reproducible processing.

Create one `work_item` per required registered local handler in that transaction, unique event/handler, or use a durable dispatcher whose idempotent fan-out writes all required work rows and marks dispatch complete together. V1 prefers immediate local registration. A sweeper checks committed events against registration/version and expected work; a missed wakeup does not matter because workers poll the DB. Events born before a new handler are processed only through an explicit backfill policy.

### Safe claim

In a short transaction select a bounded batch of eligible ready/retry work ordered by available_at/created_at/ID with `FOR UPDATE SKIP LOCKED`; atomically set leased, increment claim generation, generate a lease token, set DB-clock lease_until/owner and create a started attempt. Commit before expensive computation. [PostgreSQL SELECT](https://www.postgresql.org/docs/18/sql-select.html) explicitly allows queue-like use of SKIP LOCKED; its skipped view must never be used for reconciliation/control-population completeness.

For expensive work, heartbeat only with the current token/generation. Lease expiration allows reassignment, but does not allow two commits: the final local effect transaction locks the work row and checks state/token/generation (and lease validity at entry), then keeps the lock through receipt/effects/done. A reclaiming worker waits or skips that row. An old worker whose generation changed must discard its result. Use transaction/statement/idle timeouts to avoid a hung final transaction blocking recovery indefinitely.

### Local consumption and fan-out

After computing a candidate outside the transaction, enter the guarded local completion transaction. If handler receipt already exists, validate its request hash, return existing result and complete duplicate delivery harmlessly. Otherwise revalidate input/current revisions, insert receipt, perform domain effects, create new outbox/work and mark this delivery done in the same transaction. The semantic ledger key protects against different event identities referring to the same financial action.

Per-handler `done` is not a statement about all consumers. An event's delivery summary is complete only when every required handler has a successful result. Downstream event order is not globally guaranteed: check aggregate version/prerequisites and reschedule missing dependencies. Never require every externally observable source sequence number to arrive through webhooks before ingestion can progress.

### Publication outside PostgreSQL

V1 local work requires no external broker. If later a webhook/notification/broker adapter publishes remotely, it sends the stable event ID as receiver idempotency key, then records acknowledged completion. Crash after send/before marking done produces duplicate delivery; the receiving durable consumer must deduplicate and apply local effect/receipt atomically. An HTTP 200 without a receiver durability contract is only transport evidence.

There is no atomic transaction across PostgreSQL and an arbitrary remote service. If the receiver cannot guarantee idempotency/status lookup, a lost acknowledgement is explicitly uncertain and requires investigation; it is not safe to blindly retry a money-moving side effect. Such side effects are outside V1.

### Failure, backoff and recovery

Classify transient connection/deadlock/dependency failures versus invalid payload/unsupported policy/conflicting identity. Transient work enters retry_wait with `available_at`; dependency retries have bounded duration tied to an expected source window. Use capped exponential backoff + jitter and configurable retry budget. Permanent failures or exhausted budget enter blocked, retain payload and all attempts, and open/update an exception case. “Dead letter” means retained blocked work, not deletion.

A recovery sweep finds expired leases, records abandoned attempts and reschedules work with a new generation. An authorized operator can repair input/policy and requeue blocked work using the same identity, with reason/audit. A supervisor monitors oldest ready age, expired leases, retry/blocked counts, attempt rate and successful-progress heartbeat. Monitor the sweep itself; silent scheduler death is a control failure.

Archive only under explicit retention policy after all required delivery/accounting/coverage checks succeed; never prune unresolved work or evidence needed to explain journals. Observe outbox storage/backlog and apply backpressure rather than discarding rows. PostgreSQL-backed processing remains V1 until measured contention/throughput justifies a change.

## Phase 4 implemented transactions

Processor derivation is separate from already committed normalization. READ COMMITTED plus the ingestion source-account lock commits derivation/payment association/activity or batch/all membership references with existing-outbox intent. Separate evaluation captures pinned source/processor evidence under the same scope lock and stable helper snapshot, then atomically commits frozen result, complete typed activity links and required failed-control audit. Unique version identities and unchanged evaluation keys recover unknown commits; old calculations never refresh in place. No ledger, bank, allocation or worker writes occur. [Implemented guarantees](../phase4/README.md).
