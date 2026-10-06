# ADR-004 — Immutable, atomic double-entry accounting

Status: accepted baseline, clarified for Phase 1. Date: 2026-10-07.

## Context

A balance check cannot detect semantic mistakes, but absence of a balance/immutability boundary permits manufactured value and erased history. Application-only validation is insufficient.

## Decision

Post complete single-currency journals atomically through a controlled PostgreSQL routine, with positive debit/credit entries, currency/book FKs, parent serialization and transaction-end balance/completeness checks. No committed draft journal in V1. Posted rows cannot be edited/deleted or receive new entries. Correct using a full linked reversal and replacement, with reason/evidence and appropriate approval. Derive balances from entries. See [write protocol](../transactions-and-outbox.md).

## Consequences and alternatives

Immutable history supports replay and accountable corrections. Routines/triggers add small, justified DB logic which requires direct-SQL and concurrency tests. Mutable balances or editing a posted journal are rejected because they obscure history; event sourcing is not required. Accounting template correctness still needs domain approval and independent controls.

## Revisit and verification

Multi-currency journals, partial reversals and drafts need a new design/ADR, not relaxation of balancing. Verify zero-entry/unbalanced/late-entry/cross-scope rejection, atomic rollback and original-plus-reversal account deltas on real PostgreSQL.

## Phase 1 concrete scope

One full reversal per original journal is enforced by uniqueness and exact inverse-entry validation. Partial reversals and reversal-of-reversal are deferred. Accounts are immutable and open; closure and its approved closed-account reversal path are deferred together. A replacement is a distinct generic posting, with caller-owned transaction composition available; a dedicated correction/approval workflow is deferred. This removes unnecessary lifecycle/workflow surface for the synthetic financial-core milestone without weakening immutable history. [Actual SQL and verification](../../phase1/README.md).
