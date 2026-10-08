# ADR-007 — PostgreSQL-backed workers for V1

Status: accepted for the Phase 10 internal normalization worker boundary; broader handler/publication/requeue policies remain planned. Date: 2026-10-07.

## Context

There is no measured need for a broker/cache and PostgreSQL already owns durable work intent. Concurrent workers still require safe claims, bounded transactions and explicit recovery.

## Decision

Use work rows claimed with FOR UPDATE SKIP LOCKED, finite DB-clock leases and monotonic claim generations. Compute outside short transactions; final local effects lock work and validate ownership through commit. Persist attempts, receipts, retries, blocked cases and requeues. Sweep expired/stalled work and monitor sweep freshness. See [protocol](../transactions-and-outbox.md).

## Consequences and alternatives

Avoids Redis/BullMQ, Kafka/Redpanda and their extra operating boundaries. DB write/backlog/locking pressure requires monitoring and bounded batches. Queue-skipped rows must not be omitted from reconciliation populations or totals. A broker may later distribute work, but cannot replace PostgreSQL intent or effect idempotency.

## Revisit and verification

Revisit after load/soak shows a documented throughput/latency/availability need. Prove stale workers cannot commit, leases recover, blocked work remains visible and backlog drains under declared resources.

## Phase 10 implementation clarification

Phase 10 uses bounded READ COMMITTED SKIP LOCKED claims, DB-clock leases, increasing attempts and unique tokens. Each short domain write locks and fences work through COMMIT; separate acknowledgement closes only the current lease. Expired claims are recovered by polling, with bounded budgets and append-only EXPIRED history. Terminal work remains visible; manual requeue and generic operational exception cases are deferred. No broker or heartbeat is introduced for the bounded installed normalization handler. [Protocol](../../phase10/README.md); [executed evidence](../../phase10/verification.md).
