# Operations Read PostgreSQL Guidance

This package provides read-only PostgreSQL projections for the operations application.

Read the root `AGENTS.md`, applicable domain-specific guidance, Phase 12 documentation, and architecture documents before making non-trivial changes.

## Core principle

The read model exposes authoritative state for investigation and operations.

It is not an alternate financial domain.

Do not recreate financial truth inside reporting queries.

## Read-only

This package must remain read-only with respect to authoritative financial and operational state.

Do not:

- post ledger entries
- change reconciliation allocations
- resolve exceptions
- alter controls
- retry workers
- modify source evidence
- mutate outbox intent

Use a narrow PostgreSQL read role.

## Authoritative semantics

Prefer consuming established:

- reconciliation results
- control evaluations
- canonical exposure
- exception state
- integrity results
- worker state

rather than rebuilding their semantics from raw tables.

A read model may join and project authoritative results.

It must not become a competing implementation.

## UNKNOWN is data

Never use convenience defaults that change uncertainty into certainty.

Be especially suspicious of:

`COALESCE(value, 0)`

when NULL means unknown/unavailable rather than true zero.

Preserve PASS / FAIL / UNKNOWN exactly.

## Exact money

Use exact monetary representations.

Do not route PostgreSQL monetary `NUMERIC`/`BIGINT` values through unsafe JavaScript floating point.

Keep currency attached to monetary values.

Never aggregate currencies together.

## Canonical exposure

Use Phase 9 canonical exposure semantics.

Do not independently sum reconciliation, exception, control, and accepted-risk representations of the same economic discrepancy.

Accepted-risk exposure remains unreconciled.

## Snapshot semantics

Be explicit about whether a query represents:

- current database state
- a historical run
- a completed control evaluation
- an integrity snapshot
- current freshness of historical evidence

Do not combine incompatible snapshots and describe them as one atomic truth.

Where coherent multi-query observation matters, use the established PostgreSQL snapshot semantics.

## Freshness

Historical evaluations are not automatically current.

Expose evaluation/snapshot timestamps where needed.

Do not silently recompute historical semantics in a read query.

## Query safety

All external parameters must be validated and parameterized.

Never concatenate:

- IDs
- filters
- search terms
- ordering expressions

directly into SQL unless safely selected from a closed internal allowlist.

## Pagination

Keep large results bounded.

Prefer stable/keyset pagination when practical for high-churn or large operational datasets.

Ordering must be deterministic.

Pagination must not silently duplicate or omit rows because of unstable sort keys.

## Performance

Profile before optimizing.

For slow queries:

1. capture actual execution plan
2. identify repeated work
3. identify scans/joins
4. inspect index usage
5. determine whether expensive authoritative calculations are being recomputed
6. optimize the smallest correct layer

Do not immediately add:

- caches
- materialized views
- denormalized financial tables
- duplicated calculations

without measured evidence.

## Indexes

Add indexes for demonstrated query patterns.

Consider:

- selectivity
- ordering
- join keys
- write cost
- index size

Do not create speculative indexes merely because a column appears in a WHERE clause.

## Database views

Views may simplify projections.

They do not become new financial truth.

Do not hide ambiguity or UNKNOWN using view defaults.

Materialized views require explicit freshness semantics and must not silently replace authoritative current data.

## Query plans

Important operational queries should have inspectable `EXPLAIN (ANALYZE, BUFFERS)` evidence during performance work.

Do not optimize based only on intuition.

Keep benchmark dataset characteristics documented.

## No N+1 query patterns

Detail/list pages should not issue avoidable per-row database queries.

Batch related evidence where appropriate.

Do not solve N+1 problems by fetching entire tables.

## Bounded evidence

Investigation details should expose enough evidence to understand a result without dumping unrestricted raw records.

Keep raw/sensitive payload access narrow.

## Errors

A failed query must not become:

- zero
- empty collection interpreted as healthy
- PASS

Return explicit error/unavailable semantics to the application layer.

## Database role

The operations reader role must remain unable to mutate financial truth.

New queries should not require broadening privileges unless there is a documented architectural reason.

Prefer safe views/functions if direct table access would expose unnecessary data.

## Simulator isolation

Runtime read-model code must not access simulator oracle information.

Synthetic public data is acceptable.

Oracle labels remain test-only.

## Integrity

Integrity results may be displayed and queried.

Do not reinterpret an integrity PASS as stronger assurance than that subsystem provides.

Do not convert incomplete integrity execution to PASS.

## Workers

Worker operational state remains distinct from financial state.

`SUCCEEDED` work does not prove financial completeness or reconciliation.

## Testing

Important read-model changes should test:

- exact counts
- exact money serialization
- currency isolation
- UNKNOWN propagation
- canonical exposure
- accepted-risk semantics
- pagination
- filtering
- deterministic ordering
- empty-state behavior
- stale/current semantics
- read-only permissions

Use real PostgreSQL where query semantics depend on PostgreSQL behavior.

## Required review before completion

For any non-trivial read-model change, ask:

1. Is this query recreating financial domain logic?
2. Could NULL/UNKNOWN accidentally become zero or PASS?
3. Could monetary precision be lost?
4. Could currencies be combined?
5. Could exposure be double counted?
6. Could accepted-risk exposure disappear?
7. Could multiple inconsistent snapshots be presented as one?
8. Could pagination skip/duplicate data?
9. Could input reach SQL unsafely?
10. Could this require broader database permissions than necessary?
11. Is the query slow because of actual database work, or application N+1/repetition?
12. Are we adding caching/denormalization before proving it is necessary?

If any answer reveals unresolved correctness risk, do not report the change as complete.
