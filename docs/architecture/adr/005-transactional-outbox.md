# ADR-005 — Transactional outbox for asynchronous intent

Status: proposed. Date: 2026-10-07.

## Context

Committing financial state and separately publishing from process memory loses work if the process dies between those steps. Queue delivery cannot be a prerequisite for financial durability.

## Decision

Commit immutable outbox intent with authoritative state and audit. Required per-handler local work is registered atomically or through a durable idempotent dispatcher. V1 workers poll PostgreSQL; missed wakeups do not lose work. Local effect/receipt/work-done and next intent commit together. Remote publication may duplicate and requires a durable receiver idempotency contract. See [outbox protocol](../transactions-and-outbox.md).

## Consequences and alternatives

Durable intent makes crash windows recoverable but requires backlog/retry/retention monitoring. Payload versions and handler registration/backfills must be explicit. Direct publish-after-write or an in-memory job scheduler cannot meet the guarantee. The outbox does not create exactly-once delivery or a distributed transaction with remote services.

## Verification gate

Inject crashes before/after authoritative commit, before publication and after send/ack loss; verify local receipt atomicity, fan-out completeness and retained blocked work.
