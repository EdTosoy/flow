# Phase 6: deterministic 1:1 settlement-bank reconciliation

Scope: synthetic/test processor settlement ↔ booked bank movement only. No accounting posting, N:1/1:N/N:M matching, exception workflow, fuzzy scoring, tolerances, production adapters, workers, frontend, infrastructure or AI. [Verification](verification.md) records executed checks and acceptance evidence.

## What reconciled means

A historical MATCHED outcome proves that **one immutable processor settlement interpretation and one immutable booked bank interpretation correspond under a named mapped source contract**, conserve the same signed minor-unit amount/currency, pass intrinsic controls and have mutually unique reference candidates in their frozen population. It is scoped evidence of correspondence, not source authentication, overall economic completeness, internal authorization or ledger truth. Current reconciliation additionally requires a valid whole-item allocation and fresh proof; historical MATCHED alone must never be advertised as current assurance.

`settlement-bank-exact-v1` requires the explicitly provisioned `synthetic-transfer-reference-v1` contract: processor transfer reference and bank reference identify the same transfer within the mapped accounts. The existing public simulator supplies these independently visible source references. No settlement ID is injected into bank evidence, and no reference is invented to make a match. Contract assertions rely on trusted synthetic adapters/administration; this is not an approved production integration.

## Packages and scope

`@flow/reconciliation-domain -> money + ingestion-domain` contains exact pure rule contracts, evidence evaluation and command validation. `@flow/reconciliation-postgres -> reconciliation-domain + pg` implements controlled SQL stages and recovery. SQL owns final confirmation/allocation rules; differential pipeline tests exercise the same documented predicates. No external dependency/version changes. Lower financial/source/domain packages cannot import reconciliation. Runtime reconciliation cannot import oracle or ledger persistence.

An immutable offline-provisioned account mapping fixes book/environment, processor source account, bank source account/currency and reference contract. Source FKs already carry provider/external-account/environment scope. Bank identity is the Phase 5 source account + currency tuple even before a bank account projection exists. Phase 6 deliberately supports one processor source per bank source/currency and vice versa; many-provider destinations and mapping changes need a later explicit policy. Mapping is configuration, not an automatic discovery rule. Separate non-owner reader/writer roles have no ledger posting or source-domain write capability.

Each run supplies a semantic key, mapping, rule, half-open UTC `[from,to)` window applied independently to processor report time and bank booking time, virtual effective time and actor. Effective time is evaluation metadata; database snapshot time determines received evidence. Prior pending populations must be included by the caller's window; no unseen carryover is silently claimed. Currency mismatch belongs to a separate account/currency scope and leaves the scoped counterpart unmatched. Empty populations are allowed. The implementation rejects more than 2,000 total domain items rather than truncating the denominator; this is a bounded developer workflow, not a scale benchmark.

## Frozen population, candidates and outcomes

Population capture uses a REPEATABLE READ transaction. Actual immutable domain facts are grouped by stable scoped source identity; any historical variant inside the time/currency scope retains that item, even if current source selection is ambiguous. Bank evidence without authoritative source identity uses its explicitly observation-only revision identity and is ineligible. A missing/uninterpreted correction retains the earlier item with ambiguity/pending reasons. Brand-new raw/failed normalized records without a processor/bank domain fact remain Phase 3 processing coverage, not fabricated movements; runs claim only the scoped interpreted-domain population.

The manifest persists actual input identities, full selected/history/control snapshots, version/provenance IDs, counts and SHA-256 of canonical PostgreSQL JSONB population. Relational members retain typed settlement/entry FKs where selection is available. Amounts are canonical strings. Source/normalizer/interpreter/rule changes cannot refresh old members. Reproduction needs original evidence, historical rule/source and pinned lockfile.

Candidates allocate nothing. An edge exists only for exact reference/currency and temporal plausibility. Historical variants of ambiguous items can expose competing references without selecting a preferred revision. Amount/direction/control checks are persisted separately, so an equal reference with the wrong amount remains a rejected candidate. No amount-only candidate can confirm. A candidate for either side must be the sole candidate at **both** ends; ineligible or wrong-amount reference collisions also prevent an arbitrary choice.

The immutable plan partitions every frozen input into MATCHED, UNMATCHED, AMBIGUOUS or INELIGIBLE. MATCHED needs all proof checks, eligibility and mutual uniqueness. UNMATCHED means absent counterpart or failed exact rule checks. AMBIGUOUS means multiple plausible reference edges at either end. INELIGIBLE retains named reasons. A separate outcome row records each durable result; completion requires exact coverage. Candidate counts, item counts and group counts are distinct.

## Exact proof and controls

Accepted proof names currencyExact, amountExact, directionCompatible, referenceExact, bookingWindowValid, processorEligible, bankEligible, accountMappingValid and mutualUnique. It retains mapping/rule/population hash, selected processor/bank evidence IDs, exact reference, signed amount/currency, report/booking/value dates and complete domain control snapshots. The temporal policy is fixed elapsed UTC booking in inclusive `[processor reported_at, reported_at + 72 hours]`. Value date stays separate evidence and does not silently replace booking. This synthetic rule has no business-day calendar or configurable scoring.

Signed processor expected net must equal independently reported net and signed bank flow. Bank CREDIT contributes positive magnitude; DEBIT contributes negative magnitude. Zero settlements cannot match a movement. Exact Phase 1 Money is reused; SQL uses BIGINT for individual flows and NUMERIC for aggregates, TypeScript uses bigint, JSON uses strings. A one-minor-unit mismatch never matches.

All processor settlement/payment composition control failures block automatic proof, including missing/pending/ambiguous activities, duplicate/conflicting/cross-currency membership, invalid signs/parents, refund bounds and net disagreement. Controls are freshly recomputed and frozen, not read from a stale PASS evaluation.

Bank eligibility requires identified unambiguous booked evidence and reference. Associated statement reports are freshly evaluated: every intrinsic failure blocks those associated entries, including ambiguous/conflicting association, count/reference/sequence coverage, currency/ordering and balance mismatch. Declared membership with no statement report blocks. Unrelated statement failures do not block bare booked entries. UNKNOWN statement/source coverage alone is not fabricated completeness and does not defeat an otherwise explicit transfer identity proof. Proven incomplete acquisition of required evidence blocks it. Malformed raw/normalization inputs retain Phase 3 dispositions and do not become bank movements.

Run completion proves processing coverage of its frozen domain population only. Period source completeness remains UNKNOWN: source acquisition/statement assertions have narrower meanings and are retained independently; received counts never prove no unseen transfer.

## Stable allocation and history

A reconciliation item is one source fact, globally unique regardless of revision, normalizer, interpreter or run. Observation-only bank revisions have a distinct, explicitly ineligible identity. Restricted registration validates origin kind; no caller-selected facet can create another allocatable view of the same payout or bank movement.

Immutable match groups and role-bearing members provide an extensible grouped representation; Phase 6 guards allow exactly one PROCESSOR_SETTLEMENT and one BANK_MOVEMENT with the same whole signed amount/currency. Future shapes require a reviewed new rule/migration; grouped algorithms are not implemented.

`current_allocation` reserves each stable item once in settlement_bank scope across all runs. Its primary key and typed member FK are final barriers. `active_allocation` exposes only valid current proof. Current validity rechecks selected versions, relevant domain controls, exact proof and mutual uniqueness against current evidence in the historical scope. A correction or relevant late contradiction immediately makes current assurance INVALIDATED without changing historical results. There is no latest-receipt preference.

A later run retires invalid reservations with append-only INVALIDATED decisions. Reconfirming the same valid pair creates a new historical group, atomically SUPERSEDES the previous allocation with a successor link and installs the new reservation. Stale frozen proofs stay historical MATCHED with STALE activation, never active. A competing occupied item yields explicit CONFLICT activation, never silent overwrite. Completed replay does not restore old allocations. Historical counts/value evidence stay fixed; current activation status is a separate changing read projection.

## Transactions, concurrency and recovery

1. Create: READ COMMITTED, book lock, unique mapping/run key and canonical configuration comparison. Actor is excluded from semantic command identity; the first accepted actor remains attributable.
2. Freeze: REPEATABLE READ, run row lock, stable economic registration, full immutable manifest/member population, seal atomically. An interrupted seal leaves durable DRAFT.
3. Plan: READ COMMITTED, run lock, deterministic candidates and complete immutable outcome plan, RUNNING atomically. Interrupted planning leaves SEALED.
4. Advance: bounded 1–100 pending-plan items per transaction (a matched pair persists together, so a batch can exceed the requested input count by one). Book NO KEY UPDATE lock (compatible with unrelated book FK readers), sorted source-account locks shared with ingestion/domain writes, run lock; group/members/outcomes/current allocation and audit/outbox commit together. Failed progress leaves prior durable outcomes, never a half match.
5. Complete: run lock, full coverage check and completion intent in one commit. A crash cannot advertise completed before durable outcomes/companions.

All current state writers follow one lock order. Book-level serialization is deliberately conservative for this bounded slice; no scale claim. Uniqueness remains the final concurrency barrier. REPEATABLE READ conflict/deadlock SQLSTATEs retry the whole original stage, up to five attempts; no new identity is generated. Lost COMMIT acknowledgement raises UnknownReconciliationCommit; retry the same run/stage on a healthy connection. Incomplete DRAFT/SEALED/RUNNING runs are queryable and resumable. No unattended claims/leases/worker system is introduced.

PostgreSQL guards prevent immutable update/delete/truncate, late membership/candidate/plan insertion, forged evidence/contributions, partial groups, unaudited release and falsely completed runs. Runtime permissions expose six narrow commands and read summaries only; fixed SECURITY DEFINER search paths are `pg_catalog,pg_temp`. Owners/superusers remain an operational trust boundary.

## Audit, outbox and metrics

Every accepted historical group has an immutable initial allocation decision ACTIVE/STALE/CONFLICT with required typed audit and existing-outbox intent. SUPERSEDED/INVALIDATED decisions also require typed audit/intent in the allocation transaction. Audit identifies actor, actual DB principal, causing run/rule, group and linked full proof. Pure candidates and non-match outcomes are operational/provenance evidence, not high-volume financial audit. Completion has one existing-outbox intent. No new broker or publishing architecture.

`operational_metrics` and `summary` provide run counts/status/duration, processor/bank population, candidate and historical matched-group counts, unmatched counts per side, ambiguous/ineligible input counts, conflicts and incomplete runs. Per-currency/side/outcome exact values are separate strings; unknown amounts are never coerced to zero and unknownValueCount records their count. Historical reconciled value is distinct from active allocation assurance. A host can export reconciliation_runs_total and aggregate these dimensions; no metrics stack is deployed.

## Developer workflow

```sh
pnpm simulator generate --seed 828192 --payments 100 --out /tmp/phase6-public
# Existing migration/bootstrap workflow provisions synthetic book, source accounts,
# immutable account_mapping and separate ingestion/processor/bank/reconciliation logins.
DATABASE_INGESTION_URL=<local-ingestion-runtime-url> \
DATABASE_PROCESSOR_URL=<local-processor-runtime-url> \
DATABASE_BANK_URL=<local-bank-runtime-url> \
DATABASE_RECONCILIATION_URL=<local-reconciliation-runtime-url> \
  pnpm reconciliation /tmp/phase6-public/input.json <book-id> run-1 <mapping-id> \
  2026-01-01T00:00:00.000Z 2026-01-10T00:00:00.000Z
```

The CLI invokes the existing public processor/bank ingestion path, validates the provisioned mapping against that scope, reconciles and prints separate processor, bank and reconciliation summaries. It cannot create an account mapping from amount/reference similarity. Runtime receives no oracle. Only the separate test evaluator reads oracle after runtime execution to count true/false positives. Default full `pnpm verify` preserves every prior regression gate. Optional explicit integration test paths use the same disposable PostgreSQL/migration/role runner for focused development.

## Deferred and assumptions

Phase 7+ grouped algorithms, partial allocations, manual review/revocation policy, exception product, production reference/ordering/authentication/mapping approval, real calendars, authoritative revision selection, ledger orchestration, worker/lease/publisher/consumer infrastructure, UI/cloud/AI, large-volume performance and production security/restore readiness. Synthetic scope IDs/reference contracts and configuration provisioners are trusted. No commit, push or deployment. [ADR-013](../architecture/adr/013-exact-reconciliation.md) records the concrete historical/current split.
