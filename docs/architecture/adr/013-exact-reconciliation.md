# ADR-013 — Exact settlement-bank proof with historical runs and current allocations

Status: accepted for the explicitly authorized synthetic Phase 6 1:1 scope. Date: 2026-10-07.

## Context

Processor and bank interpretations are immutable independent evidence, with no authoritative ordering for corrected revisions. Exact reference evidence exists in the public synthetic contract. Pair-only foreign keys, latest-receipt selection or per-run allocation uniqueness would weaken ADRs 008/010 and INV-005/010/013/014.

## Decision

Implement immutable scoped reference-contract mappings, stable economic source-fact items, REPEATABLE READ frozen populations, deterministic candidate/plan/outcome evidence, typed match groups and whole-item current allocations across runs. The only automatic shape is 1:1; exact reference, amount/currency/direction, fixed UTC booking window, intrinsic controls and mutual candidate uniqueness are all required. No similarity fallback.

Use recoverable DRAFT → SEALED → RUNNING → COMPLETED stages and bounded atomic result batches. Preserve Phase 0 pending uncertainty through explicit UNMATCHED/AMBIGUOUS/INELIGIBLE run outcomes without introducing an exception product. Historical MATCHED records remain as-of conclusions; current assurance requires a valid allocation. Fresh read checks immediately invalidate current assurance when source/control/reference evidence changes. A subsequent run retires invalid reservations or supersedes the same pair through immutable linked audited decisions. Stale frozen results and occupied-resource conflicts are explicit activation outcomes, not active matches.

Reuse existing PostgreSQL owner/capability model, exact Money and typed audit/outbox companions. Book lock followed by sorted source locks and run lock deliberately serializes current-state changes for this bounded phase. Uniqueness/guards are final barriers; receipt, derivation, candidate, historical match and current allocation retain distinct identities.

## Consequences and verification

Historical match rates must never imply current or source-completeness assurance. Source period coverage stays UNKNOWN without independent closure; scoped acquisition/statement evidence remains separately visible. No current-validity result is cached without freshness. Read-time invalidation does not fabricate a supersession decision; durable retirement is appended by the next controlled run. Production reference contracts, shared multi-provider bank mapping, authoritative source revision selection, N:1/1:N and review/worker workflows remain deferred.

Verify real PostgreSQL frozen snapshots, complete partitions, explicit ambiguity, cross-run allocation uniqueness, immutability, corrected evidence, observed lock contention, stage failure rollback and actual lost COMMIT acknowledgements. Full public simulator evidence traverses ingestion/normalization/processor/bank interpretation; only a separate verifier sees oracle truth. [Concrete rules and limitations](../../phase6/README.md); [executed evidence](../../phase6/verification.md).
