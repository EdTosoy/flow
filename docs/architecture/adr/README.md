# Architecture decision records

These Phase 0 decisions were approved as the current design baseline on 2026-10-07. Their original proposal text is retained as design history; approval is not production sign-off. ADR-004 records the conservative Phase 1 reversal/lifecycle scope, and the [implementation specification](../../phase1/README.md) records concrete enforcement. Supersede with a new ADR when a consequential assumption changes.

| ID | Decision |
| --- | --- |
| [ADR-001](001-modular-monolith.md) | Modular monolith with API/worker processes |
| [ADR-002](002-postgresql-durability.md) | PostgreSQL authoritative durability boundary |
| [ADR-003](003-exact-money.md) | Exact minor-unit money and explicit currencies |
| [ADR-004](004-immutable-ledger.md) | Immutable double-entry ledger and reversals |
| [ADR-005](005-transactional-outbox.md) | Transactional outbox for durable downstream intent |
| [ADR-006](006-at-least-once-idempotency.md) | At-least-once processing and semantic idempotency |
| [ADR-007](007-postgresql-workers.md) | PostgreSQL-backed asynchronous execution in V1 |
| [ADR-008](008-grouped-reconciliation.md) | Scoped grouped proof and stable allocation identities |
| [ADR-009](009-ai-trust-boundary.md) | AI outside the trusted financial core |
| [ADR-010](010-evidence-and-completeness.md) | Separate versioned evidence and independent completeness |
| [ADR-011](011-processor-interpretations.md) | Processor claims separate from authorized payments; immutable versioned evaluations |
| [ADR-012](012-bank-observations.md) | Independent bank observations and stock/flow identity; intrinsic controls before reconciliation |

- [ADR-013: exact settlement-bank proof](013-exact-reconciliation.md) — accepted for synthetic Phase 6 only.

ADR-008 is now accepted for Phase 7 synthetic complete-declaration N:1 settlement-bank proof; future cardinalities remain deferred.
