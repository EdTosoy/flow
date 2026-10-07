# ADR-011 — Processor claims remain separate from authorized payments

Status: accepted for the explicitly authorized Phase 4 synthetic scope. Date: 2026-10-07.

## Context

Phase 0 defines payments as independent internal intent. Phase 4 asks to group normalized processor observations and calculate processor settlement expectations, while explicitly deferring accounting orchestration. Manufacturing internal authorization from the processor would collapse the evidence boundary. Changed source revisions also have no reliable authoritative order in Phase 3.

## Decision

Introduce processor-scoped payment associations, immutable activity/report derivations keyed by normalized revision/version plus explicit processor interpreter, ordered member-reference evidence and immutable processor-internal evaluation snapshots. Keep authorized internal payments and ledger journals separate. Derive lifecycle and refund validity from the frozen evidence population; retain invalid external claims and fail their validation conservatively. Pin one normalization/interpreter policy per evaluation. Multiple source revisions yield explicit ambiguity; no automatic supersession or receipt-time preference. New source evidence requires a fresh evaluation identity; historical results remain as-of and immutable.

Reuse exact Money, reviewed PostgreSQL guards/uniqueness, separate capability roles and existing audit/outbox tables. No reconciliation allocation, bank proof, review product or asynchronous worker is introduced. The [Phase 4 implementation](../../phase4/README.md) defines exact controls, transaction and supported-source semantics.

## Consequences and verification

Processor association UUIDs express source grouping, not independent business intent. Refund controls validate claims rather than authorize money movement. Settlement arithmetic is useful while source completeness, contractual economics and bank arrival remain unknown. Conservative ambiguity/conflict handling can block composition until later ordering/review policy exists; this is preferable to silently choosing financial history.

Real PostgreSQL tests must cover provenance, immutability, uniqueness, synchronized derivation/association/membership/refund contention, unknown COMMIT outcomes, corrections and frozen calculations. Public simulator artifacts must pass through ingestion/normalization; only the verifier may use oracle truth. Existing financial-core gates remain unchanged.
