# ADR-014 — Operational cases preserve financial proof boundaries

Status: accepted for the explicitly authorized synthetic Phase 8 scope. Date: 2026-10-07.

## Context

Completed Phase 6/7 outcomes are immutable engine evidence. Humans need review, notes, classification and dispositions without changing those outcomes, hiding exposure, ranking unordered source corrections or bypassing current allocation controls. Phase 0 already distinguishes resolved from reconciled and separates domain ownership.

## Decision

Create separate exception domain/persistence packages. The pure exception domain uses Money only; composition joins immutable reconciliation IDs and read contracts through reviewed SQL. No exception command writes reconciliation, allocation, ledger or source tables.

Use one lifetime case per mapped relationship and stable source item, with immutable original outcome and append-only later occurrences. Persist versioned immutable workflow decisions with explicit OPEN/UNDER_REVIEW/AWAITING_EVIDENCE/RESOLVED state. A current read projection selects the last decision; expected versions and row locks guard commands. This is a bounded operational decision history, not blanket financial event sourcing. Complete case/decision/evidence/audit/outbox transactions and PostgreSQL uniqueness remain final barriers.

Operational dispositions, including accepted risk, never imply reconciliation. Exposure is exact Money only where uniquely justified, otherwise unknown. Partition reports by side and currency to avoid counting both sides of one pair residual as additive exposure. Fresh existing allocation proof from a later completed run is required for FIXED_AND_VERIFIED closure or explicit SUPERSEDE of an already resolved case. SUPERSEDE appends a new operational conclusion and exact later outcome link while preserving the original resolution. It creates no financial allocation.

Explicit generation records all completed unresolved outcomes, and historical matched outcomes without a fresh current successor. New unseen unresolved conditions reopen resolved cases during that command; previously seen condition replay preserves the reviewed conclusion. Explicit reopening requires changed unresolved evidence from another completed run. Current-proof reads remain independent; no background scheduler is introduced. Replaying an old outcome must not itself invalidate or restore financial proof.

Defer manual matching: current named rules lack an independent manual-reference approval model. No force-match, source revision selection, accounting correction, priority/SLA scheduler or production identity-management capability is added.

## Consequences and verification

One case can accumulate many conditions/classifications over time; historical original and later evidence remain navigable. Separate cases for processor and bank items can describe one relationship discrepancy; counts and side-separated exposures must state this convention. Unknown and stale economic assurance stays visible. Synthetic actor claims plus database principals are attributable but are not production authorization or two-person approvals. Owners/superusers remain trusted.

Verify real PostgreSQL unique case/occurrence/command identities, guarded event chains, immutable evidence/notes, stale-version races, observed lock contention, companion rollback, backend death, lost successful COMMIT acknowledgements and unchanged semantic retry. Verify the public simulator → ingestion → processor/bank → reconciliation → cases path, zero accepted-risk allocation effects, correction/reopening/supersession history and oracle dependency denial. Preserve all Phase 1–7 regression gates. [Semantics](../../phase8/README.md); [execution record](../../phase8/verification.md).
