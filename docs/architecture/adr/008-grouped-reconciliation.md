# ADR-008 — Grouped, scoped reconciliation proof

Status: proposed. Date: 2026-10-07.

## Context

Settlements net multiple captures/refunds/fees, while refunds may split. A pair-only schema blocks these relationships; an arbitrary N:M graph can conceal ambiguity and double consumption.

## Decision

Use immutable run populations, versioned rules, match groups/members with typed roles and exact signed equations. Stable economic items/facets have one active allocation per relationship scope across runs. Implement conservative 1:1 then N:1 itemized settlement proof; preserve evolution to explicit 1:N with whole-item components. Separate manual accepted-risk resolution from deterministic reconciliation. See [semantics](../reconciliation.md).

## Consequences and alternatives

One fact can prove different scopes without reuse within a scope. Current allocation index and proof revocation require transactional coordination and lineage. A single `matched_to_id` or uniqueness only within one run is insufficient. Generic subset search, probabilistic auto-confirmation and arbitrary partial N:M allocation are deferred.

## Verification gate

Conservation/property tests, ambiguous equal-value fixtures, complete membership controls and simultaneous cross-run allocation/reopening tests on PostgreSQL.
