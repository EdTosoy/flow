# ADR-017 — Authenticated external processor evidence through dedicated ingress

Status: implemented for Phase 14 sandbox/local scope; real signed sandbox capture/fee verification passed; see the Phase 14 evidence record. Date: 2026-10-09.

## Context

Phases 3–13 already distinguish raw source evidence, versioned observations, processor claims, reconciliation proof and ledger truth. The operations application has a read-only capability. An external webhook must authenticate its exact representation and survive retries, lost responses and asynchronous failures without granting the dashboard financial writes or treating an external claim as internal accounting.

## Decision

A dedicated Node ingress process in `apps/integrations` verifies Stripe snapshot webhooks with the official SDK. It requires sandbox configuration, rejects live events and Connect/context envelopes, bounds request bytes and signature age, and calls a source-bound PostgreSQL capability. Successful HTTP acknowledgement follows a synchronous transaction committing immutable Phase 3 raw evidence and the existing outbox work intent. No API enrichment, reconciliation or financial interpretation runs in this HTTP transaction.

The existing PostgreSQL worker owns enrichment. A provider-specific adapter fetches pinned-version sandbox API evidence through read-only calls, retains immutable attempt-scoped snapshots under lease fencing, and produces provider-neutral movement/settlement contracts. Atomic ingestion, normalization, processor derivation and a completion receipt precede fenced work completion. Retries use the original event and economic identities. Stripe event identity deduplicates acquisition; balance transaction/component identity deduplicates financial interpretation. Neither correlation identity nor arrival time determines financial truth.

Source-bound runtime roles cannot call generic ingestion, configure another source or write financial tables directly. The owner configures a single account and immutable provider-neutral interpretation policy offline. Existing synthetic policies are the default for existing sources. The operations application receives only bounded provenance metadata through its established read capability.

## Consequences

The only new external dependency is the official Stripe SDK. Stripe types stay in the adapter. There is one database, one worker engine and no new broker. Explicit overlapping Events API windows provide bounded recovery; they do not prove complete history. Webhooks also do not prove completeness. Pending or unsupported accepted external evidence invalidates current assurance for that source while frozen history remains intact.

This V1 supports positive capture, distinct successful refunds, dispute withdrawals and explicitly itemized completed automatic payouts in the existing currency catalog. Reinstatements, failed-refund/payout reversals, FX and other unsupported balance activity cannot be represented safely by the present domain and therefore remain visible failures/UNKNOWN. A terminal earlier event is not automatically cleared by a later event; operator recovery/supersession requires future explicitly reviewed work. No live processing, financial initiation, real bank, Connect or production deployment is authorized here.

Exact webhook bytes are external wire evidence. API snapshots are decoded official-SDK responses, and canonical financial records are labeled adapter projections with links to their external evidence. Root-account webhook events do not independently identify their account; the configured signing-secret/account association is an operator trust boundary, supplemented by API account verification. This phase provides no production identity or public hosting.

## Verification

See [Phase 14 implementation](../../phase14/README.md) and [verification record](../../phase14/verification.md). Real PostgreSQL verifies immutable acceptance, synchronized contention, unknown commits, worker recovery, semantic duplicates, source isolation, conservative freshness, existing reconciliation consumption and populated migration retention. Locally signed contracts exercise the official signature mechanism independently of external credentials. Actual sandbox verification is a separate explicit gate and cannot be substituted by those fixtures.
