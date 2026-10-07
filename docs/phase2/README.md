# Phase 2: deterministic financial simulator

Scope: synthetic PHP economics and test artifacts only. No ingestion, normalization, reconciliation, payment platform, real adapters, workers, frontend, cloud or AI is implemented. Phase 1 money, domain commands, SQL and financial constraints remain authoritative.

## Model decided before implementation

One synthetic merchant/book, processor account and bank account. Payers are opaque surrogates without PII; there is no customer lifecycle. Each payment has an independent internal capture expectation and processor capture/fee components. A payment optionally has one full or partial refund **before settlement**, or one full chargeback debit, never both. Fees are retained on refunds/chargebacks. Chargeback recovery, dispute fees, after-settlement refunds and production chargeback accounting policy are deferred. These are explicit synthetic economic rules, not approved production posting policies.

A settlement reports all capture/fee/refund/chargeback components for a deterministic contiguous group of payments. Gross minus retained fees minus refunds minus chargeback debits equals signed net. Positive net produces a bank credit, negative net a bank debit (synthetic processor collection), zero produces no bank movement. There are no banking calendars, reserves, taxes or FX. Source report membership is legitimate processor evidence; hidden correspondence from internal expectations to source records belongs only to the oracle. Bank data contains a transfer reference, never hidden settlement/payment IDs.

Internal capture/refund expectations are generated from economics, independently of processor observations. The minimal ledger exercise posts captures through the public Phase 1 command port using caller-supplied accounts and a named synthetic test policy. Other economic movements have oracle processor-balance contributions, not invented production journals. Missing/duplicate capture attempts can therefore differ from the external world without changing truth.

## Packages and trust boundary

- `@flow/simulator`: runtime-safe JSON contracts, canonical JSON/checksum helpers and capture-command adapter; depends only on money and ledger-domain. It cannot generate truth or access the oracle.
- `@flow/simulator-oracle`: test-only seeded canonical economics, corruption, private expected relationships/control totals/anomalies and replay configuration. Depends on simulator and money; never on ledger persistence.
- `tools/simulator.ts`: explicit local test harness; writes public and optional private artifacts to separately specified directories. It never passes the private object to application code.

Nx tags restrict runtime libraries. A repository ESLint rule additionally denies oracle imports/re-exports/dynamic imports/require from every file except oracle code and the named generation/integration harnesses, including relative paths and new untagged applications. A dependency check denies runtime package dependencies on test-only projects. These are accidental-dependency controls, not an OS security sandbox: running SUT code with the generator's filesystem permissions would violate the boundary. Mount **only the public output directory** into a future SUT process; never give it the oracle package, private directory or generator credentials. No application host exists in Phase 2.

## Deterministic generation

Reproducibility identity is **`phase2-v1` + resolved configuration + explicit uint32 seed** (including seed zero). Defaults are normalized before SHA-256; optional zero-count faults normalize away. All configuration is copied and all returned objects recursively frozen. Unknown keys/versions, noninteger seeds/counts, fractional money, invalid UTC times, unsupported populations and overflowing batches fail explicitly.

RNG: SHA-256 of `phase2-v1:seed:stream` initializes a nonzero xorshift32 state (fallback `0x6d2b79f5`). Each draw applies shifts 13/17/5 with uint32 truncation. Two draws form an exact bigint 64-bit candidate; rejection against the largest multiple of the requested interval below 2^64 avoids modulo range reduction bias. This small simulation PRNG is not cryptographic and has a 2^32−1 state period. Separate named streams govern economics, adjustment selection and each anomaly type. Sparse Fisher-Yates sampling selects exactly N distinct targets using O(N) auxiliary memory; it does not rely on event-loop scheduling.

Identifiers are `syn_<kind>_<128-bit SHA-256 prefix>` over normalized **economic** configuration, kind and logical generation key. `syn_pay`, `syn_fee`, `syn_settlement`, `syn_bank`, `syn_refund` and `syn_chargeback` are explicitly synthetic; no actual provider behavior is implied. Keys include the seed/configuration namespace, not just arrival positions. Fault-only changes preserve canonical economic IDs/values and create distinct deterministic delivery/attempt IDs where needed. Logical generation keys remain indices internally; rearranging generation semantics requires a version change. Hash-prefix collisions are theoretical; tested canonical collections have distinct identities.

Time: default `2026-01-01T00:00:00.000Z`, or a validated canonical UTC millisecond timestamp. Captures are one virtual minute apart with seed-derived 0–999ms jitter. Fee occurrence is capture +1s, refund/chargeback +10s. Settlement report is the final capture's minute boundary +24h; bank booking +48h. Processor delivery is occurrence +1s before corruption. Virtual offsets are elapsed UTC durations, not claims about banking business days. Occurrence and delivery remain distinct; only delivery changes for lateness/reordering. No wall-clock read, random UUID or `Math.random()` exists in simulator generation.

Money: all values use Phase 1 `Money`, bigint and explicit PHP; JSON uses canonical integer minor-unit strings. A per-capture fee is `floor(gross_minor × feeBasisPoints / 10000) + feeFixedMinor`, computed only with bigint. Floor is the explicit synthetic fee policy; there is no floating-point money. Individual and aggregate batch amounts stay within Money's signed BIGINT range; overflow fails rather than wrapping. Fee magnitudes may be zero and remain explicit components. Refund and chargeback debits are signed negative processor movements. Partial refunds range from 1 through gross−1; cumulative refund/chargeback never exceeds the capture. A capture cannot have both a refund and a chargeback in v1.

## Configuration

Only exact integer counts are used for lifecycle/anomaly selection; Phase 2 does not expose floating-point probabilities or hidden rates. Fee basis points are integer contractual fee configuration, not failure probability.

| Field                                                      | Default / range                                                                                                    |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `version`                                                  | `phase2-v1`; reject others                                                                                         |
| `seed`                                                     | Required; uint32 0…4294967295                                                                                      |
| `paymentCount`                                             | Required; 1…1,000,000                                                                                              |
| `startTime`                                                | `2026-01-01T00:00:00.000Z`                                                                                         |
| `batchSizeRange`                                           | `[10,30]`; positive integers; final batch can be smaller                                                           |
| `amountMinorRange`                                         | `["10000","1000000"]`; PHP minor units; minimum 2                                                                  |
| `feeBasisPoints`, `feeFixedMinor`                          | 300, `"0"`; fee cannot exceed smallest capture                                                                     |
| `fullRefundCount`, `partialRefundCount`, `chargebackCount` | 0; deterministic mutually exclusive payment selections                                                             |
| `delayMilliseconds`                                        | 604800000 (seven virtual days); exact 1…31536000000                                                                |
| `anomalies`                                                | Empty; each supported kind accepts `{count:N}` or `{placements:[...]}`; optional count must equal placement length |

Placements are zero-based indices in the kind-specific canonical eligible collection described below; they are never delivered-array positions. Duplicate/out-of-range placements, insufficient available population and overlapping faults on one canonical record fail explicitly. Random count selection excludes targets already selected by earlier anomaly kinds, using the published `ANOMALY_KINDS` order. V1 intentionally rejects interacting faults on one record; broader adversarial combinations remain a later phase.

## Canonical truth and corruption

The generator first creates valid economic payments, independent internal expectations, signed processor activities, itemized settlement reports, booked bank observations and capture-command attempts. The oracle keeps canonical values and relationships. A separate corruption pass uses copy-on-write record replacement and omission/duplicate schedules; it never edits canonical truth. Fault selection has separate RNG streams, so adding faults does not alter economic generation.

| Anomaly key                  | Eligible placements / what input sees                                              | Oracle and later expected control                                                                                                   |
| ---------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `duplicate-source-event`     | Processor event collection; same event/payload, new delivery ID                    | One fact, two receipts; preserve receipts and deduplicate financial effects                                                         |
| `missing-source-event`       | Processor event collection; one delivery omitted                                   | Before record remains; internal expectation/report membership exposes absence                                                       |
| `out-of-order-event`         | Events before the final delivery; chosen event arrives after all normal events     | Occurrence unchanged; unresolved prerequisite must stay visible, then resolve                                                       |
| `delayed-event`              | Processor event collection; delivery shifted by configured milliseconds            | Original schedule retained; virtual cutoff determines pending/overdue                                                               |
| `duplicate-settlement`       | Settlement report collection; same report repeated                                 | Same payout retransmission, no second financial effect; distinct-ID competing payouts deferred                                      |
| `missing-settlement`         | Settlement report collection; report omitted                                       | Canonical transfer remains; processor/bank counterparts cannot fabricate it                                                         |
| `incorrect-amount`           | Capture events only; source capture +1 minor unit                                  | Correct amount retained, exact +1 discrepancy                                                                                       |
| `unexpected-processor-fee`   | Fee events only; source fee contribution −1 extra minor unit                       | Contractual/canonical fee retained, exact −1 discrepancy; this is misreported source evidence, not an actual extra canonical charge |
| `missing-bank-transaction`   | Nonzero bank movements; observation omitted                                        | Settlement obligation persists, absence visible                                                                                     |
| `duplicate-bank-observation` | Bank collection; same observation repeated                                         | One booked movement, no double allocation/counting                                                                                  |
| `wrong-reference`            | Bank collection; unrelated transfer reference                                      | Correct reference retained; equal amounts/dates are insufficient proof                                                              |
| `corrupted-source-record`    | Processor event collection; truncated JSON bytes                                   | Original valid bytes retained privately; malformed receipt must be accounted for                                                    |
| `missing-ledger-posting`     | Capture attempt collection; attempt omitted, internal expectation retained         | Expected capture effect persists; external truth is independent from ledger                                                         |
| `duplicate-ledger-command`   | Capture attempt collection; new attempt ID, unchanged semantic command key/payload | One expected capture effect; public ledger replay must not duplicate it                                                             |

Each injection produces exactly one private anomaly record, even when a duplicate has two observable receipts. It records kind, canonical index/identity, observed identities, before/after evidence, expected control and exact monetary delta when defined. Missing records have an empty observed-ID list and null after; nonmonetary faults have null discrepancy. These are expected future controls, **not implemented reconciliation/detection**.

## Output and manifests

Structured JSON input is independent of CSV/database insertion: scope, internal capture/refund expectations, raw synthetic processor event envelopes, itemized settlement reports, bank observations and capture attempts. Source component/payment/transfer references exist only where the synthetic source contract legitimately provides them. No `expected_match`, fault labels, hidden oracle relationship pointers or expected-case fields exist in input. Corrupt JSON can be represented as event payload bytes without pretending it is already normalized.

Public `manifest.json` contains scenario ID, version, seed, resolved start time, generation settings, anomaly **counts**, configuration SHA-256, delivered input counts and input SHA-256. It omits explicit fault placements, missing identities, correct-before values and expected controls. A manifest is harness metadata, not independent source coverage evidence and not reconciliation proof. The input hash is SHA-256 of sorted-key compact UTF-8 JSON (without trailing file newline); array order is preserved. Hidden placements are retained only in `oracle.json` replay configuration. Consequently the safe public manifest alone cannot reproduce explicit placements; retain the original configuration or private replay artifact for verification.

Private oracle: canonical payment-to-activity-to-settlement relationships, signed activities, settlement totals/membership, bank effects, expected independent capture effects, exact injected anomalies and complete normalized replay configuration. There is no oracle table or runtime database credential. Future SUT runners must receive only `simulation.input`, or only a mount of the public directory. Verifiers retain the oracle separately and inspect SUT results afterward. Source-provided membership/references are usable evidence; oracle relationships are inaccessible through the runtime contract.

## Generate and replay locally

```sh
pnpm simulator generate --seed 828192 --payments 10000 --out /tmp/flow-input
# Explicit debug-only oracle export into a separate private directory:
pnpm simulator generate --config /tmp/config.json --out /tmp/flow-input-2 --oracle-out /tmp/flow-private
pnpm simulator replay --replay /tmp/flow-private/oracle.json --out /tmp/flow-replayed
```

Without `--out`, only safe scenario ID/seed/version/input hash/delivered counts are printed. Oracle details are never printed by default. Output directories must be new, have existing parents and be disjoint, including resolved symlink ancestry. Files/directories are owner-only; existing outputs are never overwritten. This permission mode protects against other OS users, not a same-user process: isolate future SUT mounts/identities as specified above. Replay verifies the recorded input hash and fails explicitly on compatibility drift. An explicit debug reader can inspect `oracle.json`; do not supply it to SUT code.

Example exact injection configuration:

```json
{
  "seed": 828192,
  "paymentCount": 100,
  "fullRefundCount": 5,
  "partialRefundCount": 10,
  "chargebackCount": 2,
  "anomalies": {
    "duplicate-source-event": { "count": 10 },
    "incorrect-amount": { "count": 4 },
    "missing-ledger-posting": { "placements": [0, 3] }
  }
}
```

## Version compatibility and limits

`phase2-v1` names the entire generation/serialization/RNG/time/selection contract. Checked-in golden input/oracle hashes and RNG vectors catch accidental output drift, supplementing clean-process replay. Changing results requires an intentional new version; retain v1 code dispatch or use its historical source revision plus pinned lockfile for old benchmarks. Unknown versions fail; there is no automatic migration or silent reinterpretation. Keep version, configuration, lockfile/source revision and artifact checksums with benchmark results. Schema-compatible refactors must still preserve the golden outputs.

Generation is synchronous and in memory, proportional to payment/components/output size. Canonical records are shared where unchanged rather than cloning the whole world, but raw event strings, oracle records, sorted delivery arrays and checksum serialization require memory. One million payments is a validation ceiling, not a demonstrated practical capacity; measured workloads and resource limits appear in [verification](verification.md). Streaming/export adapters and performance optimization are deferred until measured need.

Explicit deferrals: after-settlement and multiple refunds, chargeback recovery/dispute fees, approved real accounting templates beyond synthetic capture mechanics, taxes/reserves/FX, real processor/bank schemas, calendars, ingestion/provenance storage, normalization, matching/controls/cases, worker crash scheduling, concurrent end-to-end delivery, application hosts, frontend, cloud and AI. Phase 1's existing real concurrency/crash/unknown-commit tests continue unchanged.

Boundary mechanism reference: [Nx tag restrictions](https://nx.dev/docs/guides/enforce-module-boundaries/ban-dependencies-with-tags) document that forbidden-tag checks also follow transitive dependencies. Installed Nx 23.2.1 behavior is verified by executable import probes rather than relying on documentation alone.
