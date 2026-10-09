# Phase 14 verification record

Date: 2026-10-09. Scope: sandbox processor evidence; no live financial action or real bank. **Actual Stripe sandbox verification PASS:** a real captured test payment reached signed ingress, immutable ingestion, the existing worker and processor-domain capture/fee evidence. `pnpm stripe:verify:sandbox` returned exit 0. The original local-only record below is retained as historical evidence; it is superseded for the external gate by this continuation. Refund/dispute/payout external scenarios are not claimed from this capture demonstration.

## Initial implementation verification

`pnpm test:stripe` passed against disposable **PostgreSQL 18.6**, with **14 tests, zero failures/cancellations/skips**, after the final HTTP/diagnostics changes. Log: `/tmp/flow-phase14-focused-final.log`. This runner also executes empty migration/hash checks and populated upgrade witnesses, including Phase 13 → 14 retained financial history, frozen inputs/results and operational work. Each Stripe scenario runs the existing independent integrity sweep; UNKNOWN source coverage is preserved.

`pnpm exec tsc -p tsconfig.check.json --noEmit` passed after these implementation changes. Earlier adapter/security gates passed ten adapter unit cases and four HTTP contract cases; the clean full run below is the authoritative final regression gate. At that initial checkpoint, `pnpm stripe:verify:sandbox` returned **exit 2 BLOCKED**, not a skipped success. Credentials were subsequently provisioned and the real external gate passed as recorded below.

| Focused scenario                       | Observable evidence                                                                                                                                         |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Official signed HTTP → real PostgreSQL | 200 after visible durable event; replay 200; verified conflict 409; unavailable real connection 503; ready 503 but live 200                                 |
| Immutable receipt + outbox             | Exact pretty-printed raw Buffer retained; UNKNOWN coverage; pending registered Stripe handler before processing                                             |
| Synchronized duplicate contention      | Held source-account lock; multiple observed PostgreSQL lock waiters; one event/receipt; conflicting bytes cannot overwrite                                  |
| Webhook + API overlap                  | API serialization/pending_webhooks difference deduplicates to original webhook bytes                                                                        |
| Relevant out-of-order lifecycle        | refund.updated processed before refund.created; same refund and later charge envelope create no duplicate economic effect                                   |
| Multiple partial refunds               | Distinct refund objects and exact aggregate effects                                                                                                         |
| Crash before normalization             | Real lease expiry, retained attempts and fresh-token recovery; old token cannot mutate                                                                      |
| Crash after enrichment/projection      | Durable completion replay requires no extra external fetch and creates no second processor effect                                                           |
| Explicit automatic payout membership   | Two pages of charge/refund/dispute/fee evidence conserve 6,530 minor units; existing processor and exact settlement-bank group consume evidence             |
| Existing downstream readers            | Reconciliation/controls/exceptions/integrity/ops consume Stripe derivations; matched relationship does not promote UNKNOWN source completeness              |
| Bounded overlapping recovery           | Multiple Events pages, repeat window deduplication and explicit out-of-horizon refusal                                                                      |
| Capabilities                           | Ingress/worker cannot generic-ingest, mutate ledger/processor, configure a principal or process another source; ordinary worker cannot claim Stripe handler |
| External failures                      | Rate-limit result is retryable and respects two-second guidance; unsupported event API version terminates visibly                                           |
| Lost PostgreSQL COMMIT response        | Test TCP proxy drops actual successful COMMIT acknowledgement; same event retry returns original durable receipt                                            |
| Late unsupported financial change      | Pending dispute reinstatement invalidates current assurance and settlement sufficiency; frozen reconciliation allocation remains byte-equivalent            |

Contract tests use randomly generated nonsecret test signing material with official SDK signature helpers. They cover missing/wrong/invalid/stale signatures, changed bytes, malformed JSON rejection, live/context/account rejection, allowlist policy, rotation, size/method limits, durable acknowledgement timing, redacted logs and health separation. Mapping tests cover exact captures/fees, partial refunds, dispute withdrawal/refusal, payout evidence, pagination truncation/cursor loops, version/currency/unsafe integer/FX refusals and API failure taxonomy. A local SDK HTTP transport contract verifies GET `/v1/account` and the pinned API version. None requires network access to Stripe.

## Initial production operations regression observations

The native production build/Chromium scenario passed for the retained local fixture (1,168 receipts, 204 revisions), including restricted credentials, safe bundle boundaries, zero browser errors, failed-readiness behavior, bounded metrics/logs and no stranded transaction. Five warm samples per read reported:

| Read                  | Median ms | p95 ms   |
| --------------------- | --------- | -------- |
| Overview              | 2,364.04  | 2,388.80 |
| Controls              | 946.12    | 1,033.21 |
| Reconciliation detail | 201.70    | 202.56   |
| Exceptions            | 2.84      | 5.23     |

Chromium was 153.0.8010.52. Initial navigation was 2,449.82 ms, streamed TTFB 15.40 ms, and the 26 client chunks totaled 932,927 bytes. Server RSS/high-water observations were 110,968 and 151,808 KiB; one pool connection and zero stranded transactions were observed. These sparse observations do not prove capacity or leak freedom. Timings differ from the retained Phase 13 observations and are not an optimization claim, a promise of identical latency or a production SLA. Full proof/manifest equivalence, query-count, timeout, pool and safe-observability structural gates passed; no proof coverage was removed. New provider policies and pending-evidence checks preserve conservative assurance.

The native Phase 11 load/restart gates also passed: 1,002 items and 16 workers had zero invariant violations, duplicate effects or unrecovered work; the separate local restart retained committed work. This remains local single-node evidence, not disaster-recovery or external-payment proof.

## Initial clean full verification

**PASS:** a fresh source-only copy at `/tmp/flow-phase14-clean-82_6rm00` completed `pnpm install --frozen-lockfile` and full `pnpm verify`, both **exit 0**. Dependencies/build outputs/Nx caches/Git metadata/private environment files were excluded from the initial copy. An offline install first failed because the locked Stripe tarball was unavailable locally; the frozen online install fetched that dependency without changing the lockfile.

| Gate                         | Final evidence                                                                                               |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Format                       | Native full gate passed; final documentation/guard formatting check also passed                              |
| Lint / dependency boundaries | PASS; final strengthened runtime CLI oracle guard also passed full lint and all five boundary tests          |
| Uncached build               | PASS, 24 projects including integrations and production Next.js                                              |
| Typecheck                    | PASS, repository and operations application; final guard-test typecheck also passed                          |
| Unit/property                | PASS, 94 cases across 15 Nx targets (84 retained + ten adapter cases)                                        |
| Boundary                     | PASS, five cases including added worker/backfill/config oracle probes                                        |
| HTTP contracts               | PASS, four cases                                                                                             |
| Real PostgreSQL              | PASS, 292 cases, zero failed/cancelled/skipped/todo; 1,429.92 seconds                                        |
| Full native verification     | PASS, 395 total cases; existing permissions, oracle, resilience, operations and observability gates retained |
| Actual Stripe sandbox        | Initially BLOCKED (exit 2); superseded by actual external PASS (exit 0) below                                |
| Credential review            | Zero proposed-source and existing Git-history pattern candidates; no values emitted                          |

Runtime context: Linux x64, Node 24.21.0, pnpm 11.27.0, Nx 23.2.1, PostgreSQL 18.6 and production Chromium 153.0.8010.52. PostgreSQL test persistence, locks, constraints, leases and commit outcomes are real; API contracts are local fixture evidence. The native harness owns and removes its disposable database/container and closes browsers, servers, clients, pools and timers. No existing database was reset, and no commit, push or deployment was performed.

The only source changes after the full run began were strengthening the static oracle rule and adding its probes to an existing boundary case; those passed the supplemental final lint/boundary gate. Runtime financial code and migrations were unchanged. The final type/format checks and source-copy comparison close this static-test/documentation update. No prior gate was weakened.

Executed commands (the full native command includes format, lint, uncached build, typecheck, unit/property, boundary, HTTP and PostgreSQL verification):

```text
pnpm view stripe@23.0.0 version engines
pnpm install
pnpm exec prettier --write <changed implementation and documentation paths>
pnpm exec tsx --test libs/stripe-integration/test/*.test.ts tests/stripe-http.test.ts
pnpm test:stripe
pnpm exec tsc -p tsconfig.check.json --noEmit
pnpm install --offline --frozen-lockfile  # failed: locked Stripe tarball absent
pnpm install --frozen-lockfile           # PASS in clean source copy
pnpm verify                             # PASS in clean source copy
pnpm lint                               # PASS final strengthened guard
pnpm test:boundaries                     # PASS final strengthened guard
pnpm stripe:verify:sandbox               # initial exit 2 BLOCKED; later exit 0 PASS below
pnpm typecheck                          # PASS final static-test check
pnpm format:check                       # PASS final documentation check
git diff --check
```

`<changed implementation and documentation paths>` denotes the explicit files formatted during implementation; it is not an additional executable command. Verification log: `/tmp/flow-phase14-clean-verify.log`; install log: `/tmp/flow-phase14-clean-install.log`; final guard logs: `/tmp/flow-phase14-final-boundary-lint.log` and `/tmp/flow-phase14-final-boundary-tests.log`. Focused PostgreSQL evidence is retained at `/tmp/flow-phase14-focused-final.log`. Final `pnpm typecheck` and `pnpm format:check` both returned exit 0. Logs: `/tmp/flow-phase14-final-typecheck.log` and `/tmp/flow-phase14-final-format.log`. The final source-copy/whitespace/credential review is recorded below.

## Required implementation report

| #   | Requested topic      | Implementation / evidence / limitation                                                                                                                                                                                                                                                                                              |
| --- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Files                | Root phase-status guidance, new integrations app, two Stripe packages, migration 013, two root test files, four Stripe tools, environment example, Phase 14 docs and ADR-017; changed ingestion contracts, ops provenance presentation, native test runner, workspace/build/lint/oracle configs and lockfile. Full inventory below. |
| 2   | Dependencies         | One new external package: official `stripe` 23.0.0. Existing `pg` remains 8.23.1; internal packages use workspace dependencies. Cryptographic verification/API correctness justifies the SDK.                                                                                                                                       |
| 3   | SDK                  | Official Stripe Node 23.0.0, pinned without a version range.                                                                                                                                                                                                                                                                        |
| 4   | API policy           | Read requests pin 2026-09-30.endive; each raw event preserves event-time API version; unsupported historical schemas terminate visibly.                                                                                                                                                                                             |
| 5   | Application          | Dedicated loopback Node HTTP ingress; existing Next.js operations process remains read-only.                                                                                                                                                                                                                                        |
| 6   | Packages             | Stripe SDK/types in stripe-integration; Stripe persistence/worker adapter in stripe-postgres; neutral contracts remain in ingestion-domain.                                                                                                                                                                                         |
| 7   | Schema               | Migration 013 adds immutable provider source/binding/event/API snapshot/completion tables and generic processor evidence policy; extends version guards, routing and conservative current-proof predicates. Earlier migration files unchanged.                                                                                      |
| 8   | Permissions          | Owner-only provisioning; session-bound ingress acceptance/readiness; existing operational worker plus narrow fenced writes; no direct financial table/generic ingestion/configuration access.                                                                                                                                       |
| 9   | Allowlist            | Twelve financial snapshot event types listed in README; all others explicitly rejected.                                                                                                                                                                                                                                             |
| 10  | HTTP                 | 200 committed/duplicate; 400 rejected/unsupported; 409 conflict; 413 size; 405 method; 503 failed/uncertain durability.                                                                                                                                                                                                             |
| 11  | Raw body             | Exact received Buffer, no prior parsing/reserialization, bounded 1 MiB including chunked input.                                                                                                                                                                                                                                     |
| 12  | Signature            | Official constructEvent; unsigned/invalid evidence cannot enter trusted ingestion.                                                                                                                                                                                                                                                  |
| 13  | Replay               | Secure 300-second timestamp tolerance; repeated newly signed event handled by durable event identity.                                                                                                                                                                                                                               |
| 14  | Rotation             | Runtime comma-separated explicit one/two secrets; documented overlap/removal procedure; no persisted secrets.                                                                                                                                                                                                                       |
| 15  | Acknowledgement      | Explicit synchronous PostgreSQL COMMIT includes immutable evidence and existing work intent before HTTP 200.                                                                                                                                                                                                                        |
| 16  | Provenance           | Provider/test account, event/type/version/object, event and arrival times, raw digest; immutable API attempt snapshots and labeled adapter projection artifacts.                                                                                                                                                                    |
| 17  | Duplicates           | Event-ID uniqueness plus source lock; canonical Balance Transaction economic identity deduplicates separate envelopes.                                                                                                                                                                                                              |
| 18  | Conflicts            | Same event with material differences or byte-different webhook payload cannot overwrite; API serialization equivalence preserves original receipt.                                                                                                                                                                                  |
| 19  | Ordering             | No arrival-selected revision; relevant refund update-before-create tested; unsupported pending evidence conservatively invalidates assurance.                                                                                                                                                                                       |
| 20  | API enrichment       | Read-only SDK client abstraction, account validation, immutable per-attempt snapshots, resource identity/source checks and bounded transport.                                                                                                                                                                                       |
| 21  | Charge               | Successful captured charge and authoritative balance transaction; uncaptured/inconsistent evidence refused.                                                                                                                                                                                                                         |
| 22  | Refund               | Separate successful partial/multiple refund balance movements; pending retries; failed/reversing economics unsupported/visible.                                                                                                                                                                                                     |
| 23  | Dispute              | Linked-charge withdrawals; status is not a new independent effect; reinstatements/won recovery unsupported/visible.                                                                                                                                                                                                                 |
| 24  | Balance Transactions | Authoritative gross/fee/net/currency/source/time; net conservation checks and exact minor units.                                                                                                                                                                                                                                    |
| 25  | Fees                 | Separate negative processor components from supplied Stripe fees; no fee percentage assumptions.                                                                                                                                                                                                                                    |
| 26  | Payout               | Paid automatic completed-reconciliation payout with explicit supported members; manual/failed/reversing/incomplete refused.                                                                                                                                                                                                         |
| 27  | Membership           | Payout-filtered paginated Stripe relationship, source validation, uniqueness and whole exact conservation; no amount guessing/subset sum.                                                                                                                                                                                           |
| 28  | Money                | Safe integer validation then BigInt and existing Money; PHP/USD catalog, explicit currency isolation, FX/unsafe unsupported.                                                                                                                                                                                                        |
| 29  | API retries          | Network/timeout/rate-limit/5xx retryable; credentials/schema/not-found/invalid request permanent; Retry-After bounded; existing finite worker budget.                                                                                                                                                                               |
| 30  | Worker               | Established claim/lease/token/attempt/outbox engine; Stripe-specific adapter, not a second job system.                                                                                                                                                                                                                              |
| 31  | Crash recovery       | Fenced snapshots + atomic completion receipt, replay without second effect; real COMMIT-response loss acceptance tested.                                                                                                                                                                                                            |
| 32  | Backfill             | Explicit overlapping recent windows through identical source-bound acceptance; 29-day safety horizon; no unlimited history claim.                                                                                                                                                                                                   |
| 33  | Pagination           | Events and payout lists, 100/page, up to ten pages; invalid/repeated/exhausted cursors fail the proof/window.                                                                                                                                                                                                                       |
| 34  | Completeness         | UNKNOWN always for acquisition alone; no received-event-only PASS; pending/terminal unrepresented evidence invalidates current source proof.                                                                                                                                                                                        |
| 35  | Bank                 | Explicit synthetic demo observations only; no independent real bank completeness claim.                                                                                                                                                                                                                                             |
| 36  | Dashboard            | Existing reconciliation detail adds bounded safe processor provenance; existing results/exception/control/integrity surfaces retained.                                                                                                                                                                                              |
| 37  | Logs/metrics         | Safe structured ingress/worker logs, generated correlation ID, fixed process counters, local text/JSON export, no financial truth from metrics.                                                                                                                                                                                     |
| 38  | Security             | Sandbox/live/account/size/signature/secret redaction tests; proposed-source and existing Git history credential-pattern scans found zero candidates; values were never printed.                                                                                                                                                     |
| 39  | Contracts            | Ten adapter unit and four HTTP tests, including official signature and local SDK HTTP contracts; no external network.                                                                                                                                                                                                               |
| 40  | PostgreSQL           | Fifteen focused real database scenarios plus migration/retention checks; 293-case post-repair full PostgreSQL suite passed.                                                                                                                                                                                                         |
| 41  | Duplicates/order     | Locked concurrent acceptance, material conflict, API overlap, separate same-object events, related refund ordering and source-collision proof-count refusal.                                                                                                                                                                        |
| 42  | Resilience           | Stripe leases/crash/unknown-commit gates passed; complete prior resilience suite passed in the clean full run.                                                                                                                                                                                                                      |
| 43  | API failures         | Local taxonomy includes network/timeout/429/5xx/auth/not-found/invalid/schema; PG verifies retry guidance and terminal unsupported version.                                                                                                                                                                                         |
| 44  | Actual sandbox       | PASS, real signed charge event, real API enrichment and capture/fee derivations; command exit 0; details below.                                                                                                                                                                                                                     |
| 45  | Workflow             | Secure offline provision → dedicated ingress + existing worker → official CLI signed forwarding/coherent sandbox object → existing ops; README includes backfill/recovery.                                                                                                                                                          |
| 46  | Commands             | Focused native PostgreSQL, adapter/HTTP contracts, typecheck and actual sandbox command executed; clean frozen install/full verify passed; exact commands above.                                                                                                                                                                    |
| 47  | Full result          | PASS, post-repair pnpm verify exit 0, 396 cases, zero failures/skips; initial clean 395-case record retained above.                                                                                                                                                                                                                 |
| 48  | Architecture         | ADR-017 and architecture index updated for meaningful dedicated external-ingress/asynchronous-neutral interpretation decision.                                                                                                                                                                                                      |
| 49  | Risks                | Account-secret configuration trust; exact one API version/currency scope; API snapshots decoded not wire; terminal earlier event may keep source UNKNOWN indefinitely; external proof covers captured charge/fee only.                                                                                                              |
| 50  | Deferred             | Live/Connect/payment initiation/billing/real bank/cloud/AI/new queues/arbitrary N:M/web mutations/production identity/Phases 15–16 and unsupported reversal economics.                                                                                                                                                              |
| 51  | Acceptance           | Local gates and the actual external sandbox gate passed for the documented supported V1 boundary; reversal/recovery scope remains explicitly unsupported. Post-repair regression evidence is recorded below.                                                                                                                        |

## Files

Created:

- `apps/integrations/{package.json,project.json,tsconfig.json,src/index.ts,src/main.ts}`
- `libs/stripe-integration/{package.json,project.json,tsconfig.json,src/index.ts,src/telemetry.ts,test/fixture.ts,test/stripe.test.ts}`
- `libs/stripe-postgres/{package.json,project.json,tsconfig.json,src/index.ts}`
- `database/migrations/013_stripe_sandbox.sql`
- `tests/stripe-http.test.ts`, `tests/stripe.integration.test.ts`
- `tools/stripe-config.ts`, `tools/stripe-worker.ts`, `tools/stripe-backfill.ts`, `tools/stripe-verify-sandbox.ts`
- `.env.example`, `docs/phase14/README.md`, `docs/phase14/verification.md`, `docs/architecture/adr/017-external-processor-ingress.md`

Modified:

- `AGENTS.md`, `.gitignore`, `package.json`, `pnpm-lock.yaml`, `eslint.config.mjs`
- `tsconfig.json`, `tsconfig.base.json`, `tsconfig.check.json`
- `libs/ingestion-domain/src/index.ts`, `apps/ops/components/views.tsx`
- `tools/oracle-boundary.mjs`, `tools/test-postgres.ts`, `tests/simulator-boundaries.test.ts`
- `docs/architecture/README.md`, `docs/architecture/adr/README.md`

## Acceptance criteria audit

| User criteria | Status / qualification                                                                                                                                                                             |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1–19          | Dedicated sandbox ingress, raw verification/age/size, durable immutable receipt, semantic duplicates/conflicts, ordering and provider boundaries implemented; focused gates pass.                  |
| 20–25         | Capture/refund/dispute-withdrawal/fees/Balance Transaction mapping tested. Positive reinstatement and failed-refund reversal are unsupported visible conditions, not falsely mapped.               |
| 26–30         | Explicit automatic completed payout membership, exact Money and currency checks tested; failed-payout reversal/manual payout/FX remain unresolved.                                                 |
| 31–35         | Bounded external classification/retry, existing leases/fencing, replay and pagination tested locally.                                                                                              |
| 36–39         | Bounded overlapping backfill exists, deduplicates, and never claims all-time/source completeness PASS.                                                                                             |
| 40–45         | Oracle isolation gates included; synthetic bank labeled; existing downstream readers exercised with real PG fixture evidence. Actual Stripe capture/fee evidence proven in the continuation below. |
| 46–55         | Safe fixed logs/metrics, ordinary CI without credentials/network, PostgreSQL/security/duplicate/order/API/mapping gates implemented; clean final run passed.                                       |
| 56–60         | PASS, clean full prior resilience/dashboard/observability/regression/build gates.                                                                                                                  |
| 61–65         | No prohibited real bank/cloud/AI/queues/live financial actions implemented.                                                                                                                        |
| 66            | PASS, real signed sandbox charge event and supported processor interpretation; command exit 0.                                                                                                     |
| 67            | Initial missing credentials were explicitly reported; later external proof is actual sandbox evidence, not a fixture.                                                                              |

Technical readiness never depends on financial PASS. Unrepresented evidence remains visible, historical truth remains immutable, and scope limitations are not waived to satisfy a benchmark or acceptance checklist.

Initial implementation review: the workspace implementation/configuration files matched the clean verified copy; documentation is synchronized after recording results. `git diff --check` passed. Proposed-source and Git-history credential-pattern scans found zero candidates. This is pattern scanning plus review, not a claim that arbitrary encoded secrets can be detected. No Phase 15 work was performed.

## Actual Stripe sandbox continuation

User-approved CLI browser authentication and the configured test API key both retrieved account `acct_1UOVU2AoTLlql5uC`. Stripe confirmed response API version `2026-09-30.endive`. The temporary Nix shell provided Stripe CLI 1.37.2; global NixOS configuration was unchanged. Existing local provisioning was reused: PostgreSQL 18.6, migrations 001–013, book `2ddc8881-e65e-4cd9-9c34-070510a81f6a`, source `e7094d93-3980-45d1-8905-1ae757628786`, and the distinct `flow_stripe_ingress_login` / `flow_stripe_worker_login` logins. No additional role membership, schema privilege or migration was added.

The CLI listener used exactly the twelve-event Phase 14 allowlist, test mode and `http://127.0.0.1:4242/webhooks/stripe`. Its reported API version matched the adapter. The generated signing secret was captured directly into Git-ignored `.env`, preserving mode 0600, without printing it. All required environment fields are now populated. Ingress and worker used the documented explicit Node `--env-file=.env --import tsx` commands and their respective narrow runtime connections. Ingress `/health/live` and `/health/ready` returned HTTP 200. The worker has no HTTP health server; its account check, successful fenced attempt and database state establish its activity.

There were no supported charge events in the preceding day. A separate one-off sandbox-only official SDK command created and confirmed a PaymentIntent using `pm_card_visa`, automatic capture, account-default USD currency and a deterministic semantic idempotency key. No payment-creation code or endpoint was added to Flow. An initial request was rejected because `payment_method_types` is no longer accepted by this API; the corrected test request followed Stripe's [dynamic payment methods guidance](https://docs.stripe.com/payments/payment-methods/dynamic-payment-methods), with a separate deterministic key for the changed request. Secret keys and PaymentIntent client secrets were not emitted or recorded here.

| External proof           | Recorded result                                                                                                                          |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| PaymentIntent            | `pi_3UOWCxAoTLlql5uC0p2o6YII`, succeeded, `livemode=false`                                                                               |
| Captured Charge          | `ch_3UOWCxAoTLlql5uC0ifGiQoJ`, USD 2,000 minor units                                                                                     |
| Real webhook event       | `evt_3UOWCxAoTLlql5uC0ggz3Qhr`, `charge.succeeded`, event schema `2026-09-30.endive`                                                     |
| Signed delivery          | CLI forwarding HTTP 200; ingress accepted at `2026-10-09T05:19:05.582Z`; received=1, verified=1, accepted=1, rejected=0                  |
| Immutable raw receipt    | One original webhook receipt; SHA-256 `d467253bc59e252c0018a9fc4bf34203992b46d75f93adfe03c92330d67c4013`                                 |
| Work                     | `246c58c9-a1bb-4b2d-995a-88d61efc9067`, SUCCEEDED, one attempt; succeeded at `2026-10-09T05:19:06.973Z`                                  |
| API evidence             | Three immutable snapshots: Account, Charge and Balance Transaction                                                                       |
| Balance Transaction      | `txn_3UOWCxAoTLlql5uC0gwKMsR2`; gross 2,000, fee 88, net 1,912 USD minor units                                                           |
| Actual processor capture | `7b2fb493-98b1-464e-93af-446670a07f21`, PAYMENT_CAPTURE, +2,000 USD minor units                                                          |
| Actual processor fee     | `de6ffb68-1caa-48ec-805a-6a6e9ed33aa6`, PROCESSOR_FEE, −88 USD minor units                                                               |
| Overlapping recovery     | Windows `[1791519692,1791523292]` and `[1791521611,1791523411]`; each received=1, duplicates=1, exit 0                                   |
| External verification    | Exact `pnpm stripe:verify:sandbox`, with `.env` inherited securely: exit 0, externalSandbox=PASS, eventsRecovered=1, completedEvidence=1 |
| Completeness             | Two ingestion batches (event and adapter projection), both UNKNOWN; no independent all-time or bank completeness claim                   |

The webhook/backfill comparison retained one logical external event, one original raw receipt, one completed Stripe work item, the same raw digest and the same two processor derivation identities. An independent offline READ ONLY audit under `flow_processor_reader` confirmed the actual capture/fee rows and UNKNOWN coverage. Owner/admin credentials were used only for that offline read-capability session, never in runtime ingress or worker.

### Permission-safe verification repair

The first externally configured `pnpm stripe:verify:sandbox` run recovered the event but failed its final proof query: `flow_stripe_worker` cannot directly read `outbox.outbox_event` (SQLSTATE 42501). This was a verifier defect, not failed ingestion. The repair adds `StripeEvidenceWorker.completedEvidenceCount`, joining immutable completion `receipt.eventId` to the source-scoped event and permitted worker state. It requires SUCCEEDED work, its immutable successful-attempt principal bound to the same source, a matching event-created window and nonempty economic derivations. It returns an exact bigint count. No permission grant or financial interpretation changed.

The new real PostgreSQL regression explicitly confirms direct outbox access is still denied, accepted but unprocessed evidence counts as zero, completed economic evidence counts once, webhook/API replay keeps that count, and unrelated windows/sources count zero, including two genuinely acquired source events sharing one event ID. `pnpm test:stripe` passed all **15** cases with zero failures/skips, including retained permission, signature, concurrency, immutable-history, worker recovery, unknown-commit, mapping and integrity gates. Log: `/tmp/flow-phase14-external-focused-regression.log`.

The temporary listener, ingress and worker exited after graceful SIGTERM requests; the local PostgreSQL instance, immutable external evidence and private configuration remain available. No secret was committed.

### Post-repair full regression verification

**PASS:** current-workspace `pnpm verify` completed with exit 0: **396 tests overall** (94 unit/property, five boundary, four HTTP contract and **293 real PostgreSQL** cases). The PostgreSQL suite reported zero failures, cancellations, skips or todo, in **1,447.40 seconds**. Log: `/tmp/flow-phase14-external-full-verify.log`. This run included the final source-collision regression and retained migration, permissions, oracle, exact-money, immutable-history, snapshot, resilience, production-browser and Phase 13 observability/performance gates. Ordinary verification did not load private Stripe configuration or require network access to Stripe.

The production Chromium scenario again reported zero browser errors, 26 client chunks (932,931 bytes), one server pool connection and zero stranded transactions. The 1,002-item / 16-worker failure-load scenario and separate local PostgreSQL restart both reported zero duplicate effects and unrecovered work. These are local regression observations, not production capacity claims. The initial clean frozen-install/395-case record above remains historical evidence; no dependency or lockfile change was needed for this continuation.

The final source-history predicate and source-collision probe were added after the full run's initial static gates. Their focused PostgreSQL run and actual sandbox command both passed. Supplemental full format, lint, uncached build (24 projects, including production Next.js) and typecheck all completed with exit 0 against the final source, closing that timing gap. Log: `/tmp/flow-phase14-external-final-static.log`. Final whitespace review passed; the source credential-pattern scan found zero candidates, and `.env` remains ignored and untracked.

Continuation commands (secret-bearing CLI output was intercepted privately; environment values were inherited, never placed in command arguments):

```text
nix-shell -p stripe-cli --run 'stripe get /v1/account --stripe-version 2026-09-30.endive'
nix-shell -p stripe-cli --run 'stripe listen --skip-update --events charge.succeeded,refund.created,refund.updated,refund.failed,charge.dispute.created,charge.dispute.funds_withdrawn,charge.dispute.funds_reinstated,charge.dispute.closed,payout.created,payout.paid,payout.failed,payout.reconciliation_completed --forward-to http://127.0.0.1:4242/webhooks/stripe'
pnpm exec node --env-file=.env --import tsx apps/integrations/src/main.ts
pnpm exec node --env-file=.env --import tsx tools/stripe-worker.ts
pnpm stripe:backfill 1791519692 1791523292 10
pnpm stripe:backfill 1791521611 1791523411 10
pnpm stripe:verify:sandbox  # initial configured exit 1 exposed permission bug; repaired exit 0 PASS
pnpm test:stripe           # final 15-case source-scoped regression PASS
pnpm verify               # current workspace, exit 0 PASS, 396 cases
```

Backfill and verification commands above ran under a Node `--env-file=.env` wrapper spawning pnpm with inherited configuration. The sandbox capture used a separate one-off official-SDK test command outside runtime code, as described above. No provisioning was repeated in this continuation, and no Phase 15 work, commit, push or deployment occurred.

**Acceptance result:** the actual external sandbox gate is now verified for the documented Phase 14 V1 boundary, with no remaining credential/provisioning/verification blocker. Real external proof covers a captured charge and authoritative fee; refund/dispute/payout scenarios remain demonstrated by local contracts and real PostgreSQL, not additional claimed external demonstrations. UNKNOWN source completeness and all documented unsupported economics remain intact. No Phase 15 work was begun.
