# Worker PostgreSQL Guidance

This directory contains the durable PostgreSQL-backed asynchronous worker implementation.

Read the repository root `AGENTS.md`, relevant worker/outbox ADRs, Phase 10 documentation, and the `verify-financial-change` skill before making non-trivial changes.

## Core principle

The worker system executes durable intent.

It is not the source of financial truth.

The authoritative sequence is:

```text
domain transaction
    ↓
durable outbox/work intent
    ↓
worker processing
```

Never make financial correctness depend on a worker being alive, receiving a message once, or successfully acknowledging work immediately.

---

## PostgreSQL is the work durability boundary

Durable work must survive:

- worker crashes
- process restarts
- machine restarts
- lease expiration
- transient database failures
- lost acknowledgements

Do not move authoritative work state into process memory.

Do not treat an in-memory queue as durable work.

---

## At-least-once processing only

Assume a work item may be processed more than once.

Never claim or depend on exactly-once delivery.

Correctness must come from:

- semantic work identity
- domain idempotency
- database uniqueness
- transaction boundaries
- fencing
- safe retries

Duplicate execution must not create duplicate financial or domain effects.

---

## Outbox intent is immutable

After originating domain commit, do not rewrite:

- event/work identity
- event type
- aggregate identity
- payload
- payload version
- creation timestamp

Worker-processing metadata may transition according to the established state machine.

Original business intent must remain immutable evidence.

---

## Worker lifecycle

Use only the established durable work states.

Do not introduce independent booleans that can create contradictory states.

Typical lifecycle:

```text
PENDING
   ↓
PROCESSING
   ↓
SUCCEEDED
```

or:

```text
PROCESSING
   ↓
RETRYABLE
```

or:

```text
PROCESSING
   ↓
FAILED_TERMINAL
```

Legal transitions must remain explicit and database-enforced where practical.

---

## Claim transactions must remain short

Claiming work should use short PostgreSQL transactions.

Do not hold queue-row locks across expensive domain processing.

The intended shape is:

```text
claim/lease transaction
        ↓
handler execution
        ↓
fenced completion/failure transaction
```

Any change to this structure requires explicit analysis of crash windows and retry behavior.

---

## SKIP LOCKED is queue-specific

`FOR UPDATE SKIP LOCKED` is appropriate for queue-like claiming.

Do not generalize this pattern to ordinary financial reads.

Its purpose here is safe concurrent work claiming, not weakened consistency elsewhere.

---

## Database time is authoritative

Lease ownership and retry eligibility must use the database clock or the established authoritative time source.

Do not compare leases using arbitrary worker-local clocks.

Avoid mixing machine-local clocks across worker processes for correctness decisions.

---

## Lease ownership

An active work claim must have explicit ownership.

Ownership should remain attributable to:

- work identity
- attempt
- worker/lease owner
- lease token
- claim time
- expiry

Do not infer ownership from process state.

---

## Abandoned work must recover

If a worker disappears after claiming work, the work must eventually become eligible for recovery.

Never create a lease that can permanently strand work.

Crash recovery must not require manually editing financial tables.

---

## Fencing is mandatory

A stale worker must never be able to finalize work after its lease has been superseded.

Scenario:

```text
worker A claims
worker A stalls
lease expires
worker B reclaims
worker A resumes
```

Worker A must be rejected from:

- domain finalization requiring current lease ownership
- work completion
- retry scheduling
- terminal failure transition

Lease token/attempt identity must be validated under the appropriate row lock or equivalent fencing mechanism.

Do not weaken fencing for convenience.

---

## Crash after domain commit

This is one of the most important failure cases.

Scenario:

```text
worker handler executes domain command
domain COMMIT succeeds
worker crashes before work is marked SUCCEEDED
```

The retry will execute the handler again.

Therefore:

> Handler replay must be safe.

Use the target domain's existing semantic idempotency.

Do not introduce handler logic that assumes:

```text
if handler runs, domain work has never happened before
```

---

## Unknown commit outcomes

Loss of connection around COMMIT does not prove failure.

Do not create another domain effect simply because the worker did not receive the acknowledgement.

Recovery must rely on:

- semantic command identity
- durable domain state
- work identity
- safe replay

"Retry and hope" is not sufficient.

---

## Handler idempotency

Handlers must reuse existing domain idempotency guarantees.

Do not create weaker, worker-only idempotency if the domain already has semantic identity.

For the same work item:

```text
execute 1 time
```

and:

```text
execute N times
```

must produce the same logical domain effect.

---

## Failure classification

Preserve explicit distinction between:

- retryable/transient failure
- deterministic domain rejection
- poison/malformed work
- unsupported payload/version
- timeout
- lease expiration/reclaim
- terminal failure

Do not retry permanent errors forever.

Do not classify transient infrastructure failures as terminal without justification.

---

## Retry behavior

Retries must be bounded and deterministic according to the established policy.

Preserve:

- attempt count
- retry eligibility
- backoff policy
- failure classification
- history

Do not silently reset attempts.

Do not erase previous failures after a successful retry.

---

## Poison work isolation

One malformed or unsupported item must not block unrelated work.

Poison work should:

- fail visibly
- retain failure evidence
- eventually reach terminal state according to policy

The worker loop must continue processing other eligible items.

---

## Terminal failure remains visible

Terminally failed work is durable operational evidence.

Do not delete terminal work automatically.

Preserve enough information to determine:

- work identity
- type/version
- attempts
- final failure classification
- timestamps
- handler identity

Do not store secrets or unnecessary raw financial payloads in error details.

---

## Work history is append-only evidence

Attempt history exists to explain what happened operationally.

Do not rewrite earlier attempts to make the current state appear cleaner.

Retain:

- attempt number
- lease identity
- outcome
- failure class
- timing information

Operational history is distinct from financial audit history.

---

## Worker state is not financial truth

A work item being:

```text
SUCCEEDED
```

means worker processing completed according to its handler contract.

It does not independently prove:

- money is reconciled
- ledger state is correct
- an exception is financially resolved
- a control passed

Those claims remain owned by their respective domains.

---

## Handler registry

Only explicitly registered work types may execute.

Do not dynamically execute arbitrary handler names or payload-provided code.

Unknown:

- event types
- schema versions
- handler versions

must fail safely and visibly.

---

## Payload versioning

Historical work may use older payload versions.

Do not silently reinterpret incompatible payloads using current assumptions.

Dispatch according to explicit version contracts.

If a version is unsupported, preserve that fact as an explicit failure.

---

## Ordering

Do not assume global FIFO.

If a handler requires prerequisite state, enforce that requirement through domain state or explicit preconditions.

Do not rely on:

```text
event A was inserted before event B
```

therefore:

```text
A will finish before B
```

Avoid hidden temporal coupling.

---

## Dependency handling

If downstream work depends on prerequisite domain state and that state is not ready:

- fail/retry according to explicit policy
- do not fabricate prerequisite state
- do not bypass domain transitions

Dependencies should be represented through domain truth, not queue timing assumptions.

---

## Permissions

Worker database roles must remain narrow.

Workers must not gain unrestricted mutation access to financial tables.

Handlers should execute through approved domain commands/functions/ports.

Do not grant broad table-write permissions merely to simplify worker implementation.

---

## No direct financial-table mutation

Worker code must not bypass existing domain boundaries.

Do not directly:

- insert ledger entries
- update reconciliation allocations
- mutate exception history
- change financial controls

when approved domain commands already exist.

Async execution changes _when_ a command runs, not the invariants governing that command.

---

## Concurrency

Worker changes must consider true concurrent execution.

Important scenarios include:

- many workers claiming one item
- many workers draining many items
- competing reclaimers
- stale owner vs new owner
- domain commit vs work acknowledgement
- concurrent retries

Use real PostgreSQL tests for behavior depending on:

- row locks
- lease ownership
- transaction isolation
- uniqueness
- retries

Do not rely only on mocks.

---

## Required fencing tests

Any change to claim/lease/completion behavior must preserve tests equivalent to:

1. Worker A claims work.
2. A's lease expires.
3. Worker B reclaims.
4. A attempts completion.
5. A is rejected.
6. B remains authoritative.

If this scenario is not safe, do not report the change as complete.

---

## Required crash-window tests

For relevant changes, explicitly consider:

```text
before claim commit
after claim commit
before handler transaction
during handler transaction
after handler COMMIT
before work completion
after completion COMMIT with acknowledgement loss
```

No window may:

- lose committed work
- duplicate financial effects
- allow stale completion
- falsely report terminal success

---

## Graceful shutdown

A worker shutting down should stop claiming new work and safely handle current ownership according to the established policy.

Do not invent permanent lease ownership because a process received a shutdown signal.

Restart must recover eligible abandoned work.

---

## Timeouts

Timeouts do not necessarily prove the domain operation failed.

Do not assume:

```text
handler timed out
=
domain transaction definitely did not commit
```

Preserve idempotency and safe replay.

---

## Observability

Worker telemetry may expose operational information such as:

- work ID
- event type
- handler
- attempt
- lease identity
- duration
- result
- failure classification

Do not emit unnecessary raw financial payloads.

Do not log secrets.

Do not confuse logs with durable work history.

---

## Metrics

Preserve useful worker signals such as:

- pending work
- processing work
- retryable work
- terminal failure count
- oldest pending age
- handler success/failure
- retry count
- lease expirations
- stale-worker fencing
- handler duration
- claim latency

Metrics must not become a correctness dependency.

---

## No new queue infrastructure without evidence

Do not introduce:

- Redis
- BullMQ
- Kafka
- Redpanda
- another message broker

merely for architecture sophistication.

The current V1 design intentionally uses PostgreSQL-backed work processing.

A migration to another queue/streaming technology requires:

1. measured evidence of a concrete limitation
2. an architecture decision
3. preservation of idempotency, auditability, recoverability, and outbox semantics

---

## Outbox compatibility

Changes to worker processing must remain compatible with already-committed historical outbox records.

Do not break old durable intent because worker implementation evolves.

Migrations should be additive where practical.

---

## Property expectations

Useful worker properties include:

- successful work never automatically becomes retryable again
- attempt counts never decrease
- stale leases cannot complete work
- repeated handler execution creates one logical domain effect
- original payload identity never changes
- terminal failure history remains preserved
- abandoned leases eventually become reclaimable
- completion remains idempotent

Use property-based tests where they add meaningful coverage.

---

## Required review before completion

For any non-trivial worker change, explicitly ask:

1. Could work be lost if the process dies immediately after claim?
2. Could a stale worker finalize after another worker reclaimed the job?
3. Could retry duplicate a financial/domain effect?
4. Could a lost COMMIT acknowledgement create another effect?
5. Could one poison item block unrelated work?
6. Could an unsupported payload execute incorrectly?
7. Could local machine time break lease ownership?
8. Could attempt/failure history be erased?
9. Could the worker bypass domain permissions/invariants?
10. Does the change incorrectly assume exactly-once delivery?
11. Could historical outbox intent become unreadable?
12. Does this introduce queue infrastructure without measured need?

If any answer reveals an unresolved correctness risk, do not report the change as complete.
