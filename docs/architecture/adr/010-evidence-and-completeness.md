# ADR-010 — Versioned evidence and independent completeness

Status: proposed. Date: 2026-10-07.

## Context

Matching every received row is compatible with missing rows. Reinterpreting or correcting a source fact can otherwise overwrite evidence or duplicate accounting. A journal derived from a processor record cannot independently prove internal authorization.

## Decision

Separate immutable raw receipts, scoped source identities/revisions, normalized interpretations, independent internal expectations, accounting, and proof. Freeze run member identities/revisions/rules. Track source coverage, processing dispositions, ledger integrity, run partition and independent financial totals separately. Unknown controls stay unverified; upstream/rule corrections create new versions and invalidate current assurance without rewriting history. See [model](../data-model.md) and [controls](../reconciliation.md).

## Consequences and alternatives

More explicit identities and lineage are justified by reproducibility and correction safety. Storage/retention and dependency invalidation need design/testing. Merging processor and ledger into one entity, treating a received count as an external expected total, or showing match rate as total assurance are rejected. Versioned evidence is not blanket event sourcing.

## Verification gate

Missing/truncated/duplicate-masked imports, parser failures, offsetting aggregate errors, source/rule corrections, historical replay and stale assurance simulations must be detected without oracle access.
