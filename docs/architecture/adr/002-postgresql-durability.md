# ADR-002 — PostgreSQL is the financial system of record

Status: proposed. Date: 2026-10-07.

## Context

Immutable accounting, uniqueness, relational provenance and atomic decisions need durable constraints and transactions. Financial truth cannot depend on successful message delivery or a cache.

## Decision

Store authoritative business state, ledger, raw/versioned source evidence, proof, audit and required work intent in PostgreSQL. Derive balances/projections; use primary authoritative reads for decisions. Drizzle handles suitable adapters while reviewed SQL protects financial invariants. Runtime privilege restrictions and narrowly scoped routines backstop application checks. See [transactions](../transactions-and-outbox.md).

## Consequences and alternatives

One durable boundary simplifies failure recovery. Database/storage settings, backup/restore, role and migration discipline are critical trust assumptions. Retaining raw payloads initially grows storage; archive/object storage may be added with verified availability/checksums and evidence retention controls. Broker offsets, projections and logs are insufficient authorities. Broad event sourcing is unnecessary; immutable facts plus current lifecycle state and audit meet the requirements.

## Revisit and verification

Revisit storage placement with measured payload size/retention requirements, preserving authoritative references. Verify constraints/roles on real PostgreSQL, durable commit behavior and restore/replay before production.
