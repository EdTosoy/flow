# Phase 4: processor claims and settlement expectations

Scope: synthetic processor interpretation, payment association and processor-internal controls. These are external-evidence interpretations, never independent business authorization, posted accounting, bank receipt or reconciliation proof. [Verification](verification.md) records executed evidence and limitations. Phase 5 is deferred.

## Terminology and ownership

Phase 0's **payment** remains an independently supplied internal obligation/intent. `processor.payment` is a separate **processor payment association**: an opaque internal UUID groups the processor's claims about one external payment reference. It creates no authorized internal intent. The SQL name is schema qualified to retain that distinction. [ADR-011](../architecture/adr/011-processor-interpretations.md) makes the milestone's narrowing explicit.

A **capture** is one positive `PAYMENT_CAPTURE` activity, separate from its payment association. A **processor activity** is one immutable interpreted balance component: capture, `PROCESSOR_FEE`, `REFUND`, or `CHARGEBACK`. Avoid unqualified “transaction.” An activity is neither a database transaction nor a ledger journal.

A **fee** is an explicit source activity, potentially many per payment. A **refund** returns some captured value; multiple refunds and full/partial totals are supported. A **chargeback** is a separate disputed debit claim and never a refund. A **settlement** is a processor-reported transfer claim. Its stable identity is the ingestion source fact; a **settlement batch** is an immutable interpretation of one itemized report revision. **Membership** is an ordered source assertion about external component IDs, including unresolved and duplicate references. No independent scheduled settlement obligation, generic adjustment, reserve or fee-reversal entity is fabricated because synthetic evidence does not supply it.

```text
raw receipts → source revisions → normalized observations → processor derivations
                                                       → activities / payment associations
                                                       → settlement batches / member references
                                                       → immutable evaluation snapshots

ledger journals remain separate; no processor command posts them
```

`@flow/processor-domain -> money + ingestion-domain` supplies terminology, pure interpretation/sign/lifecycle/conservation functions and result contracts. `@flow/processor-postgres -> processor-domain + pg` supplies controlled commands. The database implements the same registered interpreter with projections validated against immutable normalized evidence. Foundation, ledger and ingestion packages do not depend on processor packages. Tooling alone composes public simulator, ingestion and processor APIs. No external dependency or version is added.

## Identity and reproducibility

Payment associations are unique by `(source_account_id, exact external_payment_reference)`. The source account carries immutable book/environment/provider/account scope. UUIDs are separate from external references. Payment currency is derived from current activities; mixed-currency aggregate totals and currency remain NULL, with zero validated refund. Incompatible currencies produce a control instead of splitting one source payment silently. Multiple external activities, captures, fees, refunds and chargebacks can share one association. Reference equivalence is the explicit synthetic contract, not production identity resolution or inference from amounts/dates.

Derivation identity is `(source_revision_id, normalizer_version, processor_interpreter_version)`, protected by PostgreSQL uniqueness. The registered interpreter is `processor-v1`; unsupported versions are rejected. Both existing movement normalizers can be explicitly selected; they yield separate historical interpretations, with one pinned normalizer used per evaluation. Economic components are identified by scoped source fact, so alternate normalization versions are never added together. Registry, retained SQL migration, code and pinned lockfile reproduce this version; changing meaning requires a new interpreter identifier and reviewed migration, not editing an applied migration.

Each derivation restrictively references the exact normalized `(revision, normalizer version)`, which references its basis raw receipt, original bytes and source scope. Activities and batches are projections checked against that evidence. Repeated derivation returns the original UUID and creates no additional activity, association, membership or outbox intent. An opaque UUID is a durable logical identity, not a deterministic UUID across independently initialized databases.

## Exact money and lifecycle

Individual contributions use existing `Money.fromJSON`, signed BIGINT and explicit currency. Positive capture increases processor balance. Fees/refunds/chargebacks decrease it. Zero fee is supported. Captures must be positive; refunds/chargebacks must be negative. A contrary source sign remains stored with `INVALID_SIGN`, never silently inverted. The full signed Money interval remains representable, including its minimum. Aggregates use unbounded bigint / exact SQL NUMERIC integer arithmetic and decimal strings; they can exceed an individual Money range. No FX, rounding or floating point is involved.

Lifecycle is a projection over one frozen current-evidence population, never a mutable state independent of activities:

| Condition                                       | Lifecycle            |
| ----------------------------------------------- | -------------------- |
| Any payment control fails                       | `under_review`       |
| Valid chargeback total is positive              | `charged_back`       |
| No capture or debit evidence                    | `observed`           |
| Captures exist, no refunds                      | `captured`           |
| Refund total is between zero and captured total | `partially_refunded` |
| Refund total equals captured total              | `refunded`           |

Chargeback precedence does not erase refund history. Parent capture identity, amount and currency remain evidence. `observed` is the pure empty-population state; the current public write API creates associations only with activities, so no standalone empty payment creation is promised.

## Refund, chargeback and fee controls

Multiple refund **claims** are retained. Each refund must explicitly reference an unambiguous capture in the same payment/source/object-kind/currency. Sum of supported, correctly signed refunds per parent capture must not exceed that capture. All such evidence is evaluated together under the scope transaction and one stable database snapshot; no order-dependent first-worker allocation exists.

`refundedMinor` records the correctly signed claimed total. `validRefundMinor` is the total only when every payment control passes; otherwise it is zero, and lifecycle is `under_review`. This conservative all-or-none validation does not authorize refunds or move money. PostgreSQL enforces the evaluated refund bound and validates projections/provenance; external over-refunds remain immutable source facts. Concurrent interpretation can retain inconsistent external claims but cannot label an excessive refund total valid. Old snapshots remain explicitly as-of, never assertions of current validity.

Chargebacks require a parent capture and remain separately totaled. Recovery, dispute decisions, won/lost states, chargeback fee policy and production accounting are deferred. Refund plus chargeback totals are not automatically restricted to the capture; their interaction requires source-specific rules before real use. Fees preserve their own normalized record and optional parent; no fee is inferred from gross minus net. Fee reversals/adjustments are unsupported evidence, not silently treated as negative fees or ordinary refunds; their eventual supported model needs a new contract/version.

## Settlement calculation and controls

A batch carries scoped source-fact/report provenance, reported currency/net, transfer reference and reported time. The source supplies no settlement period or authoritative departure/bank-arrival status, so none is invented. Membership uses `(batch_id, ordinal)` with exact external activity ID and the declared synthetic object kind. Duplicated references are retained as inconsistent evidence, never a second valid contribution. A report arriving before its components stays explicable without placeholder payments/captures.

Evaluation pins the batch, one activity normalizer/interpreter policy and an explicit `evaluation_key`. It resolves each member by scope and source fact, using only an unambiguous source revision. Selected activities have typed immutable evaluation links. Input stores resolved IDs, unresolved references, revision status, conflicting reports and supporting payment snapshots. `calculatedNetMinor` is:

```text
sum(signed exact capture + fee + refund + chargeback contributions)
```

It is NULL if a member is missing, pending, ambiguous, duplicated, cross-currency or has an invalid sign. `knownComponentNetMinor` is a diagnostic subtotal of distinct known component identities, not a complete expected net. Reported and calculated totals are separate; disagreement persists as `NET_MISMATCH`. An otherwise calculable external claim can still have payment or conflicting-membership controls; a number alone never certifies valid composition.

Controls are deterministic, deduplicated and sorted:

| Control                     | Meaning                                                |
| --------------------------- | ------------------------------------------------------ |
| `MISSING_ACTIVITY`          | No scoped component source fact                        |
| `PENDING_ACTIVITY`          | No interpreted component under the pinned policy       |
| `AMBIGUOUS_ACTIVITY`        | Multiple source revisions; no authoritative selection  |
| `AMBIGUOUS_SETTLEMENT`      | Report identity has multiple source revisions          |
| `DUPLICATE_MEMBERSHIP`      | Repeated reference in one batch                        |
| `CROSS_CURRENCY_MEMBERSHIP` | Component currency differs from report                 |
| `CONFLICTING_MEMBERSHIP`    | Another settlement identity asserts the same component |
| `NET_MISMATCH`              | Complete component sum differs from reported net       |
| `PAYMENT_CONTROL_FAILED`    | Related payment evidence violates a payment control    |
| `INVALID_SIGN`              | Contribution direction contradicts activity type       |
| `INVALID_PARENT`            | Missing/incompatible/unresolved parent capture         |
| `CROSS_CURRENCY_PAYMENT`    | Payment association has incompatible currencies        |
| `REFUND_EXCEEDS_CAPTURE`    | Cumulative refunds exceed a referenced capture         |

These are **processor-internal** controls, not bank reconciliation, matches or exception cases. Passing means the received itemized claim is internally explained under this contract. It does not prove an omitted activity should have been in a batch, contractual fee correctness, independent internal authorization or economic/source completeness. Conflicting batch evidence is preserved across report revisions conservatively; an ambiguous correction cannot release a component claim or silently cure a conflict. There is no active reconciliation allocation table in Phase 4.

## Corrections, ambiguity and snapshot freshness

Changed source content creates a new Phase 3 revision and a new processor derivation; prior facts, batches, memberships and calculations remain immutable. No tokens, timestamps, receipt order or hashes order corrections authoritatively in this synthetic contract. Multiple revisions remain `REVIEW_REQUIRED`; no current activity is selected. `processor.current_activity` exposes history with `source_unambiguous`, normalizer and interpreter fields. Consumers must pin their versions and require the unambiguous flag; it is not a latest-wins list.

Same evaluation key replays its original snapshot even after new input arrives. A fresh key explicitly evaluates a new population. Changed version policy under a reused key is P4001. Historical snapshots are as-of results, never automatically rewritten or automatically promoted to current assurance. Supersession/activation requires reliable source ordering or approved review and remains deferred; ambiguity is an explicit result now. No received-at fallback exists.

## Transactions, concurrency, durability and permissions

Source acceptance and normalization retain their existing independent Phase 3 transactions. Processor interpretation is a separate READ COMMITTED transaction: source-account lock, derivation identity, payment association plus activity **or** batch plus all source member references, and required outbox commit together. A failure cannot delete or roll back previously committed normalized/source evidence. Different source accounts proceed independently; scope serialization favors correctness over throughput.

Evaluation separately locks the same source account and uses stable PostgreSQL helper queries to capture one consistent snapshot of processor/source evidence. Ingestion and processor derivation share that lock, preventing concurrent corrections/associations/memberships from changing the population while evaluated. Normalization can complete independently, but does not add a processor activity until derivation acquires the same lock. Snapshot, typed activity links and failed-control audit commit together. No file/network/oracle read occurs inside these transactions. Unique keys remain the final identity barriers.

Runtime writer/reader groups are separate from ingestion writer and ledger writer. SECURITY DEFINER commands have fixed `pg_catalog, pg_temp` search paths and qualified objects; only `processor.derive` and `processor.evaluate` are writable capabilities. Runtime direct base-table mutation/DDL/owner access is denied. All processor facts/registries/snapshots reject UPDATE, DELETE and TRUNCATE, including accidental admin SQL. Projection and membership provenance guards require the derivation creation transaction; deferred guards reject incomplete activities/batches/membership populations or missing required outbox/audit. No generic mutation API exists.

Whole-command retries handle 40001/40P01 with unchanged identity, bounded to five attempts. An ambiguous transport error around COMMIT raises `UnknownProcessorCommit`; retry the unchanged revision/version or evaluation key on a healthy connection. Returning a command result before an outer commit is not exposed by this adapter. Host pools own idle-client diagnostics. No exactly-once delivery, worker/publisher, broker or production authorization product is claimed.

## Provenance, audit and outbox

Every pure derivation already has immutable evidence lineage, so it does not produce a per-activity acceptance audit event. Failed processor-control evaluations create one existing-schema audit event with typed evaluation FK, actor, actual session principal, reason, version and database time. Replays do not add events. Operational errors use sanitized messages rather than copied payloads or credentials. Audit records significant control results; provenance explains meaning; logs diagnose execution.

Every processor derivation atomically creates one `processor.interpreted` intent in the existing outbox, pointing to its immutable derivation and book. Deferred validation enforces its presence; crash after commit leaves it durable. There is no new queue or consumer. Evaluation needs no separate notification in this synchronous milestone. Authoritative supersession, if later introduced, must have its own atomic audit/invalidation/intent decision.

## Developer pipeline

```sh
pnpm simulator generate --seed 828192 --payments 100 --out /tmp/phase4-public
# Provision a synthetic book and separate runtime logins, then migrate through the existing admin workflow.
DATABASE_INGESTION_URL=<ingestion-runtime-url> DATABASE_PROCESSOR_URL=<processor-runtime-url> \
  pnpm processor /tmp/phase4-public/input.json <book-uuid> run-1
```

The CLI reads only the public artifact, ingests movements, normalizes and derives them, separately ingests itemized reports with `synthetic-settlement-v1`, then prints receipt dispositions, payments/activity/batch counts and per-batch exact totals/controls. Phase 3's unchanged default movement interpretation explicitly fails for settlement reports; the requested settlement normalizer produces their typed result alongside it. No source receipt is omitted from processing accounting.

Repeat `run-1` replays acquisition/interpretation/evaluation identities. Use a new run key for new source evidence/evaluations. Normal output never includes oracle results, internal capture expectations, bank conclusions or hidden anomaly annotations. Programmatic activity normalization and the CLI preserve the original public artifact through the existing ingestion adapter; report rows retain their public structured JSON evidence. Existing Phase 3 limits apply: whole in-memory acquisitions, at most 10,000 receipts per batch and 16 MiB per payload/artifact. This developer tool rejects oversized acquisitions rather than claiming unverified streaming capacity.

## Explicit deferrals and trust assumptions

Phase 5 and later; bank ingestion/receipt/comparison; reconciliation/matching/allocations; exception/review workflows; independent internal payment authorization and accounting orchestration; real provider identity/ordering/signature/API contracts; adjustment/reserve/tax/fee reversal/FX policies; chargeback recovery/dispute decisions; authoritative supersession; asynchronous execution; frontend/cloud/AI; large-volume/soak/restore/production readiness. No deployment, commit or push is part of this milestone.

Source adapters and database administrators remain trusted. Dependency checks protect runtime oracle isolation; they are not an OS sandbox against malicious same-user filesystem access. Future hosts must exclude private oracle artifacts/packages/credentials. PostgreSQL mechanism references checked for version 18: [stable function snapshots](https://www.postgresql.org/docs/18/xfunc-volatility.html), [transaction isolation](https://www.postgresql.org/docs/18/transaction-iso.html), [cross-row constraint limits](https://www.postgresql.org/docs/18/ddl-constraints.html), and [restricted SECURITY DEFINER](https://www.postgresql.org/docs/18/sql-createfunction.html). Executed tests substantiate the implemented boundary.
