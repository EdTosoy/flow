# Phase 1 verification record

Date: 2026-10-07. Scope: generic synthetic/test ledger, not production readiness. [Implementation specification](README.md) describes the exact enforced boundary and deferred controls.

## Required reproducible verification

```sh
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm build
pnpm typecheck
pnpm test:unit
pnpm test:integration
```

`pnpm verify` runs the formatting/lint/build/typecheck/unit/integration sequence. Nx build/test cache is skipped; integration is never cached. The integration runner applies the SQL migration to an empty disposable database, applies it again to compare hashes, and tests detection of changed applied history.

The executed results and clean-copy evidence are recorded below. No future/reconciliation tests are counted toward this milestone.

## Test inventory

- Seven money tests, including 1,000 exact arithmetic properties and 1,000 full signed-BIGINT serialization properties (seeds 70101/70102).
- Three ledger-domain tests, including 500 generated balanced/reordered journals (seed 70103).
- Thirty-one real PostgreSQL integration tests, including 50 generated multi-entry journal/replay/reversal trials (seed 70104).
- Real non-superuser writer/reader logins, role/routine grants, immutable table guards, composite scope/currency FKs, positive amount/side constraints and transaction-end posting/companion/reversal guards.
- A caller-created temporary UUID domain attempts to intercept privileged casts; controlled routines must ignore it. Actual SECURITY DEFINER search paths are inspected.
- 100 callers for one command: first posting held uncommitted until 99 competing sessions are observed waiting on DB locks. Fifteen concurrent different command aliases for one effect are separately synchronized.
- Twenty concurrent full reversals, with the original row lock held until 19 competitors are observed blocked. Conflicting same-key posting is also synchronized.
- A genuine two-session multi-command deadlock, victim rollback and unchanged-key replay. Separate test-only PostgreSQL injections verify standalone retry handling for SQLSTATE 40P01/40001; injected serialization failure is not represented as an observed production isolation anomaly.
- Actual TCP proxy drops PostgreSQL's successful COMMIT acknowledgement; the adapter reports unknown outcome and direct unchanged retry finds exactly one effect/audit/outbox.
- A temporary forbidden money -> ledger-postgres import is rejected by Nx's module-boundary rule; the probe is removed afterward. Lint builds the graph before enforcing the rule, including on a clean checkout.
- Account/reversal commands queued behind a held pool connection retain their original semantic payload despite caller mutation; unchanged original commands replay the same result.

## Failure scenarios actually exercised

1. Invalid monetary/journal input before transaction: no writes.
2. Unbalanced raw-SQL routine call: rejected at commit; journal, entries, receipt, audit and outbox roll back.
3. Empty/one-entry/constructing journal and forged initial posted header via administrative SQL: cannot commit.
4. Wrong currency/book/account, zero/negative/overflow/numeric JSON amounts, invalid side/time/schema: cannot create financial truth.
5. Partial/full transaction writes rolled back; two typed commands in caller-owned transaction both roll back.
6. Test-only failure before audit insertion and before outbox insertion: all earlier financial/audit rows roll back.
7. PostgreSQL backend terminated after routine writes but before COMMIT: no committed effect; unchanged retry succeeds.
8. Confirmed server COMMIT with acknowledgement dropped on the wire: durable one effect; caller cannot infer failure; unchanged retry safely replays.
9. Client disconnected immediately after commit and before any publication: outbox remains durable without a publisher.
10. Genuine deadlock and injected retryable SQLSTATEs: no partial committed group, no duplicate effects on retry.
11. Concurrent duplicates, competing reversals and conflicting keys: exactly one financial effect or explicit conflict.
12. Posted row/amount/side/account/currency/identity/date mutations, late entries, deletion and TRUNCATE: rejected by database permissions/guards.
13. Privileged balanced but incorrect reversal: exact inverse-entry guard rejects it.
14. Edited migration registry checksum: consistency check rejects history mismatch; fixture restored afterward.

Test-only triggers, sequence and TCP proxy exist only in the disposable suite and are removed/closed. No production fault-injection hooks or worker framework is shipped.

## Acceptance mapping

| Criterion                                | Proof/gate                                                                                     |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 1 Exact money                            | Full BIGINT unit/PBT and real DB string round trips, including above Number.MAX_SAFE_INTEGER   |
| 2 Valid posted journals balance          | Deferred guard, generated multi-entry DB trials, independent final sweep                       |
| 3 Unbalanced cannot become truth         | Raw routine, header/entry adversarial SQL and commit-rejection tests                           |
| 4 Atomic posting                         | Visibility-before-commit, explicit rollback, companion fault injection and backend termination |
| 5 Posted entries immutable               | Runtime privileges plus owner/admin mutation/late-insert/TRUNCATE guards                       |
| 6 Semantic replay no duplicate           | Command and business-effect keys; repeated/order-independent DB properties                     |
| 7 Conflict detected                      | Same command/different payload and same effect/different alias payload tests                   |
| 8 Concurrent duplicates one effect       | 100 synchronized callers plus alias race                                                       |
| 9 New full reversal neutralizes original | Exact multiset guard, account-delta properties, original snapshot unchanged, reversal race     |
| 10 Durable append-only audit             | Creation audit companion guard, atomic rollback, actual DB principal, mutation tests           |
| 11 Transactional downstream intent       | Outbox companion guard, identity/version checks, rollback and post-commit disconnect tests     |
| 12 Crash/retry no duplication            | Backend termination, actual lost COMMIT acknowledgement, unchanged replay and deadlock tests   |
| 13 Real PostgreSQL guarantees            | Disposable PostgreSQL 18 with real roles, connections, constraints, triggers and lock barriers |
| 14 Clean-checkout reproducibility        | Pinned pnpm lockfile/image plus independent clean-copy install/rebuild/verification            |

## Files introduced and changed

New foundation/configuration: `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `.gitignore`, `.node-version`, `.prettierrc.json`, `.prettierignore`, `nx.json`, `tsconfig.json`, `tsconfig.base.json`, `tsconfig.check.json`, `eslint.config.mjs`, `compose.yaml`.

New libraries: each of `libs/money`, `libs/ledger-domain`, `libs/ledger-postgres` has `package.json`, `project.json`, `tsconfig.json`, `src/index.ts`; money and ledger-domain additionally have `test/money.test.ts` and `test/ledger.test.ts` respectively.

New database/tool/test files: `database/migrations/001_financial_core.sql`, `tools/migrate.ts`, `tools/migrations.ts`, `tools/test-postgres.ts`, `tests/ledger.integration.test.ts`, `tests/helpers/commit-proxy.ts`.

New implementation docs: `docs/phase1/README.md`, `docs/phase1/verification.md`.

Updated docs: root `README.md`; architecture `README.md`, `invariants.md`, `data-model.md`, `state-machines.md`, `transactions-and-outbox.md`, `implementation-sequence.md`; ADR index and ADR-004. Changes record approval, current enforcement vs future guarantees, open-only accounts, conservative reversals, creation-only audit/outbox, raw SQL and transaction composition. No extra ADR was needed.

## Limits and remaining assumptions

- Real-data/domain accounting correctness is not proved by balanced journals; approved posting policies and authorization remain caller obligations.
- Owner/superuser deliberate bypass is outside DB invariants. Ordinary SQL errors are guarded; migrations require privileged reviewed credentials.
- Full authorization, two-person approvals, account closure, partial/reversal-of-reversal and dedicated replacement workflow remain deferred. No full GL or money movement.
- Durable outbox intent is proved, but consumption, leases, recovery scheduling, alerts and delivery are not implemented. No exactly-once message claim.
- Tests establish commit durability with fsync/synchronous_commit on in one real PostgreSQL instance; disaster recovery, replication/storage failure, backup/restore and production load are not verified here.
- Generated properties record seeds and versioned dependencies; they supplement, not replace, DB/concurrency examples.
- Test environment uses Docker and local trust identities; production authentication/TLS/secret provisioning is deferred. No customer financial credentials are present.
- Workspace has no Git metadata; no diff/commit/push claim. File scope, type/lint/format and documentation links are checked directly.

## Executed results

**Phase 1 complete: all 14 acceptance gates passed.** This establishes the documented synthetic/test financial-core boundary; it does not approve production use or deferred accounting/operational controls.

| Executed command/check                                               | Result                                                                                                     |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile` in an independent clean source copy | PASS; all four workspace packages installed with pinned lockfile                                           |
| `pnpm format` followed by `pnpm format:check`                        | PASS                                                                                                       |
| `pnpm lint`                                                          | PASS; project graph generated before lint, zero warnings; no skipped boundary rule                         |
| `pnpm build`                                                         | PASS; all three libraries built, Nx task cache skipped                                                     |
| `pnpm typecheck`                                                     | PASS; strict checks for source, tests and tools                                                            |
| `pnpm test:unit`                                                     | PASS; 10 tests, including 2,500 generated property trials                                                  |
| `pnpm test:integration`                                              | PASS; 31 real PostgreSQL tests, including 50 generated journal/replay/reversal trials; zero failures/skips |
| Migration from empty, reapplication and altered-checksum rejection   | PASS within the integration runner/suite                                                                   |
| `pnpm verify` in the working directory                               | PASS, exit 0; complete final implementation                                                                |
| `pnpm install --frozen-lockfile && pnpm verify` in clean copy        | PASS, exit 0; fresh install/build/full suite without source-directory artifacts                            |
| Temporary forbidden import + `pnpm lint`                             | Expected failure with `@nx/enforce-module-boundaries` circular/dependency error; probe removed             |
| Local Markdown links/code fences                                     | PASS; 23 documents, 52 local links, no broken links/unclosed fences                                        |

Environment: Node **24.21.0**, pnpm **11.27.0**, PostgreSQL **18.6 (Debian 18.6-1.pgdg13+2)** using the pinned digest in the runner. PostgreSQL `fsync` and `synchronous_commit` were verified `on`. Actual non-superuser logins were used for runtime commands; an admin login was used only for migrations, bootstrap and adversarial test fixtures.

The final independent copy was `/tmp/flow-phase1-final-0EcE5c`. Copying excluded `node_modules`, `.nx`, all `dist` directories, `.git` and TypeScript build-info files. Installation used the ordinary pnpm content-addressable store; no working-directory dependencies or build cache were copied. All 41 tests and 2,550 property trials passed there as well. Both disposable test containers were stopped by the runner. The result record was added after those completed runs; only documentation formatting/link checks followed, with no implementation changes.

No acceptance gate remains unresolved. Reproducibility has been exercised on this Linux/Docker environment; other operating systems and the explicitly deferred production controls are not claimed as verified.
