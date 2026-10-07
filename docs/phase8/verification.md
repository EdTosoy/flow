# Phase 8 verification and completion report

**Status: Phase 8 COMPLETE and verified within the documented synthetic scope. Final clean-source frozen offline install and full native `pnpm verify` PASS, exit 0, completed 2026-10-08 (Asia/Manila).** [Implemented semantics](README.md), [ADR-014](../architecture/adr/014-operational-exceptions.md). This scope is synthetic operational management around existing exact 1:1 / complete-declaration N:1 reconciliation; it is not production authorization or later-phase completeness assurance.

## Required report

1. **Files created/modified.** Sixteen created and sixteen modified files; full manifest below. Prior migrations 001–006, financial runtime libraries, Phase 6/7 matching/allocation code and original financial tests are unchanged. Only the integration runner and boundary suite gain new gates.
2. **Dependencies added and why.** No new external dependency or version. Two private workspace modules reuse existing Money, pg 8.23.1 and root Nx/TypeScript/fast-check/tsx tooling. Lockfile adds only workspace importers/links.
3. **Packages/modules.** exception-domain → Money only; exception-postgres → exception-domain + pg. Reviewed SQL composition links immutable reconciliation read/evidence identities. No package dependency between reconciliation and exception domains; no ledger write capability.
4. **Schema changes.** Migration 007 adds exceptions.case_record, event, occurrence and attachment; current_case and operational_metrics views; narrow generation/apply/read functions. Existing audit/outbox add restrictive typed exception-event FKs and preserved union constraint branches. Populated upgrades compare prior histories/current allocation; no old financial row is rewritten.
5. **Terminology.** Case = operational subject; occurrence = exact completed reconciliation outcome/cause; event = attributable versioned workflow decision; resolution = operational disposition; current reconciliation = independent fresh existing allocation. A match candidate remains distinct from proof.
6. **Case identity.** One lifetime `(account mapping, stable reconciliation item)` case in settlement_bank scope. Different processor/bank items can each have a case for one relationship issue. Counts and side-separated exposure disclose this convention.
7. **Creation semantics.** Explicit synchronous generation over completed UNMATCHED/AMBIGUOUS/INELIGIBLE outcomes, plus historical MATCHED outcomes without fresh current successor allocation. Every original outcome and later occurrence remains immutable. Duplicate processing returns existing identity; identical conditions in later runs add auditable evidence without reopening a reviewed conclusion.
8. **Lifecycle.** OPEN → UNDER_REVIEW → AWAITING_EVIDENCE → UNDER_REVIEW; UNDER_REVIEW → RESOLVED; changed unresolved evidence permits RESOLVED → UNDER_REVIEW. SUPERSEDE appends RESOLVED → RESOLVED with existing fresh later proof. Every unlisted transition is illegal; notes/attachments may append after closure, classification/assignment require unresolved state.
9. **Classification.** Explicit deterministic missing/extra movement, amount mismatch, ambiguous match, processor/bank inconsistency, source incompleteness/revision ambiguity, duplicate evidence, unsupported case and invalid current proof. Human TIMING_LATE_ARRIVAL and classification overrides are attributable events; original classification remains in the occurrence.
10. **Exposure.** Existing exact Money magnitude/currency for whole eligible unmatched items or a uniquely supported eligible pair residual. Ambiguous/grouped/ineligible/invalidated or oversized magnitude/residual is null with explicit reason. Negative contributions use exact magnitude. Aggregate NUMERIC strings can exceed BIGINT; currencies and processor/bank sides are never combined.
11. **Resolution.** SOURCE_CORRECTION_REQUIRED, PROCESSOR_FEE_CONFIRMED, TIMING_DIFFERENCE, DUPLICATE_SOURCE_RECORD, ACCEPTED_RISK, ACCOUNTING_ADJUSTMENT_REQUIRED, NOT_RECONCILED, UNSUPPORTED_SOURCE, OTHER and FIXED_AND_VERIFIED have documented meanings/action requirements. All nine nonfinancial reasons are exercised; reason/actor and exact original financial evidence are mandatory.
12. **Resolved versus reconciled.** No exception command updates engine outcomes, creates/releases allocations or posts accounting. FIXED_AND_VERIFIED requires a distinct completed MATCHED outcome whose exact group remains currently allocated and fresh. SUPERSEDE records the same independently verified later evidence for an already resolved case. Original decisions/outcomes stay intact.
13. **Accepted risk.** Valid with UNMATCHED and no allocation. Known value remains in unreconciled and accepted-risk exposure; unknown stays counted unknown. Current proven allocation, not case status, removes value from unreconciled reporting. Exception metrics do not produce a reconciled-value total.
14. **Manual reconciliation.** Explicitly deferred. Current rules have no independent manual-reference approval model. MANUAL_MATCH_APPROVED/force-match is unsupported; no amount/currency/allocation or ambiguity guard is relaxed. Existing cross-run/current allocation regression tests stay active.
15. **Notes/assignment/priority.** Notes append bounded context with actor/time; typed attachments retain immutable evidence rather than uploading files. Assignment is null or a synthetic actor ID with audited changes. Priority/scoring is deferred. UPDATE/DELETE/TRUNCATE cannot erase case/event/occurrence/attachment history.
16. **Aging/SLA.** Creation/event/state-entry/first-review/resolution timestamps support age, state age, review latency, resolution duration and reopened-cycle analysis. Metrics include oldest unresolved age and exact median observed resolution duration. Configurable thresholds, due dates, escalation and reminders are deferred; no scheduler is deployed.
17. **Reopening/supersession.** A previously unseen unresolved condition reopens during explicit generation, or a reviewer cites changed unresolved evidence from a different completed run. Old replay does not reopen. Later fresh proof can explicitly resolve/supersede operations, retaining both original and later conclusions. Source corrections preserve unordered revision ambiguity and immediately invalidate current proof through existing reconciliation reads.
18. **Transactions.** One generation command atomically commits its bounded cases/occurrences/events/audit/intent. Each review, classification, assignment, note, attachment, closure, reopening or supersession is one transaction with companions. Book → sorted source accounts → case locks serialize fresh proof and review changes. No external dual write or financial-state change.
19. **Idempotency.** Database uniqueness for logical case, case/run occurrence, case/version and case/command key; full stored JSONB command comparison rejects conflicts. Human actor/reason are part of meaning; generation retains first actor. outcome: namespace is reserved. Replays return original event version plus independently labeled fresh current proof.
20. **Concurrency.** Eight actual blocked creators converge on one case/creation event/audit/intent. Two observed blocked reviewers, review-versus-resolution, assignment and resolution-versus-new-condition-generation races either commit a legal decision or reject stale/illegal commands. Existing allocation contention remains unchanged. No manual-reconciliation race is claimed because that capability is deferred.
21. **Crash/retry.** Event/audit/outbox failures roll back the complete command; suppressed audit/attachment and orphan cases fail deferred commit guards. Actual backend death before commit leaves no decision and unchanged retry succeeds. Actual successful COMMIT acknowledgement loss is tested for generation and resolution; retries recover one effect. Queued command mutation cannot change serialized meaning; injected 40001/40P01 retry entire unchanged transactions. New actual production deadlocks are not claimed beyond inherited regressions.
22. **Audit/outbox.** Each material decision, evidence observation and note has existing append-only typed audit/intent. Audit captures actor/session principal, previous/new state, reason/policy and exact event reference. Event preserves full reason, structured resolution, class/assignment/command/evidence. Existing 512-character audit reason limit is retained; full reason is in the immutable event. Intent kinds created/resolved/reopened/updated reference exact immutable events; no publisher/consumer/broker.
23. **Database enforcement.** Restrictive FKs, scoped typed attachments, case uniqueness, immutable history/TRUNCATE guards, command/version/transition/field guards, exact cause/exposure validation, fresh-proof resolution guards, companion scope/content checks and deferred complete-case/decision checks. Runtime roles can read and invoke narrow SECURITY DEFINER functions with fixed pg_catalog,pg_temp search paths; base writes, owner privileges, ledger posting and reconciliation writes are denied.
24. **Reconciliation integration.** Uses existing completed outcome/member/candidate/group/current-proof evidence. All scoped financial populations remain untouched. Case cause preserves exact rule/version, provenance, control snapshot, rejected pair/group candidates and selected financial evidence. No exception workflow columns are added to reconciliation outcomes.
25. **Simulator integration.** Only public generated artifacts enter ingestion → existing normalization → processor/bank interpretation → reconciliation → exception generation/review/risk resolution. Full CLI performs the same path. Test-only source-like bank statements/control assertions use existing ingestion, not seeded domain tables. Late arrival, correction, wrong amounts/references and grouped ambiguity remain explicit.
26. **Oracle isolation.** Runtime import/transitive package gates cover fifteen packages. Six additional executable probes deny exception-domain/postgres → oracle, exception → reconciliation/ledger persistence, and reconciliation → exceptions. Only simulator-exceptions verifier reads truth after runtime decisions; normal CLI output contains no private truth/anomaly/expected-match labels. This is repository dependency/artifact isolation, not protection against malicious same-user filesystem access.
27. **Tests added.** Four exception domain unit/property tests, twenty-four real PostgreSQL exception tests, five public simulator/CLI suites; 33 new tests. Existing boundary tests gain six probes. No earlier test is disabled, mocked away or weakened.
28. **Property-trial counts.** 500 state/action allowlist trials seed 70801; 500 accepted-risk/exact Money transport trials seed 70802; 20 real PostgreSQL identity/risk/exposure/idempotency/history trials seed 70803; 20 generated public-pipeline missing-bank/oracle/risk trials seed 70804. 1,040 new configured trials; 12,390 with unchanged earlier phases. Final executed totals: 72 unit/property/boundary tests + 178 real PostgreSQL tests = 250 tests; 12,390 configured property trials. Zero failures/skips.
29. **Concurrency/failure scenarios.** Observed lock waits; duplicate creators and stale reviewers; review versus resolve; assignment and new-condition reopening contention; audit/intent/event failure; suppression/orphan/forgery/immutable/scope/privilege probes; actual backend termination and two lost COMMIT acknowledgements; command mutation and whole-transaction retry. Inherited ledger/source/group allocation/failure gates remain required.
30. **Commands executed.** Instructions/skills/architecture/ADRs/Phase 1–7/source/tree inspection; official PostgreSQL 18 mechanism documentation; pnpm install --offline --lockfile-only; pnpm install --offline --frozen-lockfile; targeted pnpm exec prettier --write; pnpm typecheck; NX_DAEMON=false NX_ISOLATE_PLUGINS=false pnpm lint; focused native pnpm test:integration paths; final clean-source frozen offline install and full native pnpm verify; git diff --check and source/evidence review. Final pnpm format:check, local documentation-link/whitespace validation, git diff --check and SHA-256 source equality against the verified copy also pass.
31. **Verification results.** Final clean-source frozen offline install and complete native pnpm verify PASS, exit 0: format, lint, fifteen uncached builds, strict typecheck, nine library test targets, boundaries, all 178 PostgreSQL tests, migration/upgrade/checksum gates and unchanged Phase 1–7 regressions. All 250 tests and 12,390 configured property trials passed, zero failures/skips. All 127 non-Markdown implementation/configuration files match the tested clean copy by SHA-256; final documentation formatting/link and Git whitespace checks pass. Development failures were repaired rather than waived: PL/pgSQL conditional CASE parsing and a test-only sequence permission gap; sandbox pnpm-store/tsx socket denials used ordinary escalated local verification. No automatic approval rejection occurred and no gate was disabled.
32. **Architecture/ADR changes.** ADR-014 records separate operational ownership, lifetime case identity, versioned immutable decisions, side/currency exposure, operational resolution and explicit later-proof supersession. Overview/model/reconciliation/state/transaction/sequence/index/root status point to implemented Phase 8. No financial invariant or Phase 6/7 rule is changed.
33. **Remaining risks/assumptions.** Trusted synthetic source contracts, offline provisioners and DB owners; synthetic claimed actors require production authorization/two-person policy before real use. Cases concern interpreted reconciliation populations, not unseen obligations/raw records without domain facts. Generation and reopening are explicit synchronous commands; current freshness is independent, and no unattended scheduler is promised. One lifetime subject can accumulate multiple issues. Per-side exposure is not an additive end-to-end discrepancy total. No load/soak/restore/security/production-readiness claim.
34. **Explicit deferrals.** Manual matching/approval/revocation, accounting orchestration, production identity/authorization/two-person control, priority/SLA thresholds/reminders, arbitrary uploads, new raw-record exception scopes, 1:N/N:M/partial allocations, Phase 9 completeness/control-total expansion, workers/publishers/consumers, frontend, real integrations, cloud and AI. No commit, push or deployment.
35. **Acceptance result.** **All 32 acceptance criteria PASS within the documented synthetic operational scope**, including the explicitly conditional deferral of manual matching. The mapping below identifies implementation and executed evidence. No criterion is weakened to equate operations with financial proof. Phase 9 was not started.

## Executed gates

Final clean source: `/tmp/flow-phase8-clean-aqqnq01u`. Verification log: `/tmp/flow-phase8-verify.log`. Node 24.21.0, pnpm 11.27.0, TypeScript 5.9.3, Nx 23.2.1, pg 8.23.1, fast-check 4.10.2 and unchanged pinned PostgreSQL 18.6. NX_DAEMON=false/NX_ISOLATE_PLUGINS=false permit local execution without disabling gates. The clean copy excludes Git, dependency/cache/output/build-info and credential/environment directories. Frozen install reused all 408 packages with zero downloads.

| Gate                                               | Result                                                         |
| -------------------------------------------------- | -------------------------------------------------------------- |
| Frozen offline clean install                       | PASS, exit 0                                                   |
| Format/lint/import boundaries                      | PASS in final clean run, fifteen-package closure               |
| Build/typecheck                                    | PASS in final clean run, fifteen uncached builds               |
| Unit/property/boundary                             | PASS in final clean run                                        |
| Empty/repeated/checksum migrations                 | PASS in final disposable runner                                |
| Populated Phase 7→8 upgrade                        | PASS, prior evidence/current allocation/audit/intent preserved |
| Full PostgreSQL and Phase 1–7 regressions          | PASS                                                           |
| Final implementation equality/doc links/whitespace | PASS                                                           |

Focused development runs passed the first seven tests, then nineteen tests, then twenty-seven of twenty-eight tests. The last failure was an ungranted test-only retry sequence; the fixed sequence, all twenty-four final exception PostgreSQL tests, all five final simulator-exception suites and every earlier regression passed in the completed final clean run. No failed run is described as successful.

## Acceptance mapping

| Criteria | Implemented and executed evidence                                                                                     |
| -------- | --------------------------------------------------------------------------------------------------------------------- |
| 1        | Separate packages/schema and enforced dependency/capability directions                                                |
| 2–4      | Completed-outcome cause rules, stable mapping/item uniqueness, immutable original/later outcome links and candidates  |
| 5–6, 14  | Explicit guarded immutable decision chain, no deletion/mutation, append-only notes/typed evidence                     |
| 7–10     | Structured resolution reasons; no financial writes; risk remains unreconciled exposure; fresh existing proof only     |
| 11–13    | Audited class changes, exact Money/NUMERIC/currency/side reporting, explicit unknown/out-of-range exposure            |
| 15–16    | Audited synthetic assignment; priority deferred; measurable state/review/resolution ages                              |
| 17–18    | Original evidence preserved; changed-condition reopen and explicit verified later-run supersession                    |
| 19–21    | Observed blocked creators/reviewers, legal versioned transitions, full-key conflict and duplicate-resolution recovery |
| 22–23    | Manual matching explicitly deferred; existing allocation barriers untouched and capability denied                     |
| 24–26    | PostgreSQL guards/FKs/uniqueness/deferred completeness plus atomic existing audit/outbox                              |
| 27–28    | Import/manifest probes and test-only oracle evaluator; public pipeline and CLI                                        |
| 29       | PASS: full native clean-source Phase 1–7 regressions                                                                  |
| 30–32    | Scope/source review: no UI, AI or Phase 9 control expansion                                                           |

## File manifest

Created:

- `database/migrations/007_exceptions.sql`
- `docs/architecture/adr/014-operational-exceptions.md`
- `docs/phase8/README.md`
- `docs/phase8/verification.md`
- `libs/exception-domain/package.json`
- `libs/exception-domain/project.json`
- `libs/exception-domain/src/index.ts`
- `libs/exception-domain/test/index.test.ts`
- `libs/exception-domain/tsconfig.json`
- `libs/exception-postgres/package.json`
- `libs/exception-postgres/project.json`
- `libs/exception-postgres/src/index.ts`
- `libs/exception-postgres/tsconfig.json`
- `tests/exceptions.integration.test.ts`
- `tests/simulator-exceptions.integration.test.ts`
- `tools/exceptions.ts`

Modified:

- `AGENTS.md`
- `README.md`
- `docs/architecture/README.md`
- `docs/architecture/adr/README.md`
- `docs/architecture/data-model.md`
- `docs/architecture/implementation-sequence.md`
- `docs/architecture/reconciliation.md`
- `docs/architecture/state-machines.md`
- `docs/architecture/transactions-and-outbox.md`
- `eslint.config.mjs`
- `package.json`
- `pnpm-lock.yaml`
- `tests/simulator-boundaries.test.ts`
- `tools/test-postgres.ts`
- `tsconfig.base.json`
- `tsconfig.json`
