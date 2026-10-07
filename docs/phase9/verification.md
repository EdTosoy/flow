# Phase 9 verification and completion report

Status: **COMPLETE AND VERIFIED** within the documented synthetic evidence boundary. Final clean frozen offline install and native `pnpm verify` passed with exit 0 on 2026-10-08. This is implementation acceptance, not a claim that unavailable external completeness evidence is proven. [Semantics](README.md), [ADR-015](../architecture/adr/015-versioned-financial-controls.md).

## Required report

1. **Files.** New control-domain/control-postgres packages, migration 008, PostgreSQL/public-simulator tests, controls CLI, Phase 9 docs and ADR-015. Modified workspace configuration/lockfile, native integration runner, boundary probes, current status and architecture documents. Final manifest below.
2. **Dependencies.** No new external dependency/version; existing Money, pg, fast-check, Nx/TypeScript/tsx tooling.
3. **Modules.** Pure control-domain → Money; control-postgres → control-domain + pg. Reviewed SQL coordinator reads existing domain controls, with no lower-domain imports or financial mutations.
4. **Schema.** controls.version/run/input/result/case_link; typed input FKs, exact NUMERIC quantities; typed completion audit/outbox FKs. Migration 001–007 contents unchanged.
5. **Taxonomy.** Source/period, processing partition/completion, processor/bank derivation coverage, intrinsic controls/totals, reconciliation partition/selection, allocation, ledger, exposure, freshness/aging.
6. **Scope.** One book's received snapshot; explicit account/batch/version/statement/journal/group/run/side/currency, retained source environment and windows. One explicitly selected run per mapping for exposure.
7. **Source completeness.** Reuse independent Phase 3 count/sequence assertions; missing expectation UNKNOWN; missing records FAIL; account-period closure remains UNKNOWN.
8. **Processing completeness.** Per batch/requested version raw = normalized + failed + pending. Missing dispositions fail partition; failed normalization FAIL and pending UNKNOWN remain visible separately.
9. **Processor controls.** Existing frozen complete member/payment/refund/currency/revision/sign/net calculations; normalized-to-domain coverage independent.
10. **Bank controls.** Existing distinct membership/count/reference/sequence/source controls and independent stocks; no statement/stocks means UNKNOWN total.
11. **Reconciliation completeness.** Every historical run/side independently compares manifest, actual members and outcome partition. Incomplete UNKNOWN; missing completed outcomes FAIL.
12. **Ledger integrity.** Canonical journal/entry debit-credit equality, cardinality, posted state, book/currency; separate exact values; no new balance projection.
13. **Equations.** Processor calculated complete component net versus reported net; bank opening + credits − debits versus reported closing; journal debit versus credit. Discrepancy = observed − expected.
14. **Exposure.** Stable selected financial items with fresh allocations excluded; whole unmatched magnitude or unique pair residual; ambiguous/ineligible/oversized/stale aggregate unknown.
15. **Double count prevention.** No case/outcome addition, no historical-run summation, both ends of exact mismatch counted once. Unproven cross-side overlap has separate subtotals and unknown aggregate.
16. **Accepted risk.** Immutable case events annotate the canonical component; risk remains a subset of unreconciled value, unknown risk separately counted; no reconciled-value metric or allocation write.
17. **Statuses.** PASS/FAIL/UNKNOWN first-class with named severity and quantity unit. Missing evidence never PASS. Overall stale/incomplete/unknown result cannot be green.
18. **History/version.** financial-controls-v1 + canonical configuration + complete frozen inputs; immutable completed historical evaluations/results. Current evidence/freshness is a separate read.
19. **Exceptions.** Optional named relevant failed controls generate/associate Phase 8 mapped cases through existing lifetime identity; immutable result/case uniqueness. No fabricated source/raw/ledger financial subject.
20. **Transactions.** Create; REPEATABLE READ freeze; bounded atomic result batches; complete with optional cases/links/audit/intent. Completion requires every required result.
21. **Idempotency.** Book/key full command comparison, run/key result uniqueness and case-link uniqueness; same stages resume or replay with no additional companions.
22. **Concurrency.** Book → sorted sources → run, existing case locks. Observed contention for duplicate/control cases, source arrival, reviewer risk and reconciliation completion; coherent snapshots.
23. **Crash/retry.** Durable incomplete stages; injected freeze/result/companion/link failures, backend death before commit, successful COMMIT-ack loss and unchanged retries. Whole 40001/40P01 stage retries bounded at five attempts, with queued payload immutability tested.
24. **Audit/outbox.** Existing append-only completion event records actor/principal/version/state/reason/run. Typed controls.completed intent, optional generation's existing companions in same transaction. No delivery infrastructure.
25. **Database enforcement.** Restrictive FKs, full command/policy identity, immutable registry/inputs/results/links/completed run, legal transitions, exact quantities, snapshot/result forgery guards, deferred population/completion/companion checks; narrow runtime roles.
26. **Simulator.** Public generation → ingestion → normalization → processor/bank → reconciliation → exceptions/controls, plus CLI. Oracle consulted only by test evaluator afterward.
27. **Oracle isolation.** Runtime package/import/transitive gates, five new explicit Nx denial probes, private labels absent from normal CLI. Same-user filesystem is not an adversarial security boundary.
28. **Tests.** Five pure property/unit tests, twenty-seven real PostgreSQL controls tests and six public simulator/CLI suites; original tests/gates remain enabled. Derivation coverage includes supported movement-v2 without changing the pinned Phase 4 intrinsic monetary policy.
29. **Property trials.** Three 1,000-trial properties (seeds 70901–70903), 20 real PostgreSQL (70904), 20 public simulator (70905): 3,040 new configured trials, 15,430 including Phase 1–8. Final executed totals: 77 unit/property/boundary tests + 211 PostgreSQL tests = 288 tests, including 38 new tests; zero failures/skips.
30. **False green.** Independent 10,000 expected versus 9,998 normalized raw records; separate bank stock mismatch while all historical individual matches remain valid.
31. **Commands.** Instruction/skill/architecture/implementation inspection; pinned PostgreSQL official documentation; offline lockfile/frozen install; native formatting, focused typecheck/lint/unit/integration; final clean install/full pnpm verify; Git whitespace/protected-file/evidence review.
32. **Verification.** PASS: clean frozen offline install and complete native `pnpm verify`, exit 0. Format, lint, 17 uncached builds, strict typecheck, 10 library test targets, boundaries, all 211 real PostgreSQL tests and populated/empty migration checks passed. Phase 1–8 regressions remain green. All 288 tests and 15,430 configured property trials passed with zero failures/skips. Final root format/new ADR checks, six local documentation links, Git whitespace/protected-file review and SHA-256 equality for all 140 non-Markdown source/configuration files against the tested copy passed. Development failures were repaired, never waived or labeled pre-existing without evidence.
33. **Architecture.** ADR-015 explains separate control coordinator, immutable snapshots, explicit unknown completeness and canonical exposure. Current architecture/status references updated; no earlier invariant weakened.
34. **Risks.** Trusted synthetic assertions/actors/provisioners/admin; absent independent period closure and business authorization; bounded all-received snapshots, source-account serialization, no production load/security/restore claim. Historical selected run can become stale and requires explicit reevaluation.
35. **Deferred.** Generic control/raw-subject cases, independent account-period closure, comprehensive accounting-position/projections/manual/FX/production authorization, streaming/scaling; Phase 10 workers, publication, UI, real integrations, cloud, AI. No commit/push/deployment.
36. **Acceptance.** All 32 requested criteria PASS within the documented synthetic evidence boundary, with evidence below. Missing independent expectations remain UNKNOWN, and mapped-case integration follows the explicit policy; no broader completeness/proof claim is made. No Phase 10 work began.

## File manifest

New files (16):

- `database/migrations/008_financial_controls.sql`
- `libs/control-domain/package.json`, `project.json`, `tsconfig.json`, `src/index.ts`, `test/index.test.ts`
- `libs/control-postgres/package.json`, `project.json`, `tsconfig.json`, `src/index.ts`
- `tests/controls.integration.test.ts`, `tests/simulator-controls.integration.test.ts`
- `tools/controls.ts`
- `docs/phase9/README.md`, `docs/phase9/verification.md`
- `docs/architecture/adr/015-versioned-financial-controls.md`

Modified files (17):

- `AGENTS.md`, `README.md`
- `docs/architecture/README.md`, `adr/README.md`, `data-model.md`, `implementation-sequence.md`, `invariants.md`, `reconciliation.md`, `state-machines.md`, `transactions-and-outbox.md`
- `eslint.config.mjs`, `package.json`, `pnpm-lock.yaml`, `tsconfig.base.json`, `tsconfig.json`
- `tests/simulator-boundaries.test.ts`, `tools/test-postgres.ts`

Prior migrations 001–007, financial domain/adapters and existing financial test assertions are unchanged. The integration runner adds migration/capability/test coverage; oracle probes extend the original boundary suite.

## Commands and verification record

Repository-native commands executed during development and final verification:

```sh
pnpm install --offline --lockfile-only
pnpm install --offline --frozen-lockfile
pnpm exec prettier --write tests/controls.integration.test.ts docs/phase9/README.md docs/phase9/verification.md
pnpm typecheck
NX_DAEMON=false NX_ISOLATE_PLUGINS=false pnpm test:integration tests/controls.integration.test.ts
NX_DAEMON=false NX_ISOLATE_PLUGINS=false pnpm test:integration tests/controls.integration.test.ts tests/simulator-controls.integration.test.ts
NX_DAEMON=false NX_ISOLATE_PLUGINS=false pnpm verify
pnpm format:check
pnpm exec prettier --check docs/architecture/adr/015-versioned-financial-controls.md
git diff --check
```

The final clean copy is `/tmp/flow-phase9-complete-vkaa7f__`, with evidence in `/tmp/flow-phase9-complete.log`. Clean copies omit generated outputs, installed dependencies, Git metadata, private agent mounts and local credentials. The same frozen lockfile installs offline; native format/lint/build/typecheck/unit/boundary/integration gates are retained. No financial gate is skipped. Workspace daemon private mounts prevented a root globbed lint read, so the complete native gate runs on the clean source copy rather than changing its rules.

Development failures were corrected: a PL/pgSQL variable collision, malformed synthetic IDs, a test lock-order/cleanup error and an unsupported anomaly fixture name. Two intermediate full runs correctly failed the original ledger sweep because the new administrator-corruption test had committed its deliberately invalid journal. The final test injects missing outcomes/bad allocation/unbalanced entries inside a rollback-only transaction; it also verifies the original rows survive. The original ledger assertion is unchanged. No failed run is claimed as successful, no failure is dismissed as pre-existing, and no automatic approval rejection occurred.

The next complete clean run passed 77 unit/property/boundary tests and all 210 PostgreSQL tests, with zero failures/skips. Final review then added an explicit UNKNOWN and regression test for an empty book with no configured sources; the final clean run passed all 288 tests, including this additional case. Empty internal ledger/allocation checks cannot prove external completeness.

## Acceptance evidence

All 32 implementation acceptance criteria PASS. The following maps each to implementation and executed verification; a control intentionally reporting FAIL or UNKNOWN in a test is successful detection, not a failed acceptance criterion.

| Criterion                         | Evidence                                                                                                                           |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 1. Explicit statuses              | Versioned SQL evaluator and pure exact-total tests preserve PASS/FAIL/UNKNOWN.                                                     |
| 2. Explicit scope                 | Typed frozen inputs retain book/account/batch/version/run/side/currency; foreign-book selection rejected.                          |
| 3. Source completeness            | Independent dropped-record test FAIL; valid manifest PASS; missing account-period closure or an unconfigured empty book UNKNOWN.   |
| 4. Processing coverage            | Raw/disposition partition plus separate backlog/failure control; missing domain derivations detectable.                            |
| 5. Processor controls             | Existing settlement snapshot/member controls and exact total retained; public incorrect amount/missing activity detector.          |
| 6. Bank controls                  | Existing statement controls, count/sequence evidence and independent closing stocks surfaced.                                      |
| 7. Run coverage                   | Manifest/member/outcome counts independently compared; rollback-only missing-outcome injection detected.                           |
| 8. Allocation controls            | Canonical uniqueness, member/contribution/currency/conservation/freshness checks; rollback-only bad allocation detected.           |
| 9. Ledger integrity               | Exact journal debit/credit counts and values; rollback-only unbalanced entries detected; original ledger sweep retained.           |
| 10. Exact totals                  | Money components and exact NUMERIC/BigInt totals including values above safe Number range.                                         |
| 11. Currency isolation            | Typed currency scopes and rejection of mixed-currency subtraction; separate PHP/USD ledger controls.                               |
| 12. Expected/observed distinction | Immutable expected, observed and observed-minus-expected columns and evidence.                                                     |
| 13. No exposure duplication       | Selected population only; no case addition; one exact pair residual; unproven cross-side overlap UNKNOWN.                          |
| 14. Accepted risk                 | Risk annotates unreconciled components; concurrent risk/freeze test and simulator risk test create no allocation.                  |
| 15. Reproducible evidence         | Complete immutable input payload/hash, typed FKs, source checksums, revision/member/candidate/event identities.                    |
| 16. Versioned logic               | Immutable financial-controls-v1 registry and canonical command/configuration.                                                      |
| 17. Immutable history             | Database rejects UPDATE/DELETE/TRUNCATE/forged results; late arrivals/corrections preserve old history.                            |
| 18. UNKNOWN preserved             | Unknown source closure, incomplete runs, absent balances, ambiguity and exposure nulls tested.                                     |
| 19. Exception integration         | Explicit named FAIL policy associates existing mapped Phase 8 cases; irrelevant/UNKNOWN controls do not fabricate cases.           |
| 20. Idempotency                   | Same semantic command/stages replay one run/result/companion; conflicting reuse rejected.                                          |
| 21. Concurrent execution          | Eight observed blocked duplicate commands and competing histories retain one logical case.                                         |
| 22. Frozen-input races            | Source arrival, reconciliation completion and accepted-risk resolution produce coherent as-of snapshots.                           |
| 23. Crash/retry                   | Durable incomplete stages, freeze/result/companion failures, backend death and actual COMMIT acknowledgement loss recover.         |
| 24. PostgreSQL enforcement        | Restrictive FKs, exact quantities, legal transitions, immutable history, snapshot/result guards, deferred completeness/companions. |
| 25. Oracle isolation              | Seventeen-package dependency gate and five additional Nx denial probes; public CLI contains no oracle labels.                      |
| 26. Missing-source false green    | 10,000 independently expected versus 9,998 fully normalized still FAIL.                                                            |
| 27. Aggregate disagreement        | Independent bank closing mismatch FAIL while individual reconciliation matches remain valid.                                       |
| 28. Count properties              | 1,000 pure partition trials plus 20 real database trials.                                                                          |
| 29. Phase 1–8 regressions         | All unchanged Phase 1–8 native suites and populated upgrade history checks PASS in the final clean run.                            |
| 30. No workers                    | Only durable synchronous commands/outbox intent; no publisher/consumer infrastructure.                                             |
| 31. No frontend                   | CLI and typed summary only.                                                                                                        |
| 32. No AI                         | Deterministic named control policy; no AI dependencies or runtime.                                                                 |

## Mechanism references

Reviewed against installed PostgreSQL 18: [REPEATABLE READ snapshots](https://www.postgresql.org/docs/18/transaction-iso.html), [stable function evidence](https://www.postgresql.org/docs/18/xfunc-volatility.html), [deferred constraint triggers](https://www.postgresql.org/docs/18/sql-createtrigger.html). These support mechanism choices, not production financial policy approval.
