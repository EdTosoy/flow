# Financial reconciliation and exception management

Production-oriented portfolio project using synthetic data. Phase 0 is the approved architectural baseline; Phase 1 implements the generic trusted financial core; Phase 2 adds an isolated deterministic synthetic financial simulator; Phase 3 adds immutable ingestion evidence and versioned normalization; Phase 4 adds processor activity interpretations, scoped payment associations and itemized settlement expectations with explicit internal controls. Phase 5 adds separate immutable bank observations, statement/balance evidence and bank-internal controls. Phase 6 implements exact 1:1 reconciliation, and Phase 7 extends it with explicit complete-declaration N:1 groups. Phase 8 adds separate operational exception management; Phase 9 adds frozen financial controls; Phase 10 adds PostgreSQL workers; Phase 11 adds independent integrity and adversarial verification. Phase 12 introduces a local read-only operator dashboard. Phase 13 adds measured read optimization and bounded local observability.

**Promise:** no unexplained financial discrepancy should fail silently.

Start with the [architecture and design status](docs/architecture/README.md). The design separates external evidence, internal business expectations, immutable accounting, and reconciliation decisions. PostgreSQL is the durability boundary; API and worker processes belong to one modular monolith.

Read the [Phase 1 implementation and reproducible commands](docs/phase1/README.md) and [verification evidence](docs/phase1/verification.md). The [implementation sequence](docs/architecture/implementation-sequence.md) defines later acceptance gates, unresolved product decisions and deferred scope. Architecture approval and financial-core verification do not constitute production approval.

```sh
pnpm install --frozen-lockfile
pnpm verify
```

Prerequisites: Node 24, pnpm 11.27.0, Docker and Chromium for the browser gate (`pnpm exec playwright install chromium`, or an installed system Chromium). Integration tests own a disposable real PostgreSQL container; no existing database is reset. No real processor/bank integration, public/customer frontend or cloud infrastructure is implemented. Internal PostgreSQL workers are implemented in Phase 10.

Read the [Phase 2 simulator model, configuration and reproduction procedure](docs/phase2/README.md) and [verification evidence](docs/phase2/verification.md). Generate safe input locally with `pnpm simulator generate --seed 828192 --payments 10000`; explicit private oracle export is a separate test-only option.

Read the [Phase 3 ingestion model and developer workflow](docs/phase3/README.md) and [verification evidence](docs/phase3/verification.md). Raw receipts, source revisions and interpretations are separate immutable evidence. Normalization never posts accounting or performs reconciliation.

Read the [Phase 4 processor model and developer pipeline](docs/phase4/README.md) and [verification/acceptance report](docs/phase4/verification.md). Processor claims never automatically create internal authorization or ledger entries, and settlement expectations do not prove bank receipt.

Read the [Phase 5 bank model and public pipeline](docs/phase5/README.md) and [verification/acceptance report](docs/phase5/verification.md). Bank observations never establish processor origin or ledger truth. The developer CLI prints separate processor and bank summaries without matching.

## Phase 6

[Exact synthetic 1:1 reconciliation](docs/phase6/README.md) and [verification report](docs/phase6/verification.md). Run `pnpm reconciliation` with public evidence and an explicitly provisioned source-account mapping. This original rule stays pair-only; Phase 7 and Phase 8 capabilities are separately documented below.

Phase 7 adds explicit complete-declaration N:1 settlement-bank reconciliation on the existing frozen-run/allocation model. See [semantics](docs/phase7/README.md) and [verification](docs/phase7/verification.md).

## Phase 8: operational exceptions

A separate exception domain supports deterministic case generation, review, evidence/notes, auditable assignment/classification, structured resolution and explicit reopening/supersession. Accepted risk closes operations while money stays unreconciled. Verified closure cites existing fresh later-run proof; it creates no allocation. [Model and CLI](docs/phase8/README.md), [verification](docs/phase8/verification.md), [ADR-014](docs/architecture/adr/014-operational-exceptions.md).

Use `pnpm exceptions pipeline` with the existing reconciliation arguments and separate `DATABASE_EXCEPTION_URL`, then `pnpm exceptions apply <command-json>` for review/resolution. Normal output contains runtime evidence only. Manual matching, new downstream worker policies, web financial actions, real integrations, cloud and AI remain deferred.

## Phase 9 financial controls

Versioned frozen control runs coordinate source/processing completeness, processor and bank totals, reconciliation coverage, allocation and ledger integrity, exposure and aging. UNKNOWN evidence stays explicit; operationally accepted risk remains unreconciled. See [implementation](docs/phase9/README.md) and [verification](docs/phase9/verification.md). `pnpm controls run <command-json>` and `pnpm controls pipeline <reconciliation arguments>` use separate synthetic runtime credentials. Phase 10 adds separate durable internal worker processing without changing these frozen control evaluations.

Phase 10 is complete and verified for internal PostgreSQL async workers: [protocol and developer commands](docs/phase10/README.md), [verification](docs/phase10/verification.md).

Phase 11 is complete and verified for independent read-only system integrity checks and synthetic/local adversarial resilience: [scope and commands](docs/phase11/README.md), [executed evidence](docs/phase11/verification.md). Use `pnpm integrity <book-id> [explicit-run-id ...]` with a narrow integrity-reader credential. Structural integrity and financial PASS/FAIL/UNKNOWN remain separate. Phase 12 adds the read-only application described below; financial web actions remain deferred.

## Local operations dashboard (Phase 12)

A read-only Next.js operator application investigates reconciliation, exceptions, controls, durable work and current integrity. Exact currency values and PASS/FAIL/UNKNOWN remain explicit; case closure does not prove reconciliation. Production identity/deployment and all web mutations remain deferred.

Follow [local provisioning/demo commands](docs/phase12/README.md), set only the narrow `DATABASE_OPERATIONS_URL`, build with `pnpm build`, then run `pnpm ops:start` on http://127.0.0.1:3000. Use `pnpm ops:dev` for local development. [Verification and limitations](docs/phase12/verification.md).

![Local synthetic financial operations overview](docs/phase12/screenshots/overview.png)

## Read performance and observability (Phase 13)

[Measured proof batching and local metrics/logging/health](docs/phase13/README.md) preserve existing financial semantics and permissions. `/health/live`, `/health/ready` and the existing financial assurance view have separate meanings. `/metrics` exposes process observations and dated last-observed authoritative scopes without recomputing financial truth. [Benchmarks, query plans, verification and limitations](docs/phase13/verification.md). Preferred local latency targets are not production SLAs.

## Stripe sandbox processor integration (Phase 14)

Phase 14 adds the first real external financial-system boundary: authenticated Stripe sandbox evidence enters Flow through a dedicated ingress service, immutable ingestion, transactional work intent and the existing PostgreSQL worker infrastructure. Stripe-specific mapping remains isolated from the provider-neutral financial core.

Webhook signatures are verified against the exact raw request bytes using the official Stripe SDK before evidence is trusted. Duplicate delivery, conflicting evidence, out-of-order events, API pagination, bounded retries and overlapping Events API backfill are handled explicitly. Successful webhook acknowledgement occurs only after durable evidence acceptance.

Supported Phase 14 evidence includes captured charges, authoritative Balance Transactions and fees, refunds, disputes and conservative payout/settlement interpretation within the documented scope. Unsupported reversal/recovery economics remain explicit rather than being force-mapped. Source completeness remains `UNKNOWN` when independent evidence is insufficient.

Real external verification passed using a Stripe sandbox `charge.succeeded` event. The signed webhook was durably accepted, processed by the worker, enriched from Stripe sandbox evidence and converted into processor-domain evidence. Overlapping backfill deduplicated to the same logical event/economic effect. Full regression verification remained green.

The bank side remains explicitly synthetic, so this is **real Stripe sandbox processor evidence + synthetic bank evidence**, not proof of a real processor-to-bank production reconciliation environment.

See [Phase 14 integration and setup](docs/phase14/README.md), [external verification evidence](docs/phase14/verification.md), and [ADR-017](docs/architecture/adr/017-external-processor-ingress.md).

Live Stripe processing, payment initiation, checkout/billing/subscriptions, Stripe Connect, real bank integration, cloud deployment, production identity, AI-assisted investigation, new queue infrastructure and web financial mutations remain deferred.

## Ephemeral AWS demo (Phase 15)

Phase 15 is implemented and verified with a persistent Terraform bootstrap and a disposable AWS demo runtime. Actual ECS Fargate, HTTPS ALB and private Single-AZ RDS deployment, protected dashboard, hosted Stripe sandbox charge/fee ingestion and overlapping backfill passed; the runtime was then destroyed and removal verified. No NAT gateway is used. Stripe remains sandbox-only and bank evidence synthetic. Cloudflare stays the parent DNS provider with one-time delegation of `flow.edtosoy.com` to a persistent Route 53 child zone. This is a portfolio demo, not a high-availability production service.

Follow [the staged bootstrap and mandatory DNS checkpoint](docs/phase15/README.md). [Verification](docs/phase15/verification.md) distinguishes local checks, AWS bootstrap, hosted external proof and runtime destruction. Deployment is not yet fully verified and is not production readiness. No Phase 16 work is authorized.
