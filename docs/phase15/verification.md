# Phase 15 verification

Date: 2026-10-09. **Hosted deployment and actual destruction PASS.** This is controlled ephemeral portfolio evidence, not production readiness, high availability or a production SLA. Phase 16 was not started.

## Account, baseline and manual actions

Every real apply used `iamadmin-general`, AWS account `163596511125`, region `us-east-1`; tooling rechecked STS immediately before apply. No root identity or `iamadmin-production` was used. Existing local Phase 14 provisioning was retained, not repeated or overwritten.

Initial working tree was clean. Financial-domain implementations and migrations 001–013 are unchanged. Current tooling: Terraform 1.15.3, AWS CLI 2.34.24, AWS provider 6.68.0, Docker 29.8.0, Node 24.21.0, pnpm 11.27.0, Next.js 16.4.0, Stripe SDK 23.0.0. Esbuild 0.28.2 is the only new direct build dependency; it already existed transitively through tsx. No hosted observability dependency, AWS runtime SDK, Cloudflare provider or new queue was added.

The operator supplied the budget contact and added the four actual child-zone NS records in Cloudflare after the mandatory STOP. Public delegation matched through both 1.1.1.1 and 8.8.8.8 before ACM/HTTPS deployment. Existing sandbox credentials were verified privately through Stripe API reads; no new manual Stripe login or secret disclosure was needed. Hosted destination creation and retirement used official sandbox API tooling.

## Persistent bootstrap and remote state

| Gate             | Executed evidence                                                                                                                                                                                                                              |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Seed/bootstrap   | Reviewed 13-resource seed applied, then existing local state migrated to S3; no self-creating backend fiction or state overwrite                                                                                                               |
| S3               | `flow-demo-tfstate-163596511125-us-east-1`: Enabled versioning, AES256, all public-access blocks, owner enforcement and HTTPS-only policy                                                                                                      |
| State separation | `bootstrap/terraform.tfstate` and `demo/terraform.tfstate`; both native `use_lockfile=true`, approved account/profile                                                                                                                          |
| Native locking   | Controlled conditional native-format lock fixture held; real Terraform plan refused contention; only its verified ID/matching ETag lock removed; state object version unchanged. This was not two competing Terraform clients. No force unlock |
| ECR              | Three actual immutable-tag/scanned/encrypted repositories: `flow-demo/ops`, `flow-demo/stripe`, `flow-demo/admin`                                                                                                                              |
| Budget           | Account-wide $10/month; actual 50/80/100% and forecast 100% alerts; four actual notifications each matched the approved email subscriber. Delivery to the recipient was not separately tested. This is not a hard cap                          |
| DNS              | Public `flow.edtosoy.com` child zone `Z01534402E4PPZIHFEDCR`; DNS-only plan created one zone, no parent-zone changes                                                                                                                           |
| Terraform tests  | Three bootstrap and two demo mocked-provider plan-only runs passed; both roots fmt/validate passed with pinned provider lockfiles                                                                                                              |

Actual child nameservers: `ns-1423.awsdns-49.org`, `ns-1952.awsdns-52.co.uk`, `ns-413.awsdns-51.com`, `ns-669.awsdns-19.net`. Root DNS remains Cloudflare; no Cloudflare credentials/provider were introduced.

## Container and infrastructure evidence

Three production targets built with frozen dependencies from the digest-pinned Node base. The Dockerfile frontend is pinned too. All images run as UID 1000. Next standalone production build succeeded. The non-secret source build ID was `source-c2e85046f0acc621cfedb766`.

| Image                  | Actual deployed ECR digest                                                |
| ---------------------- | ------------------------------------------------------------------------- |
| Operations             | `sha256:88091f33df677bdefb675d59cc5a24d19b5c798308f828931bac4eec2cdc05df` |
| Stripe ingress/worker  | `sha256:867948703e650a3fca6be810c9bd50dcdf67c94f398a7b5b19fedd19f7af775a` |
| Administrator/verifier | `sha256:9b22fd467d4838ef830a7c3cef232a857b7742f9a3d0a693791add8da40d586f` |

ECS read-back confirmed the running operations/ingress/worker containers used these exact immutable digests. Intermediate immutable build tags remain intentionally in ECR. No mutable latest deployment is used.

The reviewed first demo plan created **92 resources**, zero updates/deletes. A subsequent reviewed startup plan updated nine write-only SSM parameters, revised five same-family task definitions and started three services; it did not replace RDS/networking. Actual checks passed:

- Three services each desired/running 1, pending 0; both ALB target groups healthy.
- Private encrypted Single-AZ RDS PostgreSQL 18.6, db.t4g.micro, 20 GiB gp3; no public accessibility, zero backup retention/deletion protection, no final snapshot.
- Private RDS DNS addresses in 10.42.0.0/16, DB ingress only explicit task security groups; task/database groups have no IPv4/IPv6 CIDR ingress.
- No NAT Gateway in the demo VPC. Public task IPs are used for outbound access; HTTP task ingress only from ALB.
- ACM issued for flow.edtosoy.com; actual HTTPS connection authorized with TLSv1.3. Certificate ARN: `arn:aws:acm:us-east-1:163596511125:certificate/210df4c5-cc84-425a-8b9b-eb6e43e33870`.
- Three-day retention read back for all five CloudWatch groups; existing structured ingress logs retained correlation ID, operation, duration, accepted outcome and event ID without raw payload/signature.

All long-running tasks use 256 CPU units; ops 1024 MiB, ingress/worker 512 MiB. Separate one-shot administrator/verifier definitions avoid persistent owner privileges. Actual IAM read-back found no inline/attached AWS policies on any of the five runtime task roles, no managed policies on execution roles, scoped ECR/log/SSM execution actions, and ECS trust conditions for the approved account. ECR authorization-token wildcard resource is the required exception. No workload AdministratorAccess.

## Fresh database and application

One-shot provisioning task `dedf133fbd954f9db27a563840bf1f17` exited zero on private RDS. Migrations 001–013 applied. Eleven generated `flow_demo_*` logins each inherit exactly their approved capability; no owner membership, superuser, create-role/create-database, replication or bypass-RLS flags. Forbidden ledger.book DELETE was denied with SQLSTATE 42501 for every login. Owner connection is confined to one-shot provisioning; verification tasks receive only narrow source-bound URLs.

Verified deployment identities:

- Stripe book: `3cb6d4ae-1a96-4783-a0a5-26d1faad45ee`.
- Stripe source: `21354985-f9c7-46fb-afb0-035f38111bfb`.
- Public synthetic demo book: `1cc51fd4-30cb-6efb-4f8a-f9c30b58e791`.

The unchanged public synthetic seed/control/integrity workflow passed through narrow ports. Its financial assurance was **FAIL**, retained explicitly; successful provisioning is not financial PASS. Synthetic bank evidence is not independent external bank proof.

Actual HTTP checks: unauthenticated root/controls/metrics **401**; authenticated overview and metrics **200**; technical liveness/readiness **200** despite financial FAIL; unsigned webhook **400**. Missing credentials in the local production container return **503** for financial routes/metrics, with liveness 200 and missing-database readiness 503. The shared demo Basic credential is generated privately, injected from SSM, timing-safe compared server-side, stripped before forwarded reads and never embedded in client code.

Real system Chromium check of the protected deployed dashboard: HTTP 200, one expected Financial operations heading, zero page errors, zero POST mutation forms; observed initial navigation/screenshot activity approximately **3.88 seconds**. This is one browser observation, not a percentile benchmark or production SLA. Screenshot remains private.

## Actual hosted Stripe sandbox proof

Account: `acct_1UOVU2AoTLlql5uC`. Dedicated test-mode destination: `we_1UOYrCAoTLlql5uCub2p42mY`, URL `https://flow.edtosoy.com/webhooks/stripe`. Its signing secret was generated by Stripe, stored privately/in SSM and never substituted with a local CLI signing secret. Runtime API/version policy remains `2026-09-30.endive` and the unchanged Phase 14 allowlist.

Controlled successful test capture:

- PaymentIntent `pi_3UObgnAoTLlql5uC0tIGPCcy`.
- Charge `ch_3UObgnAoTLlql5uC0H2iw1Bq`.
- Event `evt_3UObgnAoTLlql5uC0A3usSYw`, `charge.succeeded`, origin **webhook**, event API version `2026-09-30.endive`.
- One immutable raw receipt, digest `f73171d8ffb5ed030f675710088ba9c69c2316814934c7a5fa9f652760f1a5cf`.
- One successful durable completion; processor activity derivations `41c0c319-9313-4284-852b-24ed0ed9af45` and `7116c078-3a43-4ba5-9e10-82b47cc26f99` for captured charge/fee evidence.
- Real API snapshots include Charge and Balance Transaction `txn_3UObgnAoTLlql5uC0sg0JLMZ`.

Ingress CloudWatch accepted the signed event in **123 ms**, with a bounded structured record and correlation ID. Narrow proof task required webhook origin before any API backfill, raw digest, successful worker completion and real financial API enrichment; it passed.

Two overlapping one-hour Events API recovery runs each reported received **1**, duplicate **1**, no API failure, completeness **UNKNOWN**. A second narrow proof confirmed the same event identity/raw digest, raw count 1, completion count 1 and identical economic derivation IDs after both runs. No duplicate capture or fee interpretation appeared.

The unchanged tool behind `pnpm stripe:verify:sandbox` ran against the hosted source/RDS as `node tools/verify.cjs` in the narrow ECS verification task: **externalSandbox PASS**, eventsRecovered **2**, completedEvidence **1**, synthetic bank boundary. Normal CI still requires no Stripe network/credentials. This proof concerns hosted captured charge/fee ingestion, not untested external refund/dispute/payout lifecycles or all-time completeness.

The dedicated sandbox destination was retired through official API after evidence capture, with account, URL and live-mode checks. Stripe financial test objects were retained.

## Regression and security checks

| Command/check                       | Result                                                                                                                                                                                                                                                                                         |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| pnpm install --frozen-lockfile      | PASS                                                                                                                                                                                                                                                                                           |
| Full pnpm verify                    | PASS, exit 0: formatting, full lint/oracle dependency checks, 24 project builds including Next production, typechecks, 15 project unit/property targets, 5 boundary tests, 4 Stripe HTTP tests, 6 deployment tests at that run, **293 real PostgreSQL integration tests**, zero skipped/failed |
| Final pnpm test:deployment          | PASS, **8** tests after added provider-refresh/task-revision regressions                                                                                                                                                                                                                       |
| Final scoped TypeScript/lint        | PASS for subsequent deployment-only tooling changes; financial/application implementation was not changed afterward                                                                                                                                                                            |
| pnpm test:stripe                    | PASS, **15** real PostgreSQL tests, including signature, immutable duplicate/conflict, ordering, crash/retry, source capability and fencing checks                                                                                                                                             |
| pnpm test:boundaries                | PASS, **5** tests; runtime/browser/oracle boundaries retained                                                                                                                                                                                                                                  |
| Migration upgrade history witnesses | PASS, populated 001–013 paths retained                                                                                                                                                                                                                                                         |
| Container/runtime secret review     | Known generated/cloud/Stripe secret values absent from source and all three actual Docker archives/layers; final images inspected without .env/oracle files                                                                                                                                    |
| Saved plan and current state        | Known generated secret/password values absent; actual remote object AES256/versioned; write-only SSM values are empty sentinels, never plaintext                                                                                                                                               |

Source review covered 335 Git-visible files at execution and 23 known sensitive values. The only initial match was the unchanged public local DATABASE_ADMIN_URL example in docs/phase1/README.md, excluded from the sensitive-cloud-value comparison after confirming its documented purpose. Cloud credentials are distinct. Exact-value/pattern review does not prove absence of arbitrary encoded secrets. No new AWS/Stripe/database credentials were committed or printed; no commit/push performed.

Legitimate repairs made during verification: normalize the provider's exact-ten budget representation; accept only null/empty write-only SSM sentinels while rejecting plaintext; permit only same-approved-family ECS task revisions; declare force_ssl's pending-reboot application method; remove the obsolete sandbox payment_method_types request field in favor of the current documented allowed_payment_method_types parameter and version that setup request's idempotency key after prior HTTP 400 rejection. None changed financial predicates, signature checking, replay tolerance, source binding or narrow permissions.

Initial local tsx IPC was sandbox-denied; the unchanged native tests then passed with appropriate execution permission. A host-only bundler path-resolution issue was not counted as a passing host build; production Docker builds passed. Chromium uses the repository-tested system executable on NixOS. No tests were skipped, weakened or falsely labeled passed.

## Runtime destruction and retained reproducibility

The reviewed destroy plan contained **92 runtime deletions** and zero bootstrap changes. It was actually applied. Direct AWS verification passed: RDS and ALB absent; ECS cluster/services removed; VPC absent; runtime SSM parameters gone; all runtime IAM roles and CloudWatch groups removed; the child zone contains only NS/SOA records. Demo state has zero managed resources. State versioning, all three ECR repositories, the budget and the delegated child zone remain intentionally.

Private evidence was archived under `.deployment/history/3cb6d4ae-1a96-4783-a0a5-26d1faad45ee`. The tested reset command generated a new demo semantic identity and cleared startup/source/book configuration. A fresh disabled-services recreation plan passed format, validation, both mocked security tests and saved-plan guards against the retained backend, zone and image digests: **92 creates, zero updates/deletes**, no bootstrap changes. It was deliberately **not applied**; re-creation is supported by this plan plus the first actual deployment, rather than a second charged deployment.

Intentionally persistent: state bucket/versions, three ECR repositories/tagged images, public child DNS zone and account-wide budget. Inactive ECS task-definition metadata may remain in AWS after deregistration and incurs no running-task charge. Root Cloudflare records remain otherwise unchanged. Runtime data is disposable; final snapshots/backups are intentionally disabled. The public ALB alias/certificate belong to runtime, so the dashboard is unavailable after destruction.

## Changed files and limits

- Infrastructure: infra/AGENTS.md; infra/bootstrap and infra/demo Terraform, tests and provider lockfiles.
- Containers: .dockerignore, container/Dockerfile, public regional RDS CA, public synthetic demo inputs, tools/build-containers.mjs.
- App packaging/access: apps/ops/next.config.mjs, proxy.ts, demo-access.ts; apps/integrations/src/main.ts explicit host binding.
- Provisioning/deployment: tools/cloud-provision.ts, cloud-stripe-proof.ts, deploy.ts, demo-deploy.ts, demo-observe.ts, deployment-guards.ts; unchanged seed extraction into ops-demo-seed.ts and corresponding ops-demo/oracle-boundary adjustment.
- Tests/dependencies: deployment/access tests; package scripts, package.json and pnpm-lock.yaml.
- Documentation: Phase 15 README/report, ADR-018, architecture/index/sequence, root README and AGENTS.md; ignored private evidence is not source material.

Major runtime cost drivers: ALB/public IPv4, RDS compute/storage, active Fargate CPU/memory and logs. Persistent DNS/image/state storage have continuing charges. No NAT, Multi-AZ, EKS, managed broker/cache or unnecessary endpoints. No precise bill or hard $10 ceiling is claimed.

Explicit limitations: Single-AZ/disposable database, no HA/DR or 24/7 commitment, shared demo identity, existing broad deployment user, sandbox-only Stripe, synthetic-only bank, no all-time completeness claim. No live payment, payment product, real bank, new queue, financial web mutation or AI was implemented. Phase 16 remains deferred. **Phase 15 acceptance is satisfied within the approved ephemeral demo scope**: hosted proof, regressions, actual destruction and retained-state recreation-plan evidence passed. No manual or external blocker remains. The dashboard is intentionally offline after destruction.

Executed workflows: pnpm aws:deploy bootstrap-plan / bootstrap-apply --reviewed / bootstrap-migrate-state / bootstrap-dns-plan / dns-verify --confirmed; pnpm aws:demo prepare / images / plan / apply --reviewed / provision / destination / enable / sandbox-payment / proof / backfill / verify-sandbox / retire-destination / destroy-plan / reset; pnpm aws:observe and destroy-verify. Terraform fmt/validate/test ran inside plan workflows. Additional read-only AWS calls checked actual identity, versioning, notifications, IAM, image digests, TLS, networking and cleanup; Docker archive/known-value review and real system-Chromium navigation ran locally. Private plans/logs/credentials were never printed as portfolio artifacts. Full verify passed before subsequent tooling-only repairs; final formatting/lint/typechecks and all eight deployment/access tests were rerun on those changes.
