# Integrity PostgreSQL Guidance

This directory contains the system-wide PostgreSQL integrity verification layer.

Read the repository root `AGENTS.md`, relevant nested `AGENTS.md` files, Phase 11 documentation, and the `verify-financial-change` skill before making non-trivial changes.

## Core principle

The integrity subsystem verifies financial and operational state.

It is not the source of financial truth.

It must never repair, reinterpret, or silently normalize the state it inspects.

The intended relationship is:

```text
authoritative domain state
        ↓
integrity verification
        ↓
PASS / FAIL / UNKNOWN + evidence
```

Verification observes truth.

It does not create truth.

---

## Read-only by default

Integrity code must remain read-only with respect to financial and operational domain state.

Do not use integrity checks to:

- create ledger entries
- alter source evidence
- normalize records
- change reconciliation allocations
- resolve exceptions
- rewrite controls
- retry workers
- repair outbox state
- mutate historical records

If integrity detects a problem, report it.

Repair belongs to the owning domain through an explicit command or future remediation workflow.

---

## No automatic repair

Never implement:

```text
detect invariant violation
→ silently fix invariant violation
→ report PASS
```

That destroys evidence.

The correct behavior is:

```text
detect invariant violation
→ report FAIL or UNKNOWN
→ preserve evidence
```

Any remediation must be explicit, auditable, and owned by the appropriate domain.

---

## PASS / FAIL / UNKNOWN

Preserve explicit three-state assurance semantics where applicable.

### PASS

Use PASS only when available evidence proves the invariant.

### FAIL

Use FAIL when available evidence proves the invariant is violated.

### UNKNOWN

Use UNKNOWN when available evidence is insufficient to prove either PASS or FAIL.

Never turn UNKNOWN into PASS because:

- the queried table is empty
- no exception was thrown
- no violating row was found in an incomplete population
- a worker finished successfully
- all visible records reconciled
- no source expectation exists

Absence of detected failure is not always proof of correctness.

---

## Financial truth remains domain-owned

The integrity package may verify state owned by:

- ledger
- ingestion
- normalization
- processor
- bank
- reconciliation
- exceptions
- financial controls
- workers/outbox

It must not become an alternate implementation of those domains.

Prefer querying established authoritative state and reusing existing control semantics rather than reproducing business logic independently.

---

## Independent verification

Where useful, integrity checks should provide an independent structural verification path.

Examples include:

- ledger debit/credit equality
- allocation uniqueness
- reconciliation population coverage
- immutable-history consistency
- worker-state consistency
- orphaned durable intent

Do not simply call a domain command and declare the domain correct because the command returned successfully.

---

## Snapshot consistency

System-wide verification must observe a coherent database state.

Use the established `REPEATABLE READ` snapshot approach where multiple related queries must describe one logical observation.

Do not mix unrelated snapshots and present the result as one atomic integrity evaluation.

---

## Current state vs historical evidence

Be explicit about whether a check validates:

- current operational state
- a historical frozen run
- immutable historical evidence
- current freshness of historical evidence

Do not rewrite historical conclusions based on later evidence.

A historical reconciliation or control run may remain valid historically while becoming stale for current-state assurance.

---

## Integrity sweep is not tamper-proof evidence

The current-state integrity sweep is an engineering verification mechanism.

Do not describe it as:

- cryptographic attestation
- tamper-proof audit evidence
- regulatory certification
- forensic proof

unless those properties are actually implemented.

Be precise about the guarantee provided.

---

## Ledger checks

Integrity verification may check:

- journal balance
- debit/credit equality
- valid posted states
- entry cardinality
- book and currency consistency
- immutable-history expectations

Do not generate balancing entries.

An unbalanced ledger must produce a visible failure.

---

## Source and provenance checks

Verify relevant guarantees such as:

- immutable raw evidence
- revision relationships
- processing disposition coverage
- source completeness where independent expectations exist
- normalization coverage

Do not infer source completeness merely because all received records processed successfully.

---

## Processor and bank checks

Reuse established processor and bank controls where appropriate.

Integrity verification must not invent alternative economic calculations that conflict with the canonical domain logic.

If independent structural checks are added, document why they are valid and what they prove.

---

## Reconciliation checks

Verify important invariants such as:

- frozen population consistency
- outcome coverage
- active allocation uniqueness
- exact conservation
- currency isolation
- historical immutability

Do not decide new matches from the integrity layer.

Integrity verification may detect that reconciliation state is invalid; it must not reconcile money itself.

---

## 1:1 and grouped allocation safety

Integrity checks must detect, where applicable:

- one economic item allocated more than once
- overlapping active grouped allocations
- invalid contribution totals
- mixed currencies
- missing group membership
- allocations inconsistent with frozen reconciliation evidence

Never resolve ambiguity by selecting a winner.

---

## Exception checks

Verify exception-state consistency without treating operational closure as financial resolution.

A case marked:

```text
ACCEPTED_RISK
```

may be operationally closed while the associated money remains unreconciled.

Integrity checks must preserve this distinction.

---

## Exposure checks

Financial exposure must not be double counted merely because the same discrepancy appears in:

- reconciliation state
- exception state
- financial controls
- accepted-risk records

Use the established canonical exposure semantics.

Do not sum representations of the same economic discrepancy.

---

## Financial controls

Integrity verification may consume or validate existing control results.

Do not convert:

```text
UNKNOWN
```

into PASS.

Do not replace versioned control evaluations with ad hoc integrity logic.

A successful integrity query does not make an underlying UNKNOWN financial control PASS.

---

## Worker and outbox checks

Verify operational invariants such as:

- valid worker state combinations
- no impossible lease metadata
- monotonic attempt history
- durable work visibility
- terminal failure visibility
- abandoned/recoverable leases
- immutable original outbox intent
- no duplicate semantic domain effects where detectable

Do not process, retry, or mutate work from the integrity layer.

---

## Worker success is not financial success

A worker state of:

```text
SUCCEEDED
```

proves only that the handler completed according to its contract.

It does not prove:

- reconciliation succeeded
- financial exposure is zero
- source data is complete
- a financial control passed

Keep operational and financial assurance separate.

---

## Immutable history

Integrity checks should detect attempted or accidental rewriting of immutable history.

Relevant areas include:

- ledger
- raw source evidence
- normalized interpretations
- reconciliation runs/results
- exception history
- completed financial controls
- outbox payloads
- worker attempt history

Do not mutate history to make the sweep pass.

---

## Exact money

Use repository Money semantics.

Never convert exact financial values to JavaScript floating point for integrity decisions.

Never aggregate different currencies into one monetary total.

If cross-currency reporting is required in the future, it needs an explicit FX model and architecture decision.

---

## Evidence

A reported violation should include enough structured evidence to investigate the problem.

Prefer identifiers and bounded metadata such as:

- invariant identifier
- book
- run
- transaction
- source record
- allocation
- exception
- control
- work item

Avoid dumping:

- secrets
- credentials
- raw sensitive payloads
- unnecessary personal data

---

## Stable invariant identifiers

Important integrity checks should have stable names or identifiers.

This makes failures:

- searchable
- testable
- comparable over time
- usable in CLI/observability surfaces

Do not silently rename invariant meanings without updating documentation/tests.

---

## No oracle access

Runtime integrity code must never access simulator oracle truth.

Oracle information may be used only by test/evaluation code after runtime processing to determine whether the integrity subsystem detected injected failures correctly.

Preserve import/dependency isolation.

---

## Test-only corruption

Tests may deliberately create invalid states to prove detection.

Prefer:

- rollback-only corruption
- isolated test databases
- privileged test-only sessions

Do not commit deliberately corrupt financial state merely to test the integrity sweep.

Verify original valid state survives the test.

---

## PostgreSQL permissions

The integrity runtime role should remain narrow and read-oriented.

Do not grant mutation privileges simply because a new verification query needs access.

Where sensitive tables should remain inaccessible, expose the minimum safe information needed through approved views/functions.

---

## Privileged-user limitations

Be precise about PostgreSQL ownership/superuser guarantees.

Application/runtime protections do not necessarily protect against:

- database owner
- superuser
- trusted infrastructure administrator

Do not claim stronger tamper resistance than PostgreSQL actually provides.

---

## Concurrency

Integrity verification must tolerate concurrent system activity according to its documented snapshot semantics.

When checking a coherent state:

- freeze the verification snapshot
- do not mix pre-change and post-change rows accidentally
- clearly distinguish current snapshot state from later arrivals

Concurrency tests should use real PostgreSQL where transaction semantics matter.

---

## Failure handling

An integrity check failure must not leave the system in a worse state.

Because verification is read-only, database/query failure should result in:

- incomplete verification
- explicit error/UNKNOWN as appropriate

not partial remediation.

Do not report PASS when the sweep itself failed to complete.

---

## Partial sweep behavior

If some required checks cannot execute, do not report the entire system as healthy.

Represent incomplete verification explicitly.

A subsystem verification failure may require:

```text
UNKNOWN
```

or an overall incomplete/error status depending on the established contract.

---

## Performance

Integrity verification should be safe to run in development and operations without unnecessarily locking financial workloads.

Prefer:

- indexed reads
- bounded queries
- snapshot consistency
- efficient aggregation

Do not sacrifice correctness for speed.

Do not introduce long-running blocking locks simply to obtain a "clean" snapshot unless explicitly justified.

---

## Operational summary

Integrity summaries should distinguish financial assurance from operational health.

For example:

```text
Financial integrity
ledger                     PASS
source completeness        UNKNOWN
processing completeness    PASS
reconciliation integrity   PASS
exposure integrity         FAIL

Operations
open exceptions            4
terminal work              1
unknown controls            2
```

Do not collapse this into a single green/red flag that hides uncertainty.

---

## UI consumers

Future dashboards may consume integrity results.

UI code must treat the integrity subsystem as a read/verification surface.

Do not move integrity semantics into React components or duplicate invariant calculations in the frontend.

The backend/database remains authoritative for integrity evaluation.

---

## Property expectations

Useful integrity properties include:

- valid state always passes corresponding structural invariant
- deliberately invalid state fails the relevant invariant
- incomplete evidence never produces false PASS
- repeated sweep of unchanged state produces equivalent logical results
- concurrent later writes do not mutate a completed snapshot result
- currencies are never accidentally aggregated
- the same financial exposure is not counted twice
- worker success cannot override financial UNKNOWN/FAIL
- integrity verification does not mutate domain state

Use property-based tests where they materially strengthen confidence.

---

## Required review before completion

For any non-trivial integrity change, explicitly ask:

1. Could this check mutate financial or operational truth?
2. Could missing evidence accidentally produce PASS?
3. Could this duplicate business logic and disagree with the owning domain?
4. Could different database snapshots be combined into one misleading result?
5. Could historical evidence be confused with current-state assurance?
6. Could accepted-risk money appear reconciled?
7. Could financial exposure be double counted?
8. Could currencies be mixed?
9. Could worker success be mistaken for financial correctness?
10. Could the integrity runtime access simulator oracle data?
11. Could a failed/incomplete sweep still appear healthy?
12. Are we claiming stronger tamper resistance than the system provides?

If any answer exposes unresolved correctness risk, do not report the change as complete.
