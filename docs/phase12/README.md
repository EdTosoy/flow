# Phase 12 — Local financial operations dashboard

The first operator web surface investigates existing PostgreSQL truth. It creates no financial decisions. Phase 13, public/customer UI, real integrations, cloud, AI, new accounting, N:M and new brokers remain deferred.

## Architecture and permissions

```text
Existing financial domains → PostgreSQL authoritative state
                                       ↓
                        operations.read_v1 / narrow capability
                                       ↓
                        @flow/operations-read-postgres
                                       ↓
                        Next.js server-only boundary
                                       ↓
                        App Router operator presentation
```

[ADR-016](../architecture/adr/016-operations-read-application.md) clarifies ADR-001: this read-only V1 uses Next.js directly through approved reads; there is no separate NestJS service. Apps/ops uses pinned Next 16.4.0 and React/React DOM 19.3.0, App Router and Server Components. Only the fallback error retry is a Client Component. Native HTML/CSS, system fonts and focused table/status/number/evidence components need no UI/chart framework or external assets.

Migration 011 adds only the operations schema/function and flow_operations_reader NOLOGIN capability. Provision a separate non-owner login with **only** that capability. It gets schema usage and EXECUTE on one versioned allowlist, no raw tables, writer membership or command functions. The adapter checks role flags/memberships and refuses owner/writer credentials. Never use DATABASE_ADMIN_URL for the application. All SQL values are parameterized; server validates identifiers, enum filters, limit and cursor shape. Runtime role is a database boundary, not production identity authorization.

Every read is READ ONLY REPEATABLE READ with fixed 30-second statement/idle bounds. UI components issue no SQL. PostgreSQL-owned summaries/controls/sweep supply financial meaning; the read function projects them without rematching, exposure arithmetic or state transitions. Books and all detail lookups are scoped; a foreign-book case/run/work/control evaluation is unavailable. No raw receipts, command bodies, outbox payloads, credentials, lease tokens or arbitrary error messages are returned. Requested append-only notes are rendered as escaped text.

## Pages and financial semantics

Navigation: Overview, Reconciliation, Exceptions, Controls, Workers, Integrity. Reconciliation, exceptions, controls and work have detail drill-downs.

- **Overview:** current structural/financial integrity, subsystem assurance, operational counts and explicitly selected frozen canonical exposure. Latest completed evaluation time is informational; it never chooses financial scope.
- **Reconciliation:** frozen side-specific population/outcome counts, exact/grouped match counts, currency, current proof and timestamps. Detail retains named rule, window/hash, immutable processor/bank evidence IDs, revision/reference/history, established exposure/residual and whole-group contributions. Frozen bank minus the already stored processor aggregate is projected with exact PostgreSQL NUMERIC subtraction for display only; it creates no matching/control decision. Historical MATCHED is not automatically current reconciliation.
- **Exceptions:** status/classification/currency/exact-ID filters, assignment, item exposure, age/activity and evidence links. Detail separates operational state from current financial proof, exposes append-only notes/resolutions and linked controls. Case values are explicitly non-additive. Accepted risk never creates allocation or disappears from unreconciled exposure.
- **Controls:** explicitly selected evaluation, lifecycle/version/frozen time/current reason, PASS/FAIL/UNKNOWN/category/currency filters, expected/observed/discrepancy/unit and detail evidence/case IDs. Original results remain immutable even when stale.
- **Workers:** pending/processing/retryable/terminal counts, oldest pending timestamp, safe type/handler/attempt/retry/expiry/failure metadata and paged attempt history. No payload access or requeue. Operational success is not financial assurance.
- **Integrity:** current engineering sweep, structural and financial status, supported subsystem checks and safe violation evidence. At most fifty violations render, with the complete count and CLI referral. Query failure is incomplete/unavailable; no fake PASS. This is not cryptographic attestation.

PASS uses an explicit check symbol/text, FAIL a distinct exclamation/text, UNKNOWN a question/text with amber styling. Source completeness without independent period closure remains UNKNOWN even if all received evidence processed/matched. Empty books remain UNKNOWN. Query failure renders unavailable rather than zero counts. Historical exposure is visibly labelled frozen and stale/current; select an evaluation to establish scope. Missing exposure stays UNKNOWN. Per-mapping/currency canonical totals and their accepted-risk subset come directly from Phase 9; processor/bank claims are not added when overlap is unproven. Ambiguous exposure remains unknown unless the owning domain proves an amount.

All monetary fields remain exact integer strings. Display reads scale from @flow/money currency metadata and formats strings without Number conversion. Aggregate strings can exceed BIGINT. Counts and rates, if used, are presentation only; the exact count percentage helper uses bigint, truncates to one decimal and treats a zero denominator as not evaluated. No FX/cross-currency total exists. UTC exact timestamps remain visible; ages supplement them, use the query timestamp and confer no SLA policy.

## Bounded navigation, freshness and errors

Default fifty/max one hundred rows per read. Lists order oldest `(created_at,id)` (run started_at) first and use strict tuple keysets, with full PostgreSQL timestamp precision retained in opaque base64url cursors. Control keys, frozen member IDs and event versions use their stable respective keysets. No OFFSET or raw-payload search. Case-linked controls display at most 100 with the full reference count; frozen revision/declaration histories display at most 50 each with full counts. Match groups retain their bounded whole membership; duplicate full snapshots are excluded from proof metadata. Search is UUID equality. Filters change selection, never financial meaning.

Each approved read is one snapshot. The main financial presentation comes from one coherent read; auxiliary evaluation/navigation lists use separate bounded reads and may be newer. Navigation/refresh starts new queries. Pages do not promise one snapshot across a long multi-page mutable queue; refresh from the beginning for new arrivals. Financial run membership/history remains frozen by its domain. Explicit evaluation selection survives navigation. All routes force dynamic rendering; no static/cache snapshot masquerades as live state. Manual refresh uses a fresh server navigation. No polling/WebSocket/SSE/streaming infrastructure.

Malformed request, missing/foreign scope, no configured database, unavailable query and no data have distinct visible states. Required verification failure blocks assurance rather than presenting a partially healthy summary. Structured server logs expose operation/category only, never SQL errors/payloads/stacks/URLs. Browser bundles are scanned for database strings/implementations. App/port/boundary gates reject privileged writers, pg outside server/, oracle/test/demo imports and client transitive server dependencies.

## Authentication and security scope

Explicitly localhost/internal. **No production authentication or operator identity platform is claimed.** Dev/start bind 127.0.0.1; do not publicly proxy this app. Book selection is validated scope, not an authorization claim. Future production access needs real identity, book permissions, audit for mutations, TLS and deployment review. Headers deny framing, sniffing, indexing and external connections; the local CSP permits inline Next hydration/styles and is not a production nonce policy. No NEXT_PUBLIC database variables, remote fonts/scripts, UI financial actions or Server Actions.

Semantic headings/tables, labelled GET filters, keyboard/focus states, skip link and textual status semantics support keyboard operation. Desktop tables remain dense; narrow screens adapt navigation/cards and scroll within table containers. No chart is added: exact tables and status/count panels communicate the current dataset more accurately.

## Reproducible local workflow

Use a dedicated local disposable synthetic database. The following example has localhost-only trust authentication and no real financial data. It is not production provisioning. Do not reuse an existing database or publish its port beyond localhost.

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
# Optional on NixOS: export PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH="$(command -v chromium)"
docker run --detach --rm --name flow-ops-local --publish 127.0.0.1:5432:5432 \
  --env POSTGRES_USER=flow_local_admin --env POSTGRES_DB=flow_local \
  --env POSTGRES_HOST_AUTH_METHOD=trust \
  postgres:18@sha256:fc973eb97c9fd04bfa1840e0f510719a584ccb3be8debfe6a4144637a9dfe8cf
export DATABASE_ADMIN_URL=postgresql://flow_local_admin@127.0.0.1:5432/flow_local
pnpm db:migrate
# Provision scoped LOCAL logins once through the administrator:
docker exec -i flow-ops-local psql -U flow_local_admin -d flow_local <<'SQL'
CREATE ROLE flow_local_ingestion LOGIN IN ROLE flow_ingestion_writer;
CREATE ROLE flow_local_processor LOGIN IN ROLE flow_processor_writer;
CREATE ROLE flow_local_bank LOGIN IN ROLE flow_bank_writer;
CREATE ROLE flow_local_reconciliation LOGIN IN ROLE flow_reconciliation_writer;
CREATE ROLE flow_local_exception LOGIN IN ROLE flow_exception_writer;
CREATE ROLE flow_local_control LOGIN IN ROLE flow_control_writer;
CREATE ROLE flow_local_worker LOGIN IN ROLE flow_worker;
CREATE ROLE flow_local_integrity LOGIN IN ROLE flow_integrity_reader;
CREATE ROLE flow_local_operations LOGIN IN ROLE flow_operations_reader;
SQL
export DATABASE_INGESTION_URL=postgresql://flow_local_ingestion@127.0.0.1:5432/flow_local
export DATABASE_PROCESSOR_URL=postgresql://flow_local_processor@127.0.0.1:5432/flow_local
export DATABASE_BANK_URL=postgresql://flow_local_bank@127.0.0.1:5432/flow_local
export DATABASE_RECONCILIATION_URL=postgresql://flow_local_reconciliation@127.0.0.1:5432/flow_local
export DATABASE_EXCEPTION_URL=postgresql://flow_local_exception@127.0.0.1:5432/flow_local
export DATABASE_CONTROL_URL=postgresql://flow_local_control@127.0.0.1:5432/flow_local
export DATABASE_WORKER_URL=postgresql://flow_local_worker@127.0.0.1:5432/flow_local
export DATABASE_INTEGRITY_URL=postgresql://flow_local_integrity@127.0.0.1:5432/flow_local
export DATABASE_OPERATIONS_URL=postgresql://flow_local_operations@127.0.0.1:5432/flow_local
# Choose NEW output paths; generator preserves existing artifacts.
printf '%s\n' '{"seed":71201,"paymentCount":12,"batchSizeRange":[1,1],"anomalies":{"missing-bank-transaction":{"count":2},"duplicate-bank-observation":{"count":2},"incorrect-amount":{"count":2}}}' > /tmp/flow-ops-demo-config.json
pnpm simulator generate --seed 71200 --payments 40 --out /tmp/flow-ops-healthy
pnpm simulator generate --config /tmp/flow-ops-demo-config.json --out /tmp/flow-ops-unhealthy
pnpm simulator generate --seed 71202 --payments 12 --group-size 2 --out /tmp/flow-ops-grouped
pnpm ops:demo --delivery-replays 12 /tmp/flow-ops-healthy/input.json /tmp/flow-ops-unhealthy/input.json /tmp/flow-ops-grouped/input.json
# Command emits bookId/evaluationId/run IDs. Substitute these identities below:
pnpm integrity <book-id> <selected-run-id> [...]
pnpm worker status RETRYABLE
pnpm worker status FAILED_TERMINAL
pnpm build
# Start a NEW shell containing only DATABASE_OPERATIONS_URL; never owner credentials:
pnpm ops:start
# http://127.0.0.1:3000/?book=<book-id>&evaluation=<evaluation-id>
```

The offline provisioner reads public input.json only, creates deterministic synthetic book/source configuration, invokes existing ingestion/worker/interpretation/reconciliation/exception/control ports, and sweeps integrity. It adds one audited accepted-risk example with note and two persisted synthetic operational failure demonstrations (`DEMO_TRANSIENT`, `DEMO_POISON`). Those are labelled failure injection, not naturally observed processor/network faults. They leave committed receipt/intent and explainable retry/terminal state. No UI mutation or arbitrary test hook is involved. Optional `--delivery-replays 0..20` ingests unchanged public processor deliveries under distinct stable receipt/batch identities, demonstrating at-least-once delivery without new semantic facts. The book identity binds the full public input content/label/replay configuration; repeated commands reuse domain identities, and completed/failed evidence is never reset. Repeated provisioning can process the prior retry; terminal work remains terminal, and an old evaluation may become stale. Use a new public identity for a fresh demo rather than rewriting history.

Healthy matches deliberately coexist with UNKNOWN source closure; this simulator does not manufacture unavailable independent period evidence. Failed controls/unmatched/ambiguity/risk and operational failures demonstrate non-green state. The browser fixture also uses an explicitly synthetic USD variant to verify separation; no private labels are handed to runtime.

```sh
pnpm test:integration tests/operations.integration.test.ts tests/operations-browser.integration.test.ts
pnpm test:boundaries
pnpm verify
# Optional developer loop:
pnpm ops:dev
# Stop only your dedicated local example when done:
docker stop flow-ops-local
```

The integration runner owns its randomly named disposable container, verifies populated upgrades and roles, runs the production app/browser, and cleans processes/pools/proxies/directories in finally. Chromium is test-only; the harness can use an explicitly configured executable or installed system Chromium, otherwise Playwright-managed Chromium. A browser executable is required for the full gate; it is never silently skipped.

## Performance and limitations

[Verification](verification.md) records actual dataset size, query plans/latencies, build/browser results and full prior regressions. Direct indexed reads and existing domain functions are used; no denormalized financial truth or new index has been justified. Current integrity and freshness evaluation can be expensive; requests have explicit limits and query deadlines. Initial larger unique financial populations exceeded unchanged reconciliation/control transaction deadlines; the meaningful high-receipt demo uses smaller settlement populations. This is not a scale guarantee or internet/production latency claim.

Existing control/sweep population limits remain enforced; oversize/unavailable verification refuses assurance. No production login, tenant authorization, pagination-wide MVCC snapshot, scheduling/SLA, mutations, manual requeue, alerts, cloud deployment, real integration, AI or Phase 13 is implemented.
