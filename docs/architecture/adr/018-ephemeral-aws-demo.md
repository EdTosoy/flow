# ADR-018 — Persistent bootstrap and disposable AWS demo runtime

Status: accepted and implemented; actual hosted deployment and runtime destruction verified. Date: 2026-10-09.

## Context

The user authorized an AWS portfolio demonstration in account `163596511125`, profile `iamadmin-general`, region `us-east-1`. Runtime should exist for hours rather than continuously. Phase 14's real Stripe sandbox evidence must retain its immutable ingestion, source-bound capabilities, asynchronous worker and provider-neutral financial boundaries.

## Decision

Separate Terraform roots and state keys for persistent `infra/bootstrap` prerequisites and the eventual disposable `infra/demo` runtime. Bootstrap owns an encrypted, private, versioned S3 state bucket, immutable-tag ECR repositories for operations, Stripe adapter and one-shot administration, a $10 account-wide monthly alert budget, and a public child zone for `flow.edtosoy.com`.

Initial bucket creation uses explicitly local state. Migrate that existing state to S3 before creating the child zone, using native `use_lockfile=true` locking. Never claim the backend creates its own bucket. Local state/plan/configuration files are ignored and treated as sensitive. Preserve an ignored private seed-state backup during migration. Existing remote state must be reconnected, not overwritten.

The Cloudflare parent remains authoritative for `edtosoy.com`. Child zone creation is a mandatory stop: the operator adds four NS records named `flow` using the actual assigned nameservers. After explicit confirmation, verify the public delegation before any certificate validation or hosted operation. The persistent child zone survives demo destruction; the future ALB alias belongs to runtime state. No Cloudflare provider or credentials are needed.

The implemented runtime is ECS Fargate plus one public ALB and a private encrypted Single-AZ disposable RDS PostgreSQL database. No NAT gateway: tasks may have public IPs for outbound HTTPS, while security groups permit HTTP ingress only from the ALB and database ingress only from explicit task/admin boundaries. Public IP assignment is not authorization for public ingress. PostgreSQL 18.6 migration/role compatibility was verified on actual private RDS.

SSM SecureString is the runtime secret strategy, with ephemeral sensitive Terraform inputs and write-only provider attributes. Separate execution and task roles and separate narrow database logins preserve existing trust boundaries. The dashboard uses a generated shared demo Basic credential over HTTPS, server-side timing-safe verification and fail-closed configuration; financial routes and metrics are protected. This is deliberately limited demo access, not a production identity platform. Migration/provisioning stays a one-shot privileged workload. A separate narrow verification task never receives owner credentials. Financial health remains separate from technical health.

## Consequences and verification

Bootstrap is protected against routine destruction and saved-plan tooling refuses unexpected resources, destructive actions, credential overrides and incorrect accounts. Bootstrap resources still have costs; the budget is an alert guardrail, not a hard cap, and includes existing non-Flow account charges.

Runtime packaging, secure dashboard access, deployed migration/permissions, hosted Stripe proof, observability and actual runtime destruction passed. Single-AZ, disposable data, demo access, the existing broad deployment user, sandbox Stripe, synthetic bank, no HA and no 24/7 commitment remain explicit limitations. Financial interpretation and database durability are unchanged; no broker, queue, payment product or AI is introduced. Offline sandbox setup actions remain separate from runtime.

See [Phase 15 workflow](../../phase15/README.md) and [executed evidence](../../phase15/verification.md). Verified demo deployment does not imply production readiness. Runtime is destroyed after evidence capture; persistent state, images, budget and delegation support future demonstrations.
