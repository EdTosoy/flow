# Implementation sequence and design gates

This sequence is a recommendation, not authorization to implement or deploy. Phase 0 creates documents only. Each later milestone is the smallest coherent slice with its own control gate; dependencies do not require building the entire future UI first.

Update: the user approved Phase 0 and authorized Phase 1 only. [Phase 1 implementation](../phase1/README.md) follows that financial-core scope; Phase 2 was subsequently authorized for deterministic simulation only; see its [model and boundaries](../phase2/README.md) and [verification](../phase2/verification.md). No Phase 3 or later work is authorized. A dedicated correction/replacement approval workflow and account closure remain later features; generic full reversal and same-transaction command composition are sufficient for this milestone.

## Recommended sequence

| Phase | Small coherent result | Required acceptance gate |
| --- | --- | --- |
| 0 — Design | This package: modules, terminology, invariants, model, state/transaction/match semantics, risk and tests, ADRs | Review contradictions, confirm accounting scope assumptions, document unresolved decisions. Design proposed, implementation unproven. |
| 1 — Exact money + ledger foundation | Minimal Nx/pnpm setup only then; pure TypeScript money library; local Docker PostgreSQL; currency/accounts, controlled posting/reversal routine, runtime roles/migrations; minimal atomic audit + outbox intent tables | Real PostgreSQL rejects unbalanced/partial/cross-currency/late-entry journals; immutability and duplicate/hash-conflict tests; exact money and reversal PBT; crash-before-commit rollback. No UI or generic job framework required. |
| 2 — Deterministic simulator foundation | Versioned seeded economic generator, virtual clock, public source fixtures and private oracle separation | Same seed/version produces identical artifacts; independent accounting/control expectations; SUT cannot read oracle. Minimal ledger duplicate/fault runner. |
| 3 — Ingestion, provenance + source/processing coverage | Batch/artifact/receipt/fact revisions, normalization dispositions, lossless parser, independent manifest controls and initial retryable work | 10,000 vs 9,999; duplicate masks missing row; malformed row accounted; no overwritten bytes; retry chunk/fact dedup. Basic counts/controls ship now. |
| 4 — Internal payments + processor/settlement facts | Independent internal capture/refund expectations; typed processor charge/fee/refund/chargeback evidence; payout/batch membership with unresolved references; policy-approved posting orchestration | Cross-channel semantic idempotency, refunds/capture bounds, out-of-order payout does not fabricate counterparts; accounting template review. Unsupported types explicit. |
| 5 — Durable worker execution | Work/attempt/receipt model, SKIP LOCKED claims, fenced leases, retry/backoff/blocked cases and sweepers; local outbox fan-out | Crash/retry/lease-generation tests, no accepted work lost, receipt/effect/done atomic; observable backlog and checker heartbeat. This must precede unattended asynchronous processing. |
| 6 — Bank evidence | Synthetic bank import and pending/booked/revision semantics; transfer-reference mapping | Pending is not receipt, wrong account/currency blocked, late booked row reevaluates with provenance. No live bank connection. |
| 7 — Conservative 1:1 reconciliation + minimal cases | Frozen populations/rule versions, stable items, allocation uniqueness, exact-reference proof; explicit pending/exception dispositions and basic reason/evidence review API | Entire population accounted, ambiguous amount/date remains candidate, races across runs cannot double-consume; cases/audit exist with first unmatched result. |
| 8 — N:1 settlement composition | Itemized membership equation, signed fees/refunds/disputes, manifest agreement, separate settlement-bank proof | Complete membership required; missing fee and duplicate component fail; grouped conservation/concurrency PBT and PostgreSQL tests. |
| 9 — Full exception workflow + correction/reopening | Assignment/SLA, verified manual evidence, distinct accepted-risk state, reviewer approvals, reversal/replacement orchestration, current-proof invalidation | No force-reconciled path; approved correction atomic/idempotent; preserved historical proof; stale approvals rejected. |
| 10 — Independent financial controls | Period processor/bank/in-transit equations, lineage/coverage assurance, ledger verifier and projection freshness beyond initial ingestion controls | Independent closing reports; systematic sign/omission/offsetting-error scenarios fail; unverified evidence not reported as passing. |
| 11 — Expanded adversarial simulation | All fault schedule combinations, replay of revisions/rule versions, kill points, deadlocks/commit-ack loss and load concurrency | Assert all invariant families against real PostgreSQL; retained minimized seeds; durable backlog drains or has explicit blocked cases. Basic concurrency tests already existed, this phase broadens them. |
| 12 — Operations UI | Next.js views of exact amounts, as-of coverage, scope-specific proof, case evidence, guarded review actions | No combined misleading green status; no raw secret rendering; authorization/approval and stale-version command tests. |
| 13 — Operational readiness and benchmarks | Dashboards/runbooks, alert routing/threshold policy, load/soak targets, retention, backup/restore drills | Declare measured throughput/recovery limits; missing-telemetry health test; restore invariant/replay checks. Basic logs/metrics began with first worker, not here. |
| 14 — Stripe test-mode adapter | Verify/pin API version, explicit source identity semantics, signatures/lossless parsing, independent pull/coverage and actual available payout evidence | Contract fixtures and replay; separate test/live scope; disclose unsupported reports/bank evidence. No assumption test mode reproduces every production report. |
| 15 — Hosted infrastructure if requested | Decide hosted scope/provider then; AWS/Terraform, durable DB/evidence storage, network/secret/access controls and CI/CD | Explicit deployment authorization, cost/recovery/security review, restore and operational readiness. Cloud is not necessary for initial financial correctness. |
| 16 — Optional investigation assistance | Only if justified: read-only AI summaries/classification/suggestions over authorized evidence | No financial write capability, verified source citations, human decisions use ordinary control paths. Can remain permanently absent. |

The original suggested order placed controls too late. The outbox intent belongs with the first authoritative write; full execution can wait until needed. Source/processing coverage belongs with the first import; broader independent balance controls can follow. Cases belong with the first unexplained record. Concurrency/failure tests belong with each transaction boundary, not only a late hardening phase. Observability begins with durable worker use and grows into operational tooling.

## Recommended first implementation milestone

**An exact, immutable, single-currency ledger with atomic audit/outbox intent, tested against real PostgreSQL.** Use a tiny approved synthetic merchant account template and a callable posting/reversal API/library, with no processor adapter, matcher, application UI, broker or cloud deployment.

Deliverable criteria:

1. Money represented as bigint internally and integer strings at JSON boundaries, currency metadata/version and explicit bounds; never Number arithmetic for amounts.
2. Accounts scoped to one book/currency; posted journal complete/balanced at commit and immutable thereafter, including protection against late entry insertion.
3. Stable command/effect key returns same committed result for same canonical payload; different payload conflicts visibly; 100 concurrent attempts cannot post twice.
4. Original + full reversal yields zero account deltas; reversal/replacement command is atomic and preserves original history. Define accounting policy for the example before implementing it.
5. Posting, audit and required outbox intent commit together; injected pre-commit failures leave no journal/partial audit/outbox. Commit acknowledgement loss resolves by key.
6. Real PostgreSQL role/constraint/trigger tests and exact arithmetic/reversal property tests pass with reproducible commands. Record pin versions and limitations.

This proves the most dangerous durability and monetary boundaries before building a feature that could obscure them. Initial outbox rows need not have an active general worker until Phase 5; no promise of asynchronous delivery is made before the executor exists.

## Product/domain decisions genuinely still open

Safe initial assumptions appear in the [overview](README.md). The following require an accountable product/accounting/operations decision, not more generic repository research. They need not block Phase 0 documentation.

| Decision | Why it matters | Resolve before |
| --- | --- | --- |
| Which entity owns the funds and what accounting basis applies: merchant sales, processor clearing, or custodial/platform liabilities? Which chart/recognition policy is authoritative? | Balanced journals can be economically wrong; capture/refund/chargeback templates differ radically | Beyond provisional Phase 1 mechanics; before calling accounting production-correct |
| What independently supplies internal payment/refund expectations? Are partial/multiple captures in scope? | Independent source lineage and internal authorization cannot be inferred from processor observations | Payments and business-ledger matching |
| Which currencies and source-specific units/scale conventions are supported, and is FX required? | Unit metadata, unsupported-state handling and accounting design | Money allowlist/adapter; FX is otherwise deferred |
| What independent source manifests, sequence/closing reports and correction-order evidence are available? | Determines whether source completeness can be verified or remains explicitly unverified | Each source adapter and its assurance claims |
| Which payout types/component classes are allowed, including reserves, taxes and instant/manual payouts? | Itemized composition may not be available; fee/adjustment policy differs | N:1 or real processor integration |
| What arrival windows/calendars, materiality thresholds, case priority and review SLA apply? | Distinguishes normal pending from breached obligation; no universal banking window | Scheduled cases and real alert routing |
| Who can approve corrections, manual evidence mappings and accepted risk; which decisions require two-person review? | Authorization and fraud/error controls; accepted risk must stay financially visible | Human operations use; real-data two-person baseline cannot be weakened silently |
| How should gross exposure be presented across stages without double counting obligations? | “Unreconciled value” can mislead if both sides/scopes summed | Operations dashboard/product reporting |
| What retention/privacy policy and disaster recovery RPO/RTO are required; may any unresolved evidence ever be purged? | Immutable facts still need legal retention policy, retrievability and restoration | Production storage/deployment; no unresolved purge by default |
| What scale, acceptable reconciliation latency and operational ownership are targeted? | Determines benchmarks, paging thresholds and eventual need for processing infrastructure changes | Capacity/readiness sign-off |

No answer should be silently filled in with fabricated regulatory requirements or processor capabilities. Where source evidence is unavailable, the product must accept a narrower assurance claim rather than engineer a false proof.

## Explicitly deferred functionality

- Full application scaffolding and production behavior during this task; all SDK/framework/database pins and migrations are later.
- Money movement, live customer data, live bank feeds, processor live mode, PCI card data, multi-tenant product, multi-entity books/consolidation, treasury/reservations and customer balances.
- FX posting/functional-currency accounting, taxes/reserves accounting until approved, arbitrary N:M matching, unbounded partial allocation, fuzzy/confidence-based auto-confirmation, automatic write-offs, editable posted ledger history.
- Persisted draft ledger workflows, broad event sourcing, distributed transactions, microservices, Kafka/Redpanda, Kubernetes, Redis/BullMQ, Rust, Python, blockchain.
- Generalized plug-in workflow engines, sophisticated predictive anomaly models, AI in the financial core, optional AI tooling unless justified after controls exist.
- Production deployment, Terraform/cloud resources, performance claims, compliance certifications or production sign-off in Phase 0.

## Phase 0 sign-off boundaries

The simple modular architecture is a viable design candidate. Approval should be conditional on the open domain policies and executable gates above. Financial integrity, coverage and operational recoverability remain **unproven until implemented and tested**. This documentation does not represent approval to deploy, move money or process customer data.

Phase 3 was subsequently authorized for ingestion/evidence/completeness only. [Implementation](../phase3/README.md) and [verification](../phase3/verification.md) record its actual boundary. Phase 4 and later gates remain deferred.

Phase 4 was subsequently authorized only for [processor interpretation and settlement expectations](../phase4/README.md). Independent internal authorization and accounting orchestration from the original broader Phase 4 row remain deferred; [ADR-011](adr/011-processor-interpretations.md) records this narrowing. Processor-internal arithmetic/composition controls do not implement Phase 8 reconciliation proof. Phase 5 and later are not authorized.

## Explicitly authorized Phase 5 milestone

The user subsequently authorized bank observations as Phase 5, overriding the numbering/order of the original recommended worker-first sequence. This does not authorize that original worker milestone. Implement only synthetic bank entries, optional statements/stocks, provenance and intrinsic controls. [Bank implementation](../phase5/README.md), [verification](../phase5/verification.md) and [ADR-012](adr/012-bank-observations.md) define the boundary. Phase 6+ matching/reconciliation, exception management, real integrations and durable worker infrastructure remain deferred.

## Authorized Phase 6 scope

Following the explicitly authorized Phase 5 bank evidence milestone, Phase 6 implements exact deterministic 1:1 processor settlement ↔ bank movement reconciliation only. Original recommendations do not authorize workers, N:1 matching, cases or later milestones. [Implementation](../phase6/README.md); [verification](../phase6/verification.md).
