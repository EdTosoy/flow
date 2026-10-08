# ADR-016 — A server-only operations application over approved reads

Status: accepted for Phase 12 local/internal investigation. Date: 2026-10-08.

## Context

PostgreSQL already owns financial truth and versioned control, reconciliation, exception, worker and integrity reads. An operator interface needs bounded investigation surfaces, not another financial implementation or a separately deployed API. ADR-001 planned Next.js and a future NestJS composition layer; no existing identity platform or public deployment exists.

## Decision

Use one Next.js App Router application at apps/ops. Server Components compose a dedicated operations-read-postgres package through an explicitly server-only module. A non-owner login with only flow_operations_reader executes operations.read_v1. This fixed-search-path SECURITY DEFINER function exposes allowlisted book-scoped bounded projections; no base-table access or domain/worker command privilege is granted.

Each approved read observes READ ONLY REPEATABLE READ. Main financial data is coherent within that read; auxiliary navigation/evaluation choices may come from a newer independent bounded read. Established domain functions own calculations: reconciliation.summary/current_valid, exceptions.case_view/cause, controls.summary and integrity.sweep. Select a control evaluation explicitly to pin one reconciliation run per mapping; never choose a financial revision/run by arrival order. Frozen exposure and controls retain their own timestamps/current status. Current integrity is a separate read-time engineering verification surface, not historical attestation. Exact minor-unit strings and canonical currency metadata cross the server presentation boundary; NULL remains UNKNOWN.

Navigation and manual refresh use dynamic server reads. Operational queues use bounded keyset pagination. No application SQL in presentation components, client database imports, Server Actions, web financial mutations, manual retries, oracle/test imports or public endpoints intended for external use.

## Consequences

A separate NestJS API adds no needed boundary here and is deferred. PostgreSQL capabilities and server-only/module gates enforce the present read boundary; they are not operator identity authorization. Bind dev/start to localhost. Production authentication, book-level operator permissions, TLS, CSP nonces and deployment require a separately authorized phase. Owners/provisioners remain trusted; current sweeps do not prove historical tamper resistance. Native HTML/CSS and focused components avoid a UI framework dependency. No new authoritative table, materialized financial projection or index is added without measured need.

## Verification

Production build, real restricted-role PostgreSQL reads/denials, populated migration retention, exact Money/UNKNOWN presentation properties, stable pagination/filter/freshness/currency/exposure tests, production Chromium navigation/drill-down/empty/error/keyboard/narrow-screen smoke, built client artifact inspection, transitive import/oracle gates and unchanged Phase 1–11 full verification. See [Phase 12](../../phase12/README.md) and [execution record](../../phase12/verification.md).

Framework mechanisms follow [Server Components and server-only](https://nextjs.org/docs/app/getting-started/server-and-client-components), [server external packages](https://nextjs.org/docs/app/api-reference/config/next-config-js/serverExternalPackages) and [dynamic route rendering](https://nextjs.org/docs/app/api-reference/file-conventions/route-segment-config). Package registry stable versions were inspected before pinning; installed code, production build and browser tests validate the chosen versions.
