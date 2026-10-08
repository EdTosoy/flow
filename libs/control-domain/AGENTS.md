# Financial Control Domain Guidance

This directory contains financial completeness, integrity, exposure, and control-evaluation semantics.

Read the root `AGENTS.md`, relevant architecture documents, ADR-015, Phase 9 documentation, and the `verify-financial-change` skill before making non-trivial changes.

## Core principle

A control answers:

> What can the available evidence prove about financial completeness or integrity?

Never make evidence appear stronger than it is.

## UNKNOWN is first-class

`UNKNOWN` is not a failure to implement the system.

It means available evidence cannot prove PASS or FAIL.

Never convert UNKNOWN to PASS because:

- parsing succeeded
- no error was thrown
- a population is empty
- all received records were processed
- all visible matches succeeded
- no discrepancy was detected among records the system happened to receive

Absence of evidence is not evidence of completeness.

## PASS requires evidence

A control may return PASS only when the evidence required by that control is present and satisfies its rule.

Examples:

- source completeness requires independent completeness evidence
- bank closing controls require the necessary opening/closing/movement evidence
- reconciliation completeness requires a frozen population and complete outcome coverage

Do not manufacture assumptions to obtain PASS.

## Exact money

Use repository Money primitives.

Never use binary floating point for:

- expected values
- observed values
- discrepancies
- exposure
- totals

Never aggregate money across currencies.

Produce separate results per currency.

## Expected and observed remain separate

Do not overwrite or collapse:

- expected value
- observed value
- discrepancy

The discrepancy is derived evidence, not a replacement for either side.

## Exposure must not be double counted

The same economic discrepancy may appear in:

- reconciliation outcomes
- exception cases
- control failures
- accepted-risk records

Do not add these representations together blindly.

Use the canonical exposure source established by Phase 9.

A case referencing an unresolved reconciliation item does not create another copy of the financial exposure.

## Accepted risk remains unreconciled

Phase 8 permits operational closure with `ACCEPTED_RISK`.

That does not make the underlying money reconciled.

Accepted-risk exposure must remain visible as unreconciled financial exposure.

Never include accepted-risk amounts in reconciled-value totals unless a separate valid reconciliation later occurs.

## Immutable control history

Completed control evaluations are historical evidence.

Do not:

- edit historical PASS/FAIL/UNKNOWN results
- replace old control versions
- rewrite frozen input populations
- alter past discrepancies because new evidence arrived

New evidence or new logic requires a new evaluation.

## Frozen inputs

Historical evaluation must be reproducible from its frozen inputs, control version, and configuration.

Do not allow later-arriving evidence to mutate a completed evaluation.

## Versioned semantics

Control logic must have explicit version identity.

Changing control semantics must not silently reinterpret historical results.

## Completeness partitions

Where a control asserts population completeness, every member must be accounted for.

Examples:

received
=

normalized + failed + pending

and:

reconciliation population
=

matched + unmatched + ambiguous + ineligible + other explicitly supported outcomes

No record may silently disappear from a completeness equation.

## Source completeness

Successful ingestion does not prove source completeness.

Distinguish:

- proven complete
- proven incomplete
- unknown

Only independent source evidence may establish completeness.

## Aggregate controls remain independent

Individual successful matches do not prove aggregate correctness.

A bank closing-balance control may fail even if every historical individual reconciliation match remains valid.

Do not suppress aggregate control failures because lower-level records appear healthy.

## Ledger controls

Financial control code may verify ledger invariants.

It must not mutate ledger truth.

Do not create corrective ledger entries from this domain.

## Exception integration

Controls and exceptions are separate domains.

A failed control may create or associate with an exception according to explicit policy.

Do not create duplicate cases for the same logical unresolved condition.

Closing the exception does not rewrite the historical control result.

## Idempotency

Same scope + same frozen inputs + same control version + same configuration should produce one logical evaluation according to the established semantic identity.

Retries must not duplicate:

- runs
- results
- audit events
- outbox events
- linked exception cases

## Concurrency

Changes affecting control evaluation must consider:

- duplicate execution
- newly arriving source evidence
- reconciliation completion
- accepted-risk resolution
- concurrent case creation

Historical evaluations must remain coherent snapshots.

Use real PostgreSQL tests when correctness depends on transactions, locks, snapshots, constraints, or concurrent writes.

## Audit and outbox

Material completed control evaluations should follow existing audit/outbox guarantees.

Do not create a second event-delivery architecture.

## Oracle isolation

Runtime financial controls must never access simulator oracle information.

Oracle truth may only be used by test/evaluation code to determine whether runtime controls detected injected conditions correctly.

## Required review before completion

For any non-trivial control-domain change, ask:

1. Could UNKNOWN accidentally become PASS?
2. Could the same monetary exposure be counted twice?
3. Could currencies be mixed?
4. Could accepted-risk money disappear from unreconciled exposure?
5. Could later evidence rewrite historical results?
6. Could incomplete populations appear complete?
7. Could individual successful matches hide an aggregate discrepancy?
8. Could duplicate execution create duplicate results or cases?
9. Could runtime code access simulator oracle truth?

If any answer exposes unresolved correctness risk, do not report the change as complete.
