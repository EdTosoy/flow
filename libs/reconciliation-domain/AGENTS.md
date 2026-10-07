# Reconciliation subsystem

This directory contains reconciliation logic.

Read the root `AGENTS.md` and relevant reconciliation architecture documents before modifying this subsystem.

## Core rule

Reconciliation means:

> Sufficient explicit evidence proves that financial records represent the same economic movement according to a named reconciliation rule.

Similarity is not proof.

When evidence is insufficient or ambiguous, remain unreconciled.

## Candidates are not matches

Keep these concepts distinct:

- candidate
- accepted match
- current allocation
- historical reconciliation result

Candidate generation must never mutate reconciliation truth.

A candidate may become:

- matched
- unmatched
- ambiguous
- ineligible

according to the supported state model.

## Preserve ambiguity

Never resolve ambiguity using arbitrary ordering such as:

- first row
- UUID order
- insertion order
- received time
- lexical order

unless that ordering itself is authoritative source evidence.

If more than one valid counterpart exists, do not automatically reconcile.

## Exact money

Reuse repository money primitives.

Never use JavaScript floating point for:

- match amounts
- allocations
- settlement totals
- reconciliation balances

Do not aggregate across currencies.

## Allocation safety

The same economic quantity must not be actively reconciled twice.

Preserve database-enforced uniqueness/allocation guards.

Concurrency must not allow two workers to consume the same processor or bank evidence.

## Historical immutability

Completed reconciliation runs are historical evidence.

Do not:

- edit completed run populations
- rewrite historical decisions
- replace old rule versions
- mutate historical evidence because a later source revision arrives

New information requires a new run or explicit supersession/current-state transition.

## Frozen populations

A completed run must account for its entire frozen input population.

No input may disappear because:

- no candidate was found
- the record was difficult to interpret
- a worker failed
- evidence became ambiguous

Coverage must remain provable.

## Rule versioning

Every accepted decision must be attributable to:

- rule/version
- configuration
- input evidence
- reconciliation run

Changing matching logic must not silently change historical results.

## Provenance

Every reconciliation decision must retain links to the exact processor and bank evidence used.

Do not derive matches from mutable "latest" views when immutable evidence identities are available.

## Source revisions

A later processor or bank correction does not rewrite a previous run.

If revision ordering is ambiguous, do not guess which revision is authoritative.

Ambiguous evidence should remain ineligible or unresolved according to the established rules.

## Internal controls

Respect processor-side and bank-side control failures.

Do not auto-reconcile evidence whose relevant upstream controls make it untrustworthy.

Avoid over-blocking unrelated evidence.

## Current vs historical state

Do not confuse:

- what a historical run concluded
- what is currently considered reconciled

Current allocation state may evolve.

Historical evidence may not.

## Grouped reconciliation

When grouped matching is implemented:

- explicit membership is required
- every member contribution must be exact
- total allocation must conserve money
- no member may be double-consumed
- arbitrary N:M matching is not allowed unless explicitly designed and approved
- group selection must remain deterministic and explainable

## No heuristic shortcuts

Do not introduce without an explicit architecture decision:

- fuzzy string matching
- amount tolerance
- probabilistic confidence
- ML matching
- LLM-based matching
- first-best-candidate selection

If such approaches are added later, they should normally produce candidates rather than authoritative matches unless stronger controls are approved.

## Oracle isolation

Runtime reconciliation must never depend on simulator oracle information.

Oracle data may only be used by test/evaluation code to measure reconciliation performance.

A reconciliation test is invalid if runtime code can access expected answers.

## Concurrency testing

Changes affecting allocation or matching must use real PostgreSQL tests where correctness depends on:

- uniqueness
- locking
- transactions
- concurrent workers
- retries
- unknown commit outcomes

Do not rely only on mocks.

## Required review before completion

For reconciliation changes, explicitly check:

1. Could this produce a false positive match?
2. Could ambiguity be silently resolved?
3. Could the same money be allocated twice?
4. Could historical results be rewritten?
5. Could a new source revision invalidate current reconciliation?
6. Could a crash leave a falsely completed run?
7. Could runtime code access simulator oracle data?
8. Are all scoped inputs still accounted for?

If any answer reveals an unresolved correctness risk, do not report the change as complete.
