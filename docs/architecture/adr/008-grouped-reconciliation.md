# ADR-008 — Grouped, scoped reconciliation proof

Status: accepted for the authorized synthetic Phase 7 settlement-bank N:1 scope. Date: 2026-10-07.

## Context

Settlements net multiple captures/refunds/fees, while refunds may split. A pair-only schema blocks these relationships; an arbitrary N:M graph can conceal ambiguity and double consumption.

## Decision

Use immutable run populations, versioned rules, match groups/members with typed roles and exact signed equations. Stable economic items/facets have one active allocation per relationship scope across runs. Implement conservative 1:1 then N:1 itemized settlement proof; preserve evolution to explicit 1:N with whole-item components. Separate manual accepted-risk resolution from deterministic reconciliation. See [semantics](../reconciliation.md).

## Consequences and alternatives

One fact can prove different scopes without reuse within a scope. Current allocation index and proof revocation require transactional coordination and lineage. A single `matched_to_id` or uniqueness only within one run is insufficient. Generic subset search, probabilistic auto-confirmation and arbitrary partial N:M allocation are deferred.

## Verification gate

Conservation/property tests, ambiguous equal-value fixtures, complete membership controls and simultaneous cross-run allocation/reopening tests on PostgreSQL.

## Phase 7 implementation clarification

Extend Phase 6 typed runs/groups/allocations with `settlement-bank-grouped-v1`, not a parallel matcher. Require explicit complete source `payoutMemberIds` on all immutable member revisions, normalized through supplemental `synthetic-settlement-group-v1` and consistent with pinned Phase 4 financial evidence. Evaluate only whole declared sets of 2–32 settlements to one movement; no subset search, amount-only grouping or partial allocation. Declared groups reserve evidence before residual exact pairs inside this new version; pair-only v1 remains unchanged. Retain failed candidate collisions, bounded search refusal and whole-group atomic acceptance/audit/outbox. Reuse the global allocation key, current freshness/invalidation and historical immutability semantics. [Phase 7 semantics](../../phase7/README.md) defines fixed bounds, provenance and limitations; [verification](../../phase7/verification.md) records actual execution.
