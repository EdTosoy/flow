# Phase 6 verification and completion report

Status: **COMPLETE and verified for the documented synthetic Phase 6 scope.** Final frozen clean install and full native verification PASS, exit 0. Implementation remains Phase 6 only. Historical results and current assurance are distinct; no Phase 7 work is included. [Semantics](README.md), [ADR-013](../architecture/adr/013-exact-reconciliation.md).

## Required report

1. **Files created/modified.** Created migration 005; reconciliation-domain package/project/tsconfig/source/unit-property test; reconciliation-postgres package/project/tsconfig/adapter; reconciliation fixture helper and two integration suites; reconciliation CLI; Phase 6 README/report and ADR-013. Modified AGENTS/README, architecture overview/model/invariant/state/transaction/sequence/ADR index, root package/lockfile/TS references/paths/ESLint, oracle-boundary probes and disposable PostgreSQL runner. Migrations 001–004, all Phase 1–5 runtime libraries, simulator generator/golden outputs and prior financial tests remain unchanged.
2. **Dependencies added and why.** Two private workspace modules only. Reuse Money, ingestion validation, pg and existing root fast-check/tsx/Nx tooling; no new external dependency or version. Lockfile adds workspace links. No queue, framework or infrastructure dependency.
3. **Package/module structure.** reconciliation-domain → money + ingestion-domain; reconciliation-postgres → reconciliation-domain + pg. SQL owns final proof/allocation enforcement. CLI composes public ingestion/processor/bank capabilities using separate pools; lower domains do not depend on reconciliation.
4. **Schema changes.** Twelve reconciliation tables: rule_version, account_mapping, item, run, run_member, candidate, outcome_plan, match_group, match_group_member, outcome, allocation_decision, current_allocation. Three views: current_group, active_allocation, operational_metrics. Existing audit/outbox gain restrictive typed reconciliation references and reviewed resource/action branches while retaining all previous histories/guards.
5. **Reconciliation terminology.** MATCHED is a historical exact correspondence/conservation proof over frozen evidence under a named rule. Current reconciled assurance additionally requires fresh valid allocation. Candidate is a reference-based evaluation edge, not proof. Source completeness and ledger truth remain independent.
6. **Scope model.** Explicit immutable synthetic reference-contract mapping, book/environment/provider/source/account/currency, half-open UTC report/booking window and effective-time metadata. One processor source per bank source/currency and vice versa in this milestone. Unknown mapping rejects the command before comparing unrelated accounts. Currency outsiders belong to a separate scope.
7. **Run/population model.** Semantic mapping/run key freezes rule/configuration; separate DRAFT/SEALED/RUNNING/COMPLETED stages. REPEATABLE READ captures actual scoped domain source identities, all relevant historical variants, selected evidence/version IDs, controls, counts and population SHA-256. Source-ambiguous and observation-only inputs stay in the denominator. Bound is 2,000 items; oversized runs fail rather than truncate. Raw/failed normalization without a domain fact remains explicitly separate Phase 3 coverage.
8. **Eligibility model.** Identified unambiguous version-pinned evidence; valid supported scope/type/money/reference; no relevant intrinsic control failure or proven incomplete required acquisition. No source-token/timestamp/receipt-order ranking. Reasons remain in immutable members and outcomes. Unknown completeness is never called proven complete.
9. **Candidate model.** Exact source reference/currency with deterministic temporal plausibility; any historical variant can expose competing references without being selected. Persist exact amount/direction/control checks separately. Wrong-amount or ineligible reference collisions cannot be silently ignored to choose a convenient winner. No amount-only/fuzzy candidate can confirm.
10. **Accepted-match rule.** settlement-bank-exact-v1 requires mapped scope, exact currency/signed expected net and independently reported processor net, compatible bank CREDIT/DEBIT, exact reference, booked timestamp within inclusive report…report+72 elapsed UTC hours, clear controls and one candidate at both ends. Zero settlement has no movement match. No tolerance, scoring or row-order tie breaking.
11. **Evidence model.** Named exact checks, source-contract mapping/rule, typed selected processor/bank IDs, full frozen component/payment/bank controls, amount/currency/reference, report/booking/value dates, provenance versions, mutual uniqueness and population hash. Exact normalized interpretation → basis receipt/revision → original bytes remains traversable.
12. **Match-group/allocation model.** Immutable typed groups/members with exact whole signed contributions. Phase 6 guards enforce one settlement and one movement, equal currency/amount and membership in the proof's exact pair. Group/member representation permits later reviewed grouped rules; none is implemented. Stable economic source-fact identity prevents alternate versions/facets from bypassing allocation uniqueness across runs.
13. **Run outcome model.** MATCHED/UNMATCHED/AMBIGUOUS/INELIGIBLE, one immutable plan and durable outcome per frozen item. Counts partition both sides. Completion checks the complete plan/member/outcome population and required companions. Unknown monetary value has an explicit unknownValueCount; it never becomes zero.
14. **Rule/version strategy.** Immutable explicit v1 registry/contract, pinned processor-v1/movement-v1/settlement-v1 and bank-v1/entry-v1/statement-v1 policy. Configuration conflicts on reused run key reject. Same frozen evidence/config/rule gives the same historical classifications; replay keeps original IDs/results. Changed logic requires a new implemented/registered rule and run, with historical source/lockfile retained.
15. **Historical/current semantics.** Immutable completed runs/groups remain as-of conclusions. ACTIVE current proof is exposed separately; read-time freshness can show INVALIDATED immediately. Subsequent controlled runs append retirement/supersession decisions with successor links. Reconfirmation of the same pair replaces its reservation atomically. Stale frozen matches have STALE activation; occupied-resource activation has defensive CONFLICT semantics. Completed replay cannot restore old allocations.
16. **Correction/revision behavior.** Original raw/domain/run histories remain intact. New unordered revisions make source selection ambiguous and current proof invalid, even before a new derivation succeeds. New runs retain ambiguity as ineligibility. No latest-receipt supersession, automatic history rewrite or blind preservation of current match.
17. **Processor/bank control gating.** Fresh processor component/payment controls all block on failure; bank statement failures block associated entries, including report/line ambiguity, count/list/sequence/currency/order/balance/conflict controls. Missing declared statement report blocks. Unrelated statement failures do not block bare booked entries. Required acquisition incompleteness is captured for report/components/bank/associated statements. Period source coverage remains UNKNOWN.
18. **Transaction boundaries.** Separate short creation, REPEATABLE READ seal, deterministic plan, bounded result progress and completion commits. Current writes lock book with NO KEY UPDATE, sorted source accounts and run; compatible book FK readers avoid an unnecessary lock cycle. Group/members/outcomes/allocation/decision/audit/outbox are atomic. Source evidence survives any later-stage rollback. Completion cannot precede durable coverage.
19. **Idempotency.** Unique mapping/run key with full canonical configuration comparison; stable source-fact item uniqueness; unique semantic pair and one group per run item; immutable candidate/plan/outcome keys; unique initial/terminal decisions and typed audit/outbox. Actor is excluded from semantic identity while original actor remains attributable. Whole-stage retries keep unchanged identity.
20. **Concurrency behavior.** Twelve sessions proven blocked in pg_stat_activity converge on duplicate run and candidate work. Competing banks/processors remain ambiguous without allocation. Overlapping new/historical runs preserve old bytes and reserve each item once. A correction and acceptance reach two observed source lock waits; either commit order preserves history and removes current assurance. Unique keys/guarded commands are final barriers.
21. **Crash/retry behavior.** Durable DRAFT/SEALED/RUNNING stages resume; partial progress remains discoverable. Injected failures in population/candidate/plan/group/member/outcome/decision/allocation/audit/intent/completion roll back their stage. Actual backend termination inside match creation leaves no proof/allocation. Actual successful COMMIT-acknowledgement loss is tested at all five stages; recovery returns one result. 40001/40P01 injection retries whole original stages, without claiming those injections are observed production deadlocks.
22. **Audit/outbox behavior.** Accepted historical groups require initial ACTIVE/STALE/CONFLICT decision with typed audit and existing-outbox intent. Retirement/supersession requires linked audited decision and intent in the allocation transaction. Audit identifies actor, actual DB principal, run/rule/group/full evidence. Completion has one typed intent. Candidate/non-match detail stays operational evidence. No broker/publisher/consumer is introduced.
23. **Database constraints/functions/triggers.** Restrictive scope/provenance/version FKs, origin-kind registration, sealed transaction identities, exact snapshot/candidate/plan/proof guards, role/amount/currency/exact-counterpart enforcement, immutable history/truncate guards, allocation uniqueness and audited-release rules, deferred group/decision/run completeness. Separate non-owner capability roles execute six stage commands and read summaries; runtime cannot post ledger, derive source domains, mutate tables or become owner. SECURITY DEFINER paths are fixed to pg_catalog,pg_temp.
24. **Simulator pipeline integration.** Public simulator artifacts → Phase 3 raw acquisition/explicit normalization → processor/bank derivation → Phase 6. Source-like adversarial fixtures use that same path. No direct domain-table seeding in primary integration. CLI invokes established public pipelines with a provisioned mapping and prints separate domain/reconciliation summaries.
25. **Oracle-isolation evidence.** Thirteen-package import/transitive boundary checks; five added denial probes for reconciliation→oracle/ledger and lower money/bank→reconciliation. Existing probes remain active. Only the independent named simulator verifier sees oracle after runtime decisions. Same-user filesystem access is not an OS sandbox; future hosts must exclude private artifacts/packages.
26. **Tests added.** Four domain unit/property tests, twenty-nine real PostgreSQL reconciliation tests and three public simulator/CLI tests: 36 new tests. Existing boundary suite gains five probes. Final complete-suite total is **190 tests: 60 unit/property/boundary + 130 PostgreSQL**, with zero failures/skips.
27. **Property trials.** 500 exact signed conservation/currency trials seed 70601; 500 ambiguity/permutation/identity trials 70602; 500 deterministic unique-population trials 70603; 20 real PostgreSQL exact replay/history trials 70604; 20 full public pipeline/oracle-evaluator trials 70605. 1,540 new trials per full suite; 10,310 including unchanged Phase 1–5 properties.
28. **Concurrency/failure scenarios.** Same command, same candidate, both directions of competing counterpart, overlapping runs, synchronized correction/acceptance; all stage failure companions, partial recovery, backend kill, five actual COMMIT-ack drops, transient retry, forged/late/mutable/unaudited population/proof/allocation/completion denial. REPEATABLE READ excludes a bank entry committed after snapshot establishment and stale proof never activates.
29. **Exact-match/ambiguity scenarios.** Successful credit/debit and very large exact values; missing/extra bank; one-to-two/two-to-one candidates; amount/currency/reference/direction/window mismatch; late receipt; processor/bank correction and unordered revision; processor composition/bank statement failures; unrelated bank statement; no-ID bank evidence; proven incomplete required acquisition; wrong equal-amount member with its own valid plan.
30. **Commands executed.** Instruction/skill/architecture/ADR/Phase 1–5/source/test/tree reads; official PostgreSQL 18 references; git status/diff/diff --check; pnpm install --offline --lockfile-only; frozen offline install; targeted pnpm exec prettier --write; pnpm typecheck; pnpm lint; pnpm test:unit; pnpm test:integration; focused pnpm exec tsx tools/test-postgres.ts with explicit Phase 6 test paths; clean-source pnpm verify. Native verify runs format:check, lint/oracle checks, build, typecheck, unit/property/boundary and full real PostgreSQL integration/migrations. No standalone production migration, commit, push or deployment.
31. **Verification results.** Final clean-source frozen offline install and complete `pnpm verify` **PASS, exit 0**, in `/tmp/flow-phase6-final-NZx300`: formatting, zero-warning lint/oracle checks, thirteen uncached builds, strict typecheck, eight unit/property targets plus boundary tests, all 130 PostgreSQL tests, empty/repeated/hash migration checks and populated Phase 1–5 preservation. No implementation changed after this run. Development unit/lint/typecheck and then-current 31 focused PostgreSQL tests passed. First clean-copy verify passed formatting/lint, thirteen builds, typecheck and all unit/property/boundary targets, then 129/130 PostgreSQL tests; the sole failure was a test-only selector that chose its adversarial bank member by random returned UUID order. It now selects the explicit wrong reference. The financial implementation was unchanged; the corrected fixture and all 130 tests pass in the final full run.
32. **Architecture/ADR changes.** ADR-013 defines exact synthetic reference proof, frozen/current split, staged recovery, read-time invalidation and audited durable retirement. Architecture overview/model/invariants/state/transactions/sequence/index and root docs reflect this authorized 1:1 slice. No invariant is relaxed; original Phase 1–5 verification documents remain historical and unchanged.
33. **Remaining risks/assumptions.** Trusted synthetic source identities/reference contracts/independent assertions and offline mapping provisioners; no authenticated production-source assurance or end-user approval product. No authoritative revision order. Source period closure remains unknown. Whole-item bounded in-memory populations and book/source serialization are not throughput/soak claims; current validation recomputes evidence rather than trusting a stale cache. Defensive activation conflict semantics do not substitute for conservative frozen graph ambiguity. No production security/retention/restore/readiness claim.
34. **Explicitly deferred.** Phase 7+ N:1/1:N/N:M and partial allocation; fuzzy/tolerance/ML/AI; manual review/exception/SLA workflows; production account mappings/reference contracts/source ordering/calendars/real integrations; ledger/payment orchestration; workers/leases/publishers/consumers/brokers; frontend/cloud; streaming/scale/production readiness. No commit/push/deployment.
35. **Acceptance-criteria result.** **All 31 acceptance criteria PASS within the documented synthetic scope.** The evidence mapping below defines every required criterion without weakening financial truth, ambiguity, allocation, history or oracle boundaries.

## Executed gates

Final source copy `/tmp/flow-phase6-final-NZx300`: frozen offline install then `pnpm verify` PASS, exit 0. Node 24.21.0, pnpm 11.27.0, Nx 23.2.1, TypeScript 5.9.3, pg 8.23.1, fast-check 4.10.2 and unchanged pinned PostgreSQL 18.6. Full PostgreSQL run: 130 passed, zero failures/skips, about 309 seconds. All 190 tests and 10,310 configured property trials passed. The runner stopped its own disposable container; no persistent database was reset. Earlier development migration assembly and PL/pgSQL name ambiguities, fixture typing/role/constraint assumptions and the later UUID-order fixture selector were repaired; no failure is labeled pre-existing and no check is disabled. Clean-copy installation reused all 408 packages with zero downloads. NX_DAEMON=false and NX_ISOLATE_PLUGINS=false only accommodate local execution; all gates remain active.

| Gate                                                 | Result                                                                                                      |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Clean frozen offline install                         | PASS: 408 packages reused, zero downloads                                                                   |
| Final full native pnpm verify                        | PASS, exit 0                                                                                                |
| Format/lint/build/typecheck                          | PASS: zero warnings, thirteen uncached builds                                                               |
| Unit/property/oracle boundary                        | PASS: eight library targets + four boundary tests; 60 total                                                 |
| PostgreSQL integration                               | PASS: 130 tests, zero failures/skips                                                                        |
| Migration preservation/hash checks                   | PASS: populated ledger/ingestion/processor/bank histories unchanged, repeated migration and drift detection |
| Full public pipeline/replay/evaluator/CLI            | PASS: 20 generated trials plus anomalies and deterministic CLI replay                                       |
| Concurrency/failure/revision safeguards              | PASS: observed contention, staged recovery, actual backend death and five COMMIT-ack losses                 |
| Verified implementation equality                     | PASS: all 107 non-Markdown source/configuration files match final clean copy by SHA-256                     |
| Final docs/links/whitespace                          | PASS: final format:check, 53 local links and fenced blocks, git diff --check                                |
| Protected existing runtime/migration/generator scope | PASS: source diff empty for all Phase 1–5 libraries and migrations 001–004                                  |

## Acceptance mapping

| #   | Criterion                            | Evidence                                                                                                  |
| --- | ------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| 1   | Precise reconciliation meaning       | Exact synthetic contract, historical MATCHED versus fresh current allocation                              |
| 2   | Candidates separate from matches     | Immutable candidate checks allocate nothing; guarded group creation                                       |
| 3   | Explicit scope                       | Book/source/account/currency mapping and half-open UTC window; cross-scope rejection                      |
| 4   | Frozen immutable runs                | REPEATABLE READ manifests, typed members, immutable completed state/results                               |
| 5   | Every scoped input has outcome       | Full domain population retained, complete plan/outcome partition per side                                 |
| 6   | Conservative eligibility             | Ambiguous/unidentified/pending/control-failed/incomplete evidence retained as INELIGIBLE                  |
| 7   | Deterministic 1:1 only               | Mutual unique exact graph and guarded two-role group shape                                                |
| 8   | Named proof                          | Exact amount/currency/reference/direction/time/mapping/control evidence                                   |
| 9   | No approximate matching              | One-unit/reference/window mismatch cases; no scoring/tolerance dependency                                 |
| 10  | Ambiguity never arbitrarily resolved | Both candidate directions, 500 trials and observed PostgreSQL contention                                  |
| 11  | Evolvable group representation       | Typed group/member rows and whole economic items; later shapes require reviewed guard evolution           |
| 12  | Exact conservation                   | Signed Money and exact SQL contributions; large values, 500 trials, real DB properties                    |
| 13  | No active double allocation          | Stable source-fact item + global allocation key, exact counterpart guard, cross-run races                 |
| 14  | Historical immutability              | Byte snapshots and runtime/admin update/delete/truncate/late-insert denial                                |
| 15  | Corrections preserve history         | Processor/bank correction, read-time invalidation, new run ineligibility                                  |
| 16  | Rule/version identity                | Explicit registry/config/pinned interpretation policies in run/proof                                      |
| 17  | Explainable accepted evidence        | Typed evidence links, named predicates, full frozen controls and population hash                          |
| 18  | Explicit non-match states            | Durable UNMATCHED/AMBIGUOUS/INELIGIBLE plans/outcomes and reasons                                         |
| 19  | Proven run completeness              | Deferred manifest/plan/outcome/group/companion guards and incomplete completion denial                    |
| 20  | Intrinsic control gating             | Fresh processor/payment and associated bank statement failures; unrelated bank control does not block     |
| 21  | Idempotent run execution             | Canonical identity/conflict, repeat properties and twelve observed lock contenders                        |
| 22  | Concurrent allocation safety         | Candidate workers, competing counterpart directions, historical/new overlap, source correction contention |
| 23  | Crash/retry safety                   | Stage rollback/partial recovery/backend death/five COMMIT-ack losses/full-stage retry                     |
| 24  | Audit/outbox guarantees              | Typed immutable initial/terminal decisions with atomic companions and completion intent                   |
| 25  | PostgreSQL enforcement               | Actual roles, scoped FKs, unique keys, exact proof/sealing/immutability/deferred completeness guards      |
| 26  | Runtime-visible evidence only        | Public artifact/ingestion/normalization/processor/bank integration and no ledger fabrication              |
| 27  | Runtime oracle isolation             | Thirteen-package import/transitive gates and five new denial probes                                       |
| 28  | Test evaluator isolated              | Verifier reads truth only after runtime-visible pipeline decisions; CLI contains no labels                |
| 29  | Phase 1–5 regression green           | PASS: full native suite and populated Phase 1–5 upgrade/history checks                                    |
| 30  | No N:1 matching                      | Strict two-role 1:1 rule; existing processor composition is separate                                      |
| 31  | No exception workflow                | Results/activation decisions only; no case, analyst, SLA or manual-resolution module                      |

PostgreSQL mechanism checks used official version 18 [snapshot isolation](https://www.postgresql.org/docs/18/transaction-iso.html), [stable function snapshots](https://www.postgresql.org/docs/18/xfunc-volatility.html) and [restricted SECURITY DEFINER](https://www.postgresql.org/docs/18/sql-createfunction.html) documentation. Executed tests substantiate the implementation; these references do not confer production approval.

## File manifest

Created:

- [database/migrations/005_reconciliation.sql](../../database/migrations/005_reconciliation.sql)
- [docs/architecture/adr/013-exact-reconciliation.md](../../docs/architecture/adr/013-exact-reconciliation.md)
- [docs/phase6/README.md](../../docs/phase6/README.md)
- [docs/phase6/verification.md](../../docs/phase6/verification.md)
- [libs/reconciliation-domain/package.json](../../libs/reconciliation-domain/package.json)
- [libs/reconciliation-domain/project.json](../../libs/reconciliation-domain/project.json)
- [libs/reconciliation-domain/src/index.ts](../../libs/reconciliation-domain/src/index.ts)
- [libs/reconciliation-domain/test/index.test.ts](../../libs/reconciliation-domain/test/index.test.ts)
- [libs/reconciliation-domain/tsconfig.json](../../libs/reconciliation-domain/tsconfig.json)
- [libs/reconciliation-postgres/package.json](../../libs/reconciliation-postgres/package.json)
- [libs/reconciliation-postgres/project.json](../../libs/reconciliation-postgres/project.json)
- [libs/reconciliation-postgres/src/index.ts](../../libs/reconciliation-postgres/src/index.ts)
- [libs/reconciliation-postgres/tsconfig.json](../../libs/reconciliation-postgres/tsconfig.json)
- [tests/helpers/reconciliation-fixture.ts](../../tests/helpers/reconciliation-fixture.ts)
- [tests/reconciliation.integration.test.ts](../../tests/reconciliation.integration.test.ts)
- [tests/simulator-reconciliation.integration.test.ts](../../tests/simulator-reconciliation.integration.test.ts)
- [tools/reconciliation.ts](../../tools/reconciliation.ts)

Modified:

- [AGENTS.md](../../AGENTS.md)
- [README.md](../../README.md)
- [docs/architecture/README.md](../../docs/architecture/README.md)
- [docs/architecture/adr/README.md](../../docs/architecture/adr/README.md)
- [docs/architecture/data-model.md](../../docs/architecture/data-model.md)
- [docs/architecture/implementation-sequence.md](../../docs/architecture/implementation-sequence.md)
- [docs/architecture/invariants.md](../../docs/architecture/invariants.md)
- [docs/architecture/state-machines.md](../../docs/architecture/state-machines.md)
- [docs/architecture/transactions-and-outbox.md](../../docs/architecture/transactions-and-outbox.md)
- [eslint.config.mjs](../../eslint.config.mjs)
- [package.json](../../package.json)
- [pnpm-lock.yaml](../../pnpm-lock.yaml)
- [tests/simulator-boundaries.test.ts](../../tests/simulator-boundaries.test.ts)
- [tools/test-postgres.ts](../../tools/test-postgres.ts)
- [tsconfig.base.json](../../tsconfig.base.json)
- [tsconfig.json](../../tsconfig.json)
