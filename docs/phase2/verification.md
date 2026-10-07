# Phase 2 verification record

Date: 2026-10-07. **Phase 2 complete: all 18 requested acceptance criteria passed within the documented synthetic simulator boundary.** Phase 3 was not started. This is not production accounting approval or proof of future reconciliation detection.

## Files and dependencies

Created:

- `libs/simulator/{package.json,project.json,tsconfig.json,src/index.ts,test/input.test.ts}`
- `libs/simulator-oracle/{package.json,project.json,tsconfig.json,src/config.ts,src/random.ts,src/index.ts,test/simulation.test.ts}`
- `tools/simulator.ts`, `tools/oracle-boundary.mjs`, `tools/check-oracle-dependencies.mjs`
- `tests/simulator-boundaries.test.ts`, `tests/simulator-ledger.integration.test.ts`
- `docs/phase2/README.md`, `docs/phase2/verification.md`

Modified: root `README.md`, `package.json`, `pnpm-lock.yaml`, `tsconfig.base.json`, `tsconfig.json`, `eslint.config.mjs`; runtime trust tags in the three existing `libs/*/project.json` files; `tools/test-postgres.ts` to include the new suite; architecture overview and implementation sequence to record Phase 2 authorization/status.

No external dependency added or version changed. The runtime simulator uses existing money/domain workspace contracts; the private generator uses existing money/simulator contracts. Node crypto, JSON, filesystem and test/process APIs suffice. No financial-core implementation, existing financial tests, migration, DB schema, role, invariant or accounting rule changed. No ADR changed or added: oracle separation implements the existing Phase 0 decision rather than replacing it.

## Executed checks

| Check / command                                                                    | Result                                                                                                                                    |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`                                                   | PASS in workspace and independent clean source copy; pinned existing dependencies                                                         |
| `pnpm format`, `pnpm format:check`                                                 | PASS                                                                                                                                      |
| `pnpm lint`                                                                        | PASS; generated Nx graph, zero warnings, repository import guard and transitive manifest guard                                            |
| `pnpm build`                                                                       | PASS; five libraries, cache skipped; fresh clean-copy outputs                                                                             |
| `pnpm typecheck`                                                                   | PASS; strict source, tools and tests                                                                                                      |
| `pnpm test:unit`                                                                   | PASS; 41 tests: 10 existing financial tests, 2 runtime-contract tests, 25 simulator tests, 4 boundary tests                               |
| `pnpm test:integration`                                                            | PASS; 32 tests against disposable real PostgreSQL 18.6: 31 unchanged Phase 1 tests plus 1 simulator/public-ledger test; no failures/skips |
| `pnpm verify`                                                                      | PASS in workspace; all gates above                                                                                                        |
| Final focused lint/typecheck/unit/build after boundary/configuration hardening     | PASS; numeric configuration amounts rejected and TypeScript import-type oracle access denied                                              |
| `pnpm install --frozen-lockfile && pnpm verify` in `/tmp/flow-phase2-clean-lTfVje` | PASS, exit 0, on final implementation; all 73 tests and 4,550 property trials                                                             |
| Cross-process CLI generate/replay                                                  | PASS; byte-identical public input and manifest under Asia/Manila and America/New_York; replay hash agrees                                 |
| Existing output and public/private overlap probes                                  | PASS; deliberate CLI requests rejected                                                                                                    |
| Golden v1 input/oracle checksums and PRNG vector                                   | PASS; accidental compatibility drift has an executable gate                                                                               |
| `git diff --check` and scope review                                                | PASS; no changes to existing core source/tests/SQL                                                                                        |

The fresh source copy excluded `node_modules`, `.nx`, `.git`, `dist`, TypeScript build-info and credential/environment directories/files. It used the normal pnpm content-addressable store, with all 408 dependency packages reused and no dependency downloads. No working-tree build output or Nx cache was copied. This is a clean **source copy**, not a commit or an unmodified Git checkout: the authorized implementation remains uncommitted. Final evidence documentation was written after those runs; final formatting/local-link/whitespace checks followed without implementation changes.

Environment: Node 24.21.0, pnpm 11.27.0, TypeScript 5.9.3, Nx 23.2.1, fast-check 4.10.2, PostgreSQL 18.6 with the unchanged Phase 1 pinned image. `NX_DAEMON=false NX_ISOLATE_PLUGINS=false` were environment settings for verification; no repository verification gate was disabled. Disposable DB containers were stopped by the existing runner.

Initial environmental failures: the sandbox denied pnpm's cache-index write and tsx/Nx sockets; the first offline install lacked required registry policy metadata. The pinned ordinary install then passed with registry access. Verification ran with expanded execution access for local sockets/Docker; it did not skip tests. An initial boundary-test tuple typing error was fixed. A final source review added explicit string checks for simulator monetary configuration and coverage for TypeScript `import(...)` types; subsequent checks and the full clean-copy suite passed. No failure was labeled pre-existing.

## Test and property inventory

Simulator tests exercise seed/default normalization, repeated byte determinism, meaningful seed differentiation, explicit version/seed validation, deterministic UTC time, invalid/excessive/overlapping placement rejection, large exact amounts above Number.MAX_SAFE_INTEGER, signed negative/zero settlement behavior, retained fees, full/partial refunds, chargeback debits, all 14 faults independently, a 28-fault mixed scenario, exact ten-duplicate/four-mismatch configuration, absence of oracle annotations, immutable truth, and cross-process replay/CLI artifact separation.

Four simulator properties each run **500 trials**:

| Seed  | Property                                                                                                                                                           |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 70201 | Independent bigint recomputation of per-kind batch totals/net, complete unique membership, identity uniqueness, refund bounds and bank conservation; 1–80 payments |
| 70202 | Exact whole-simulation replay from normalized version/configuration/seed; 1–40 payments                                                                            |
| 70203 | N configured omissions/duplicates produce N distinct oracle anomalies and exact observed count deltas                                                              |
| 70204 | PRNG range bounds and distinct sparse sampling, including money above safe Number range                                                                            |

New simulator trials: **2,000**. Unchanged Phase 1 trials: **2,500 unit/domain + 50 real PostgreSQL**. Total per full run: **4,550**. Statistical uniformity or cryptographic randomness is not claimed.

Boundary probes deny package imports, relative source/dist imports, re-exports, dynamic imports, require, TypeScript import types and imports of test harnesses from untagged application paths. Nx separately rejects runtime simulator → oracle and money → simulator. A temporary manifest fixture demonstrates untagged app → bridge → oracle rejection. The runtime API exports only `captureCommand`, `stableJson`, `sha256`; there is no oracle or generation API there.

The added PostgreSQL exercise generates 20 independent capture expectations, four duplicate command attempts, three omitted attempts and two corrupted external amounts. It posts only 17 effects initially through `PostgresLedger.post`, observes four harmless command replays and independently checks the missing monetary amount. Unchanged internal commands recover all 20 effects, with exact opposite receivable/sales deltas and exactly 22 audit/outbox companions (20 journals + 2 account creations). Only synthetic book bootstrap uses admin SQL; no authoritative account/journal/entry insertion or constraint bypass occurs.

## Determinism evidence

Golden configuration: seed 828192, 12 payments, batches 3–5, two full refunds, three partial refunds, one chargeback; capture mismatch placements 0/3, two duplicate source events and missing capture attempt placement 1.

```text
version: phase2-v1
input SHA-256: fa870c7b1d71bc13a417a1455c19b78960f6dd49b0091738ec23ed9a09f40db0
oracle SHA-256: 7d4aba26bb4b38129261e4f7c714124b8b8bdc3a1d232f1683a9361d6418f07e
```

The private replay artifact stores the complete normalized configuration, including explicit placements. Independent Node invocations execute CLI generation and replay, comparing both public files byte-for-byte and safe stdout exactly. Golden checks are a version-decision gate, not a claim that every future implementation is compatible.

## Workloads actually measured

Built generator, three separate Node processes, seed 828192, default PHP economics, no refunds/chargebacks/faults. Timed with `performance.now()` outside generation; peak process RSS measured with Node `process.resourceUsage().maxRSS`. These are one-shot local observations, not throughput targets or production capacity claims. Hashing and immutable-output construction are included; disk export is excluded.

| Payments | Processor events | Batches / bank movements | Generation | Peak RSS      |
| -------- | ---------------- | ------------------------ | ---------- | ------------- |
| 1,000    | 2,000            | 48 / 48                  | 109 ms     | 86,512 KiB    |
| 10,000   | 20,000           | 486 / 486                | 730 ms     | 229,944 KiB   |
| 100,000  | 200,000          | 5,061 / 5,061            | 7,303 ms   | 1,053,648 KiB |

Internal expectations and initial capture attempts each equal payment count. The largest observed output has 410,122 public records across all collections. The 10,000-payment public input checksum is `fa297e9a69e8c12c47f3b82c388316b2bd77c87facab1cfa99e03d47a99bbb2c`. A first attempt to use `/usr/bin/time` failed because that executable is absent; the actual measurements above use Node's built-in APIs and required no dependency.

**NOT RUN:** 1,000,000 payments. Memory grows materially because generation, event strings, oracle objects, sorting and checksum serialization are in memory. No million-payment capacity claim is made; streaming/export optimization requires further work before such a benchmark can be considered practical. No soak, disk-export throughput or concurrent simulator workload was measured.

## Acceptance mapping

| Criterion                   | Implemented and executed evidence                                                                                                        |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 1 Explicit seed             | Required uint32, including zero; recorded in normalized configuration/manifest; missing seed rejected                                    |
| 2 Reproducibility           | Repeated whole-output equality, property 70202, clean-process replay and v1 golden hashes                                                |
| 3 Deterministic time        | Validated UTC base plus integer virtual offsets; replay across timezone settings; no current-clock/entropy calls                         |
| 4 Existing exact money      | Money/bigint/string boundaries; independent arithmetic, unsafe-number rejection and large-value tests                                    |
| 5 Coherent happy path       | Distinct capture/fee components and separate reports/bank evidence; independent conservation assertions                                  |
| 6 N:1 batching              | Deterministic contiguous variable-sized groups, complete unique components, exact totals                                                 |
| 7 Full/partial refunds      | Both implemented before settlement; fees retained; bounds/semantics tested                                                               |
| 8 Controlled anomalies      | All 14 evaluated types implemented with exact counts/placements and private evidence                                                     |
| 9 Separate truth/input      | Canonical generation then copy-on-write corruption; canonical values unchanged by faults                                                 |
| 10 Runtime oracle isolation | Test-only package, Nx restrictions, repository-wide import/manifest guards and executable denials; only public artifacts supplied to SUT |
| 11 Stable synthetic IDs     | Namespaced hashed identities independent of delivery order; uniqueness/replay tests                                                      |
| 12 Version identity         | Explicit v1, normalized config hash/seed, unknown version rejection and golden compatibility gate                                        |
| 13 Safe manifest            | Delivered counts/settings/hashes; no placements, canonical missing IDs, before-values or oracle control answers                          |
| 14 Property tests           | Four properties, 2,000 trials per run, recorded seeds                                                                                    |
| 15 Failure reproduction     | Full private replay config and checksum-enforcing CLI; corrupted scenario replay tested                                                  |
| 16 Phase 1 gates preserved  | Existing 41 financial tests/2,550 trials pass unchanged in workspace and clean copy                                                      |
| 17 Public ledger boundary   | Capture adapter validates domain commands; real DB test uses public account/post API; no simulator persistence dependency                |
| 18 No later phases          | Only synthetic contracts/generator/corruption/harness/tests/docs; no ingestion or matcher                                                |

Oracle isolation is an enforceable **repository/runtime dependency and artifact boundary**, not protection from malicious same-user code with access to the generator checkout. No application host exists to configure OS mount/credential isolation. Future runners must mount only public input and omit the private package/artifact/credentials; Phase 2 does not claim isolation for a future deployment that violates that requirement.

## Assumptions, risks and deferrals

One synthetic merchant, PHP, synthetic fee floor policy and elapsed UTC settlement delays. Negative net is an explicit synthetic bank debit/collection; zero net has no bank movement. No real provider behavior or approved chargeback/revenue policy is inferred. Expected capture journals are named synthetic mechanics with caller-provided accounts; remaining oracle financial impacts are processor-balance contributions, not production journal templates.

After-settlement/multiple refunds, dispute recovery/fees, distinct-ID conflicting payouts, overlapping faults on one record, FX/taxes/reserves/calendars and million-payment streaming remain deferred. So do ingestion, normalization, source completeness evaluation, reconciliation/detection, exception workflow, actual adapters, general fault/crash runners, asynchronous infrastructure, frontend, cloud and AI. Oracle controls describe what future verification should detect; no future detection result is reported as passing.
