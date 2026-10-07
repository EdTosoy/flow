# Exception Domain Guidance

This directory contains exception-management domain logic for unresolved financial conditions.

Read the repository root `AGENTS.md`, relevant architecture documents, Phase 8 documentation, and applicable ADRs before modifying this subsystem.

Use the `verify-financial-change` skill for non-trivial changes.

## Core principle

An exception is an operational workflow around unresolved financial evidence.

It is not financial truth.

The most important rule in this subsystem is:

> A resolved exception does not necessarily mean the underlying money is reconciled.

Never weaken this distinction.

---

## Exception domain vs reconciliation domain

Keep these responsibilities separate.

Reconciliation answers:

> What financial relationship has been proven?

Exception management answers:

> What are operators doing about unresolved or problematic financial evidence?

Do not move reconciliation logic into this package.

Do not mark financial evidence reconciled merely because an exception case was closed, reviewed, acknowledged, classified, assigned, or resolved.

---

## Accepted risk

Accepted risk is an operational resolution.

It explicitly permits:

```text
exception = RESOLVED
resolution = ACCEPTED_RISK
```

while:

```text
financial reconciliation = UNRESOLVED
```

Accepted-risk exposure must not count as reconciled value.

Do not create logic that hides or removes the underlying unreconciled monetary exposure when accepted risk closes the case.

---

## Immutable case history

Historical exception evidence and decisions must remain explainable.

Do not silently rewrite or delete:

- original case evidence
- original classification history
- prior resolution history
- notes
- state-transition history
- reopening history
- supersession relationships

New information should create new history rather than erase old history.

---

## Explicit state machine

Use the established exception lifecycle.

Do not introduce unrelated boolean flags that allow contradictory states.

All transitions must obey the approved state machine.

Invalid transitions must fail explicitly.

Do not bypass transition rules through generic update operations.

---

## Resolution semantics

Resolution must always have explicit structured meaning.

A resolution reason must not silently imply reconciliation.

For every new resolution type, determine whether it:

- leaves financial reconciliation unchanged
- requires a new reconciliation run
- requires a separate accounting action
- requires manual review
- represents accepted risk
- supersedes an earlier operational conclusion

Do not invent new resolution categories casually.

If semantics are unclear, preserve the unresolved state rather than guessing.

---

## Notes are append-only

Human/system notes are operational history.

Do not:

- edit historical notes in place
- delete notes
- replace old notes with new text

Corrections should append new notes.

Notes must retain:

- author/system actor
- timestamp
- case identity

Do not store secrets or unnecessary sensitive data in notes.

---

## Classification

Exception classification is operational metadata.

Classification changes must be auditable.

Do not let changing a classification silently change:

- reconciliation state
- financial exposure
- historical evidence
- current allocation

Classification and financial truth are separate concepts.

---

## Assignment

Assignment changes ownership of work, not financial truth.

Do not allow assignment actions to:

- resolve reconciliation
- modify evidence
- alter allocation
- rewrite financial history

Where assignment changes are persisted, preserve audit history.

---

## Monetary exposure

Use repository Money primitives.

Never use JavaScript floating-point arithmetic for exception exposure.

Exposure must carry explicit currency.

Do not aggregate money across currencies.

If exposure cannot be determined reliably:

```text
exposure = UNKNOWN
```

Do not guess.

---

## Exposure must not be double counted

The same underlying discrepancy may be referenced by:

- reconciliation outcome
- exception case
- control failure
- accepted-risk resolution

Do not count the same economic exposure multiple times merely because it appears in several domains.

Preserve a clear canonical source for financial exposure.

---

## Evidence

Exception evidence should reference immutable existing domain evidence where possible.

Examples:

- reconciliation run
- reconciliation outcome
- processor settlement
- bank observation
- source record
- control failure
- match group

Do not copy mutable summaries and treat them as authoritative evidence.

Evidence identity must remain traceable.

---

## Reopening

A resolved case may require reopening when new evidence materially changes the operational conclusion.

Reopening must:

- preserve the original resolution
- preserve the original evidence
- create an explicit new transition/history event
- record why the case was reopened

Do not mutate the old resolution as if it never happened.

---

## Supersession

New evidence may supersede an old exception or operational conclusion.

Supersession must remain explicit.

Historical cases must remain queryable and explainable.

Do not delete old cases merely because later evidence resolves the underlying financial issue.

---

## Idempotent case creation

Repeated processing of the same logical unresolved condition must not create duplicate active cases.

Use stable semantic identity.

Database uniqueness should remain the final concurrency barrier where applicable.

Concurrent creation attempts must converge safely.

---

## Idempotent resolution

Retrying the same resolution command must not:

- create duplicate history
- duplicate audit events
- duplicate outbox events
- create multiple financial effects
- create multiple reconciliation allocations

Conflicting reuse of command identity must fail explicitly.

---

## Concurrency

Changes affecting case state must consider concurrent actors/workers.

Important races include:

- duplicate case creation
- two reviewers changing state
- resolve vs reopen
- resolve vs supersede
- classification updates
- assignment updates
- accepted-risk resolution vs new reconciliation result

Use real PostgreSQL tests where correctness depends on transactions, uniqueness, locking, or concurrent writes.

---

## Manual reconciliation boundary

If manual reconciliation is implemented later, this domain must not bypass reconciliation invariants.

Manual matching must use the existing reconciliation/allocation mechanisms.

It must still preserve:

- exact amount conservation
- currency consistency
- allocation uniqueness
- evidence
- actor identity
- audit history
- immutable historical reconciliation runs

Do not implement:

```text
case.status = RESOLVED
```

as a shortcut for:

```text
financial state = RECONCILED
```

---

## Audit

Material exception decisions must be auditable.

Examples:

- case creation
- review started
- classification changed
- assignment changed
- note appended where required
- resolution applied
- accepted risk
- case reopened
- case superseded

Audit records should capture enough information to explain:

- actor
- action
- previous state
- new state
- reason
- related evidence

Application logs are not a substitute for audit history.

---

## Outbox

When an exception-domain change requires downstream work, use the repository's existing transactional outbox pattern.

Do not introduce a separate queue architecture.

Audit/outbox intent associated with a successful state transition must obey existing atomicity guarantees.

---

## PostgreSQL enforcement

Prefer PostgreSQL enforcement for critical guarantees where practical.

Examples:

- logical case uniqueness
- state-transition validity
- append-only history
- immutable evidence links
- resolution identity
- reopening/supersession relationships
- audit consistency

Do not rely solely on TypeScript validation when the database can safely enforce the invariant.

---

## Oracle isolation

Runtime exception code must never access simulator oracle information.

Exception cases must be created only from runtime-visible evidence produced by the normal pipeline:

```text
simulator public artifacts
→ ingestion
→ normalization
→ processor/bank domains
→ reconciliation
→ exceptions
```

Oracle information may be used only by test/evaluation code.

A test is invalid if runtime exception logic can read expected answers.

---

## Property expectations

When relevant, preserve properties such as:

- one logical unresolved condition creates at most one active logical case
- valid state transitions only
- resolved does not imply reconciled
- accepted risk remains unreconciled
- historical evidence is immutable
- notes are append-only
- repeated resolution is idempotent
- new reconciliation evidence does not rewrite historical exception history

Use property-based testing where it adds meaningful coverage.

---

## Required review before completion

For any non-trivial exception-domain change, explicitly ask:

1. Could this accidentally mark unreconciled money as reconciled?
2. Could accepted risk disappear from financial exposure?
3. Could historical evidence be overwritten?
4. Could a duplicate case be created?
5. Could two concurrent transitions produce an impossible state?
6. Could retry duplicate a resolution or audit event?
7. Could a new reconciliation result rewrite historical exception history?
8. Could runtime code access simulator oracle truth?
9. Could the same financial discrepancy be counted twice?

If any answer reveals an unresolved correctness risk, do not report the change as complete.
