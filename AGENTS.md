# AGENTS.md

## Repository purpose

This repository implements a production-oriented financial reconciliation system.

The system is designed to reconcile financial activity across internal records, payment processors, settlements, bank observations, and an internal double-entry ledger.

The core product principle is:

> No unexplained financial discrepancy should fail silently.

Correctness, auditability, recoverability, and explicit financial state are more important than implementation speed or architectural novelty.

---

## Read before changing anything

Before making changes:

1. Read this file.
2. Read the relevant architecture documents under `docs/architecture/`.
3. Read applicable ADRs under `docs/architecture/adr/`.
4. Inspect the current working tree.
5. Trace the existing implementation and tests before proposing changes.
6. Do not assume the task description overrides repository architecture or financial invariants.

If requested work conflicts with an invariant or ADR, do not silently implement around it.

Explain the conflict and prefer the safer design.

---

## Current architecture

The repository currently uses:

- Nx
- pnpm
- TypeScript
- PostgreSQL
- Node.js
- `pg`
- property-based testing with `fast-check`
- real PostgreSQL integration testing

Current financial-core dependency direction:

```text
@flow/money
    ↑
@flow/ledger-domain
    ↑
@flow/ledger-postgres
```

Dependencies must remain acyclic.

Lower-level financial packages must not depend on higher-level business domains.

---

## Architectural direction

The intended broader system is a modular monolith.

Expected future technologies include:

- Next.js
- NestJS
- PostgreSQL
- Docker
- AWS
- Terraform

Do not introduce the following unless a task explicitly requires them and there is a demonstrated architectural need:

- microservices
- Redis
- BullMQ
- Kafka
- Redpanda
- Kubernetes
- Rust
- Python
- AI/LLMs
- blockchain
- event sourcing as a blanket architecture

Do not add infrastructure merely for portfolio appearance.

Prefer the simplest architecture that preserves correctness and can evolve later.

---

# Financial invariants

Financial correctness is the highest-priority constraint in this repository.

Never weaken an invariant to make implementation easier.

Consult `docs/architecture/invariants.md` for the authoritative catalog.

At minimum preserve the following principles.

## Exact money

Never use JavaScript binary floating point for monetary arithmetic.

Use exact integer minor-unit representations and explicit currencies.

Do not convert PostgreSQL `BIGINT` financial values into unsafe JavaScript `number` values.

---

## Double-entry accounting

Every posted journal must balance according to the supported currency/accounting rules.

A journal must never become posted financial truth if it is unbalanced.

Do not rely only on application validation where PostgreSQL can enforce correctness.

---

## Atomic financial writes

A financial operation must not partially commit.

Operations such as journal posting must atomically persist all required financial state.

Where required by the existing design, associated audit and outbox records must commit in the same PostgreSQL transaction.

---

## Immutable posted history

Posted financial records must not be silently edited or deleted.

Corrections must create new financial history.

Use reversals rather than mutation of posted journals.

Do not introduce generic UPDATE or DELETE repository methods for immutable financial records.

---

## Semantic idempotency

At-least-once delivery and retries are expected.

The same logical command executed repeatedly must create at most one financial effect.

Database uniqueness and semantic identity are the final concurrency barriers.

Do not claim or depend on exactly-once message delivery.

Conflicting reuse of an idempotency key must be detected explicitly.

---

## External facts are not internal accounting facts

Keep these concepts distinct:

- raw external records
- normalized external observations
- internal accounting records
- reconciliation evidence
- reconciliation decisions

Do not collapse an external processor transaction and a ledger entry into one entity.

---

## Explicit uncertainty

Unknown or unexplained financial state must remain visible.

Never silently discard, auto-close, or mark a discrepancy reconciled because the system cannot explain it.

Future reconciliation workflows should prefer states such as:

- pending
- reconciled
- exception
- under review
- resolved

Similarity is not proof.

---

## Auditability

Important financial decisions must remain explainable.

Audit data is not the same as application logging.

Do not remove or rewrite historical audit evidence.

Avoid storing secrets or unnecessary sensitive data in audit records.

---

## AI trust boundary

AI is outside the trusted financial core.

If AI is introduced later, it may assist with:

- classification
- summarization
- evidence gathering
- suggested explanations
- suggested actions

AI must not independently:

- modify posted ledger history
- invent financial records
- move money
- resolve unexplained discrepancies as fact
- bypass accounting controls

---

# Database rules

PostgreSQL is the authoritative durability boundary.

Prefer database-enforced correctness where practical.

Important constraints may use:

- primary keys
- foreign keys
- unique constraints
- CHECK constraints
- triggers
- deferred constraints
- functions
- row locks
- advisory locks
- transaction isolation

Do not assume ORM or TypeScript validation alone protects financial state.

Raw SQL is acceptable and expected when database-level enforcement requires it.

---

## Transactions

Use explicit PostgreSQL transactions for financially significant operations.

Choose isolation levels deliberately.

Do not globally use `SERIALIZABLE` without justification.

Prefer:

- constraints where sufficient
- targeted row/advisory locks where necessary
- retryable transactions for deadlocks or serialization failures

Retries must preserve the original semantic command.

---

## Unknown commit outcomes

A lost connection around `COMMIT` does not prove failure.

Do not blindly recreate financial work after an uncertain commit result.

Recover using semantic idempotency and durable identity.

---

# Asynchronous processing

Financial correctness must not depend on successful message delivery.

Use transactional outbox semantics where downstream work must follow a committed financial operation.

The database transaction represents truth.

Messages represent notification of committed truth.

Consumers must be idempotent.

Do not introduce a message broker unless there is a concrete requirement or demonstrated scaling need.

---

# Testing requirements

Do not weaken, skip, disable, or mock away financial correctness checks.

Use the strongest practical verification for the change.

## Unit tests

Use for:

- exact money behavior
- pure domain rules
- deterministic state transitions
- serialization
- calculation logic

---

## Property-based tests

Use property-based testing where invariants apply across large input spaces.

Strong candidates include:

- money arithmetic
- balanced journals
- idempotency
- reversal neutrality
- entry ordering independence
- reconciliation invariants when implemented

---

## PostgreSQL integration tests

Behavior depending on PostgreSQL must be tested against real PostgreSQL.

Examples:

- transactions
- constraints
- triggers
- locks
- isolation
- BIGINT behavior
- rollback
- concurrent inserts
- deadlocks
- advisory locking
- deferred validation

Do not replace these tests with mocks.

---

## Concurrency tests

Concurrency-sensitive behavior must be tested deliberately.

Prefer synchronized contention or barriers over simply using `Promise.all()` and assuming a race occurred.

Important examples include:

- duplicate posting
- competing reversal
- conflicting idempotency
- concurrent reconciliation allocation
- worker claims

---

## Failure testing

Where relevant, test failures around:

- before transaction start
- before COMMIT
- immediately after COMMIT
- unknown commit result
- worker crash
- delayed processing
- duplicate delivery
- out-of-order delivery

A crash must not duplicate financial effects or silently lose committed work.

---

# Simulator rules

The simulator is a first-class subsystem, not merely fixture generation.

When implemented:

- scenarios must be deterministic by seed
- the same seed must reproduce the same scenario
- injected failures must have known ground truth
- oracle/ground-truth data must be isolated from the system under test

The application must not be able to read the answer from the simulator oracle.

---

# Reconciliation rules

When reconciliation is implemented, be conservative.

A record should be considered reconciled only when the relationship is supported by explicit evidence and the configured reconciliation semantics.

Support should evolve toward:

- 1:1 matches
- N:1 settlement matches
- explicit 1:N cases

Do not design around a single foreign key if grouped matching is required.

Do not prematurely implement arbitrary N:M matching.

Amount/date similarity may generate candidates.

It must not automatically become proof.

---

# State modeling

Prefer explicit state machines over unrelated boolean flags.

Avoid models that can represent impossible combinations such as:

```text
matched = true
failed = true
processed = false
resolved = true
```

Define valid transitions and reject illegal ones.

Do not add lifecycle states unless they represent real domain meaning.

---

# Security

Treat financial mutation as privileged behavior.

Do not expose generic mutation paths to immutable financial tables.

Keep command/write interfaces separate from read interfaces where practical.

Do not print, commit, or log secrets.

If credentials or secrets are found in the repository:

- do not echo their values
- report the affected path
- recommend rotation where appropriate

---

# Change discipline

Implement the smallest coherent change required by the task.

Do not perform unrelated refactors.

Do not introduce abstractions without a concrete need.

Do not rename financial concepts casually.

Do not change an invariant silently.

Do not redesign the architecture merely because another pattern is fashionable.

If a dependency is added, justify why the existing stack cannot reasonably perform the task without it.

---

# Documentation

Architecture documents and implementation must remain consistent.

Update documentation when a change materially alters:

- financial invariants
- domain terminology
- schema ownership
- transaction boundaries
- idempotency semantics
- state machines
- reconciliation semantics
- failure behavior
- architectural decisions

Create or update an ADR only for consequential decisions.

Do not generate ADRs for trivial implementation details.

---

# Verification before completion

Before reporting work as complete, run the strongest applicable subset of repository verification.

Typical checks include:

```text
format
lint
typecheck
build
unit/property tests
PostgreSQL integration tests
concurrency tests
migration verification
```

Use the repository's existing commands rather than inventing parallel verification workflows.

Do not report a check as passed unless it was actually run successfully.

If something could not be run, say so explicitly.

---

# Completion report

For non-trivial tasks, report:

1. files changed
2. behavior implemented
3. important architectural decisions
4. database/schema changes
5. invariants affected
6. tests added or changed
7. commands run
8. verification results
9. unresolved risks or assumptions
10. intentionally deferred work

Distinguish clearly between:

- implemented
- tested
- documented
- assumed
- deferred

Never describe proposed behavior as verified behavior.

---

# Current project status

Phase 0 architecture is complete.

Phase 1 financial core is complete and verified.

Phase 2 deterministic simulator is complete and verified.

Phase 3 ingestion and normalization is complete and verified within its documented synthetic evidence boundary; consult `docs/phase3/verification.md` for acceptance evidence and limitations.

Current implemented financial core includes:

- exact `bigint` money
- immutable double-entry ledger
- atomic posting
- semantic idempotency
- reversals
- append-only audit
- transactional outbox intent
- PostgreSQL concurrency controls
- failure and unknown-commit recovery tests

Phase 3 includes immutable raw receipts, scoped source revisions, versioned synthetic movement interpretations, explicit processing dispositions and source coverage evidence. Runtime ingestion cannot access the simulator oracle or post ledger history.

Phase 4 processor interpretation is complete and verified within its documented synthetic claim boundary; consult `docs/phase4/verification.md`. Scoped processor payment associations, immutable activity/report interpretations, itemized settlement evidence and frozen internal-control evaluations remain separate from independent business authorization, ledger history and bank truth.

Phase 5 bank interpretation is complete and verified within its synthetic booked-evidence boundary; consult `docs/phase5/verification.md` for acceptance evidence and limitations. Scoped bank accounts, immutable entries/statements/memberships/balance observations and frozen bank-internal controls remain separate from processor claims, ledger history and reconciliation proof. No authoritative ordering or cross-import unidentified-entry deduplication is assumed.

The following are not yet implemented:

- independently authorized internal payment commands and accounting orchestration
- reconciliation engine
- real bank ingestion/integrations
- payment processor integration
- exception workflow
- frontend
- asynchronous publisher/consumer infrastructure
- cloud infrastructure
- AI investigation

Do not assume deferred functionality already exists.

---

# Default engineering posture

When choosing between:

```text
clever
```

and:

```text
boring, explicit, testable, recoverable
```

choose the second.

For financial code, correctness is a feature.
