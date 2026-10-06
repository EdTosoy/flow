# ADR-006 — At-least-once delivery, idempotent financial effects

Status: proposed. Date: 2026-10-07.

## Context

Duplicates arise from remote retries, worker restarts, unknown commit outcome and multiple channels for one economic fact. A webhook event ID alone is not a financial action identity.

## Decision

Assume at-least-once processing. Distinguish receipt/source-revision/handler-command/effect identities. Enforce scoped unique business-effect keys and handler receipts in PostgreSQL, with canonical request-hash comparison. Retrying same key/payload returns existing outcome; same key/different payload is an explicit conflict. Reprocessing a new parser/rule does not create another original financial effect. See INV-003/008/014.

## Consequences and alternatives

Correct canonicalization is an adapter/domain responsibility and must be documented. Hashing amounts alone would merge legitimate same-value transactions; random per-retry keys fail deduplication. Application “check then insert” races; unique constraints arbitrate. Exactly-once message delivery is neither claimed nor required for one committed effect per semantic key.

## Verification gate

100 concurrent mixed-channel deliveries, conflicting payload, unknown commit acknowledgement, and order/permutation replay must converge or surface conflict, never duplicate value.
