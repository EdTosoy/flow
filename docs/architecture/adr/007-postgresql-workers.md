# ADR-007 — PostgreSQL-backed workers for V1

Status: proposed. Date: 2026-10-07.

## Context

There is no measured need for a broker/cache and PostgreSQL already owns durable work intent. Concurrent workers still require safe claims, bounded transactions and explicit recovery.

## Decision

Use work rows claimed with FOR UPDATE SKIP LOCKED, finite DB-clock leases and monotonic claim generations. Compute outside short transactions; final local effects lock work and validate ownership through commit. Persist attempts, receipts, retries, blocked cases and requeues. Sweep expired/stalled work and monitor sweep freshness. See [protocol](../transactions-and-outbox.md).

## Consequences and alternatives

Avoids Redis/BullMQ, Kafka/Redpanda and their extra operating boundaries. DB write/backlog/locking pressure requires monitoring and bounded batches. Queue-skipped rows must not be omitted from reconciliation populations or totals. A broker may later distribute work, but cannot replace PostgreSQL intent or effect idempotency.

## Revisit and verification

Revisit after load/soak shows a documented throughput/latency/availability need. Prove stale workers cannot commit, leases recover, blocked work remains visible and backlog drains under declared resources.
