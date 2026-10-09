# Phase 15 — Ephemeral AWS portfolio deployment

Container packaging, separate Terraform roots and actual hosted application/Stripe verification are implemented. See [verification](verification.md) for the deployment and teardown evidence and [ADR-018](../architecture/adr/018-ephemeral-aws-demo.md) for decisions. This is a production-shaped demonstration, not a high-availability production environment. Phase 16 remains deferred.

## Approved boundaries

Use only `iamadmin-general`, AWS account `163596511125`, `us-east-1`, environment `demo`. No production profile, root identity, live Stripe, real bank, payment initiation, financial web mutation, new queue, AI or Phase 16 work. PostgreSQL remains financial truth; existing outbox/worker fencing and financial PASS/FAIL/UNKNOWN semantics are unchanged.

Persistent bootstrap owns:

- Private S3 state bucket `flow-demo-tfstate-163596511125-us-east-1`, versioning, AES256 encryption, public-access block, bucket-owner enforcement and HTTPS-only policy.
- ECR `flow-demo/ops`, `flow-demo/stripe`, `flow-demo/admin`. Stripe ingress and worker use separate commands from one adapter image; admin is one-shot only. Immutable versioned tags and deployed image digests are required. Untagged remnants expire after seven days; tagged deployment images are retained.
- Account-wide $10/month budget, actual alerts at 50%, 80%, 100%, and forecast alert at 100%, using the operator-approved contact. Account-wide coverage includes existing unrelated spend and avoids assuming tag activation. **Not a hard spending cap.**
- Route 53 public child zone `flow.edtosoy.com`, created only after state migration. Root domain and existing Cloudflare records remain in place.

The runtime contains two public ALB/task subnets, two private RDS subnets, three small Fargate services, one HTTPS ALB, encrypted Single-AZ RDS PostgreSQL 18.6 (`db.t4g.micro`, 20 GiB gp3), five CloudWatch groups with three-day retention, least-privilege IAM, nine SSM SecureString parameters and an ephemeral Route 53 ALB alias. No NAT gateway, Multi-AZ database, VPC endpoints, broker or redundant environment. All services use 0.25 vCPU; operations receives 1 GiB, ingress/worker 512 MiB. Task HTTP ingress is allowed only from the ALB; database port 5432 only from five explicit task security groups. RDS is not publicly accessible.

Database URLs, Stripe key/signing secrets and dashboard access secrets must never enter images, plaintext task environments or Terraform outputs. Admin/migration and runtime PostgreSQL credentials stay separate. The hosted Stripe destination secret must be obtained separately from the local CLI secret. The dashboard cannot be exposed before its demo access boundary exists.

## Bootstrap workflow

Terraform **1.15.x**, pinned AWS provider **6.68.0**. Commands fail closed against a wrong account/root identity, environment credentials/endpoint overrides or injected Terraform arguments. The approved profile and region are selected explicitly. Current broad deployer permissions do not authorize broad workload roles.

```sh
# Supply FLOW_BUDGET_EMAIL through the environment once; tooling saves only the
# local ignored .deployment/bootstrap.tfvars.json, mode 0600. No AWS keys here.
pnpm aws:deploy bootstrap-plan
# Inspect resource actions and private saved plan locally before applying:
pnpm aws:deploy bootstrap-apply --reviewed
pnpm aws:deploy bootstrap-migrate-state
pnpm aws:deploy bootstrap-dns-plan
# This second plan should create only the public child zone:
pnpm aws:deploy bootstrap-apply --reviewed
# STOP here. Report nameservers; wait for the user's Cloudflare confirmation.
```

The first apply creates the bucket with local seed state, plus ECR and budget. Only then does `bootstrap-migrate-state` generate ignored `backend.generated.tf` and copy that existing state to S3 key `bootstrap/terraform.tfstate`, with versioning/encryption/native locking. The command refuses an existing destination state; a private ignored seed backup is retained. A new checkout reconnects using `pnpm aws:deploy bootstrap-connect` before planning, rather than creating a new local state for an existing bucket. The eventual demo will use separate key `demo/terraform.tfstate`.

`.deployment/` is mode 0700; configuration, plans and CLI logs are mode 0600 and Git-ignored. Logs and Terraform state remain sensitive even when outputs are not. Commit provider lockfiles; never commit state/backup, saved plan, generated backend/configuration or credentials. Do not upload or share a raw saved plan/CLI log as portfolio evidence.

## Mandatory Cloudflare checkpoint

After the child zone exists, add exactly four Cloudflare records in `edtosoy.com`, type **NS**, name **flow**, one value per actual nameserver output. Use Auto/default TTL. Never invent values or modify the parent nameserver assignment. Keep the delegated child zone across routine demo destroys to avoid recurring parent edits.

Only after the user confirms those records:

```sh
pnpm aws:deploy dns-verify --confirmed
```

This compares the four actual zone nameservers with public queries through both 1.1.1.1 and 8.8.8.8. Propagation failure blocks continuation. No Cloudflare provider/token is used. Terraform can subsequently manage the ACM validation CNAME within the delegated zone and an apex ALB alias, without Cloudflare edits for recreated ALBs.

## Deployment workflow

After delegation verification, build/push versioned images, inspect the billable-resource plan, deploy initially disabled services, run one-shot migrations/provisioning and deterministic synthetic setup, configure a dedicated hosted Stripe sandbox destination, then start services. Verify HTTPS, access protection and signed webhook-first processing before backfill. Capture redacted evidence, retire the sandbox destination, destroy runtime, verify removal and retain bootstrap/state.

The main cost drivers will be RDS compute/storage, active Fargate tasks, ALB, public IPv4 and logs. Keep runtime short-lived; a $10 alert does not guarantee staying under $10. State versions and retained images accumulate low-volume storage costs; the child zone remains a persistent charge. There is no production HA/restore/24-hour operating claim.

Current official references: [native S3 backend locking](https://developer.hashicorp.com/terraform/language/v1.15.x/backend/s3), [delegated subdomain](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/CreatingNewSubdomain.html), [ACM DNS validation](https://docs.aws.amazon.com/acm/latest/userguide/dns-validation.html), [RDS PostgreSQL versions](https://docs.aws.amazon.com/AmazonRDS/latest/PostgreSQLReleaseNotes/postgresql-versions.html), [budget notification configuration](https://registry.terraform.io/providers/hashicorp/aws/6.68.0/docs/resources/budgets_budget).

## Runtime commands

```sh
pnpm aws:demo prepare        # retain/generated private cloud-only credentials; verify sandbox account
pnpm aws:demo images         # frozen builds, immutable ECR source tags, resolved digests
pnpm aws:demo plan           # validate, mocked security tests, private reviewed saved plan
pnpm aws:demo apply --reviewed
pnpm aws:demo provision      # one-shot migration/narrow-role/synthetic demo task
pnpm aws:demo destination    # dedicated hosted test-mode Stripe destination; private new signing secret
pnpm aws:demo enable
pnpm aws:demo plan
pnpm aws:demo apply --reviewed
pnpm aws:observe             # HTTPS, protected dashboard, ECS/ALB readiness, private DB/state
pnpm aws:demo sandbox-payment  # explicit offline sandbox test tooling, no product endpoint
pnpm aws:demo proof          # requires webhook-first durable evidence BEFORE backfill
pnpm aws:demo backfill
pnpm aws:demo backfill
pnpm aws:demo proof          # stable event, raw digest, completion and economic identities
pnpm aws:demo verify-sandbox
pnpm aws:demo retire-destination  # only this cycle's test-mode endpoint; keep financial objects
pnpm aws:demo destroy-plan
pnpm aws:demo apply --reviewed
pnpm aws:observe destroy-verify
pnpm aws:demo reset          # archive evidence, new semantic demo identity, disabled services
pnpm aws:demo plan           # prove fresh reproducibility without unnecessary re-apply
```

The runtime begins with zero desired services until one-shot provisioning and the dedicated hosted signing secret are available. Its task definitions reference only SSM SecureString ARNs. Database passwords are generated separately for each capability; owner access belongs only to the one-shot administrator. RDS enforces TLS and connections use verify-full plus the AWS regional CA bundle. The RDS master is granted explicit owner-role SET membership for migrations because RDS master is not a PostgreSQL superuser. Existing SQL migrations and financial functions are unchanged.

Provisioning creates eleven distinct capability logins, checks exact membership and forbidden financial-write denials, and runs the existing public synthetic normalization/control/integrity workflow through narrow connections. This one-shot setup does not require an additional always-running general worker. The separate verifier task receives only narrow Stripe URLs/test key and never DATABASE_ADMIN_URL. Runtime task roles have no AWS API policies; execution roles have only workload-specific ECR/log/SSM permissions, with the required ecr:GetAuthorizationToken wildcard-resource exception. No workload receives AdministratorAccess.

The sensitive Terraform map is ephemeral; RDS password_wo and SSM value_wo prevent actual values from entering saved attributes. Parameters are injected through ECS secrets references. State remains sensitive. Secret/configuration variable names: DATABASE_ADMIN_URL, FLOW_PROVISIONING_CONFIG, DATABASE_OPERATIONS_URL, STRIPE_INGRESS_DATABASE_URL, STRIPE_WORKER_DATABASE_URL, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRETS, FLOW_DEMO_USERNAME and FLOW_DEMO_PASSWORD. Open private configuration locally when accessing the dashboard; never paste secrets into chat or shell history.

The hosted destination uses the Phase 14 allowlist and API 2026-09-30.endive. ALB routes only /webhooks/stripe to ingress; other paths go to operations. No Stripe CLI listener runs in AWS. The offline sandbox setup uses the current API's allowed_payment_method_types card allowlist and a versioned deterministic idempotency key. The unchanged tool behind pnpm stripe:verify:sandbox runs as node tools/verify.cjs inside the narrow ECS image, which deliberately excludes pnpm/TypeScript. Completeness remains UNKNOWN and the bank side remains synthetic; real processor evidence is not independent real-bank proof.

One-shot commands have a ten-minute bound and stop only their own task on expiry. reset requires verified destruction and empty demo state, archives private evidence under .deployment/history, creates a fresh book identity, clears source/book/startup fields and requires a new hosted destination. A new deployment provisions its own source UUID; a new semantic identity avoids reusing prior sandbox payments. The retained child zone avoids recurring Cloudflare edits.

Ops uses Next.js standalone output and a demo-only shared Basic credential over HTTPS. It is generated privately, injected through SSM, compared using fixed-size SHA256 digests with timingSafeEqual, and discarded from forwarded request headers. Missing configuration fails closed. Financial routes/metrics/prefetches are protected; only exact cheap technical probes and public static assets bypass the gate. This access boundary has no user lifecycle, recovery, individual audit identity or production authentication claim. Task ingress is only from the ALB.

Esbuild 0.28.2 is pinned as a direct build-only dependency (already present transitively through tsx) to bundle Node worker/admin entrypoints without shipping TypeScript/dev dependencies. Bundle input manifests reject oracle/test code; the administrator image receives only public synthetic inputs, not generator/oracle modules. No secrets enter build arguments or context.

References: [Next standalone output](https://nextjs.org/docs/app/api-reference/config/next-config-js/output), [Node runtime Proxy](https://nextjs.org/docs/app/api-reference/file-conventions/proxy), [ECS SSM secret injection](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/secrets-envvar-ssm-paramstore.html), [RDS verified TLS](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.SSL.html), [official Stripe sandbox webhook destination API](https://docs.stripe.com/api/webhook_endpoints/create).

Additional references: [destination retirement](https://docs.stripe.com/api/webhook_endpoints/delete), [current sandbox PaymentIntent parameters](https://docs.stripe.com/api/payment_intents/create). Limitations include disposable data/no final snapshot or backup, Single-AZ/no HA, shared demo access, the existing broad deployment user rather than federated automation, sandbox Stripe/synthetic bank only, and no 24/7 commitment. No Phase 16 functionality is introduced.
