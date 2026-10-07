---
name: verify-financial-change
description: Verify changes to financial-domain code against repository invariants, PostgreSQL guarantees, concurrency behavior, and required evidence before completion.
---

# Verify a financial change

Use this workflow for changes involving money, ledger behavior, financial ingestion, settlements, reconciliation, exceptions, audit, or other financially significant state.

## 1. Establish the correctness boundary

Before changing code:

1. Read the root `AGENTS.md`.
2. Read the relevant architecture documents.
3. Read applicable ADRs.
4. Identify the financial invariants affected by the change.
5. Trace the existing implementation and tests.
6. Inspect the current working tree.

Do not treat the task description as permission to violate repository invariants.

If the requested behavior conflicts with an invariant or ADR, identify the conflict before implementation and choose the safer design.

## 2. Classify the change

Determine whether the change affects any of:

- exact monetary arithmetic
- ledger posting
- ledger immutability
- idempotency
- reversals
- transaction boundaries
- PostgreSQL constraints
- concurrency
- ingestion provenance
- normalization
- settlement semantics
- reconciliation
- completeness controls
- exception state
- audit history
- outbox/durable work
- authorization boundaries

Use this classification to determine the required verification.

## 3. Prefer enforceable guarantees

For financially significant correctness:

Prefer, in order where appropriate:

1. database constraints
2. transactional boundaries
3. uniqueness/idempotency barriers
4. explicit state-machine rules
5. domain validation
6. application checks

Do not rely on application validation alone when PostgreSQL can reliably enforce the invariant.

Do not weaken database enforcement to make implementation easier.

## 4. Preserve exact money

Verify that:

- monetary arithmetic does not use JavaScript binary floating point
- minor units remain exact
- currencies remain explicit
- PostgreSQL `BIGINT` values do not pass through unsafe JavaScript `number`
- rounding rules are explicit where relevant

Any new financial calculation must have edge-case tests.

## 5. Preserve immutable history

For posted or accepted financial history:

- do not UPDATE economic meaning
- do not DELETE financial evidence
- use reversals/corrections or new versioned observations
- preserve original provenance

Verify database-level immutability where the existing architecture expects it.

## 6. Verify idempotency and retry safety

For retriable financial commands, verify:

same semantic command repeated N times

produces:

one financial effect

Conflicting reuse of semantic identity must fail explicitly.

If the operation can experience an unknown COMMIT outcome, verify that retry is safe.

## 7. Identify the transaction boundary

For each financially significant command, explicitly determine:

- what must commit atomically
- what must roll back together
- audit records required in the transaction
- outbox/durable-work intent required in the transaction
- locks or constraints required
- retry behavior

Do not introduce dual-write gaps.

## 8. Verify concurrency where relevant

If correctness could change under contention, test actual contention.

Examples:

- duplicate posting
- competing reversal
- duplicate ingestion
- competing reconciliation allocation
- concurrent exception resolution
- worker claiming

Prefer synchronization/barriers or database contention mechanisms over merely running `Promise.all()` and assuming a race occurred.

## 9. Preserve source provenance

For ingestion or normalization changes, verify that the system can still answer:

- what source supplied this record?
- what exact input was received?
- when was it received?
- which source identity/revision did it have?
- which parser/normalizer version interpreted it?
- what normalized record came from it?

Do not silently overwrite corrected upstream observations.

## 10. Preserve reconciliation conservatism

For reconciliation changes:

Similarity is not proof.

Verify that:

- candidates and accepted matches remain distinct concepts
- unexplained differences stay explicit
- allocation cannot exceed available amounts
- the same economic quantity cannot be allocated twice
- reconciliation decisions retain evidence
- rule/version changes do not silently rewrite historical decisions

Human acceptance of risk does not necessarily mean financial reconciliation occurred.

## 11. Preserve oracle isolation

When simulator data is involved:

- runtime/application code must consume only public simulator artifacts
- oracle information must remain test-only
- no reconciliation logic may read expected answers
- dependency-boundary checks must continue to prevent oracle imports

A test is invalid if the system under test can infer the expected result from hidden simulator truth.

## 12. Add the right tests

Choose the strongest applicable tests.

### Unit tests

Use for pure domain logic and deterministic calculations.

### Property-based tests

Use for invariants across broad input spaces.

Strong candidates:

- money arithmetic
- ledger balance
- reversal neutrality
- idempotency
- allocation conservation
- deterministic normalization
- reconciliation conservation

### Real PostgreSQL integration tests

Required for behavior involving:

- transactions
- locks
- constraints
- triggers/functions
- BIGINT
- isolation
- rollback
- concurrent writes

Do not substitute mocks.

### Concurrency tests

Required when duplicate or competing operations can affect financial correctness.

### Failure injection

Use when correctness depends on crash windows or retries.

Examples:

- failure before COMMIT
- failure after COMMIT acknowledgement is lost
- worker crash
- interrupted processing
- duplicate delivery
- out-of-order delivery

## 13. Run repository verification

Use existing repository commands.

Run the strongest applicable verification, typically including:

- format
- lint
- typecheck
- build
- unit tests
- property tests
- PostgreSQL integration tests
- concurrency tests
- migration verification

Do not disable or bypass checks.

If an applicable verification step cannot be run, report that explicitly.

## 14. Review architecture impact

Before completion, determine whether the change modifies:

- an invariant
- domain terminology
- module ownership
- dependency direction
- transaction boundaries
- idempotency semantics
- state machines
- reconciliation semantics
- failure handling
- an ADR-level decision

Update documentation only when the implementation materially changed the architecture.

Do not create unnecessary ADRs.

## 15. Completion evidence

For non-trivial financial changes, report:

1. financial invariants affected
2. files changed
3. behavior implemented
4. database enforcement introduced or changed
5. transaction/concurrency behavior
6. tests added or updated
7. commands executed
8. verification results
9. failure scenarios tested
10. remaining risks or assumptions
11. intentionally deferred work

Distinguish clearly between:

- implemented
- tested
- documented
- assumed
- deferred

Never report financial correctness as verified without evidence.
