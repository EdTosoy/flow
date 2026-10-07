# ADR-012 — Bank observations remain independent versioned evidence

Status: accepted for the explicitly authorized Phase 5 synthetic bank scope. Date: 2026-10-07.

## Context

The current task authorizes bank observations as Phase 5, narrowing/reordering the original recommended worker-first milestone. Processor claims and ledger truth already have separate boundaries. Bank-specific identity, stock/flow semantics, statement coverage and intrinsic controls now justify a cohesive bank module. Original architecture places relationship controls in reconciliation; this milestone requires useful source-internal checks before reconciliation exists.

## Decision

Add separate bank domain/persistence packages for immutable booked entries, currency-fixed scoped bank account identities, optional versioned statement reports, explicit membership and signed stock observations. Source-internal statement controls belong to bank; processor-to-bank proof and financial allocation remain future reconciliation responsibilities. No external claim posts accounting or links to processor settlements.

Use the existing Phase 3 raw/revision/normalization path, exact Money, PostgreSQL durability/guard patterns and existing audit/outbox. Register explicit bank normalizers and bank-v1 interpretation. No stable source ID means labeled receipt/revision-local observation identity, never a fabricated upstream ID or amount/reference deduplication. Multiple source revisions remain ambiguous without reliable ordering; pin versions, retain history and freeze as-of evaluations. Full statement closing calculations require independently proven supported membership; unknown controls cannot imply complete coverage.

## Consequences and verification

Local no-ID receipts can remain distinct even when identical; downstream consumers must not silently promote them to authoritative deduplicated bank movements. Cross-currency/conflicting/duplicate source claims stay visible. Conservative selection can leave totals unknown until future source/review policy exists. No standalone authorization product, bank integration, worker, match, case or frontend is introduced.

Real PostgreSQL verification covers immutable normalized provenance, scoped identity, sealed populations, synchronized derivation/membership/correction contention, rollback, control/audit/intent atomicity and actual lost COMMIT acknowledgements. Public simulator artifacts traverse ingestion and normalization; only separate verifiers access oracle truth. [Implemented scope](../../phase5/README.md) and [executed evidence](../../phase5/verification.md) distinguish controls from reconciliation and production readiness.
