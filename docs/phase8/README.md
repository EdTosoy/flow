# Phase 8: operational exception management

Synthetic scope only. An exception is an operational case for unresolved settlement-bank evidence. Reconciliation answers what a named engine rule proved; exceptions answer what operators did about it. `RESOLVED` never implies money reconciled. No exception routine writes reconciliation, source facts or ledger tables.

## Ownership and identity

`exception-domain` depends only on Money. `exception-postgres` depends on the exception contracts and existing pg. PostgreSQL composition connects the domains through restrictive evidence FKs and read functions; there is no exception/reconciliation package dependency in either direction. No new external dependency.

The stable case identity is `(account mapping, canonical reconciliation item)`, for the `settlement_bank` relationship. One lifetime case per item is deliberately conservative. Separate processor and bank items can each have a case for one relationship problem. Case counts are operational item counts, not unique economic discrepancy counts. Repeated outcomes and later runs attach immutable occurrences to this same case. Version/source/rule/run IDs do not create parallel open cases. An original run/outcome link never changes.

Generation is an explicit synchronous command over a completed run. All UNMATCHED, AMBIGUOUS and INELIGIBLE outcomes are reviewable within this bounded synthetic scope. Historical MATCHED outcomes with no fresh current allocation create CURRENT_PROOF_INVALIDATED cases; a fresh successor allocation prevents that generation. No latest-run or receipt-order financial authority is inferred. Generating an old unresolved run still records its historical cause even if later money currently matches; current proof is shown separately, and verified closure is explicit. No unattended sweep or worker exists.

Each occurrence references the exact run/outcome/item. Those immutable FKs transitively preserve rule/version, mapping, frozen processor/bank interpretation, raw/revision/normalizer provenance, intrinsic controls, pair candidates, complete grouped candidates and group/membership evidence. The stored condition is compared as full JSONB, not just a hash or mutable summary. Original evidence stays available after corrections and new runs.

## Workflow and history

The Phase 0 terminology is retained:

```text
OPEN -> UNDER_REVIEW -> AWAITING_EVIDENCE -> UNDER_REVIEW
UNDER_REVIEW -> RESOLVED
RESOLVED -> UNDER_REVIEW (changed unresolved evidence, explicit reopening)
```

SUPERSEDE is an explicit RESOLVED → RESOLVED decision with fresh later MATCHED evidence: it appends FIXED_AND_VERIFIED while retaining the earlier resolution. Every other lifecycle transition is illegal. Notes/attachments may append in any state; classification/assignment changes require an unresolved case. Each decision increments a version and appends an immutable event. Current case state is a read projection of the last event, not unrelated booleans. A reviewer supplies the expected version; competing stale decisions reject with P8005. Reasons and synthetic actor IDs are mandatory. A trusted host must authorize actors before real-data use; this phase has database capability separation, not identity management or two-person production approvals.

A new completed unresolved condition reopens a resolved case automatically during explicit generation only if its complete condition has never been observed in that case. Identical evidence in a new run is an OBSERVED event and preserves the operational conclusion. Replaying any already-recorded run adds nothing. Explicit REOPEN requires a different completed run and changed unresolved evidence for the same item/mapping. Old resolution reasons, notes and evidence never change. Because source revisions are unordered, a correction commonly produces SOURCE_REVISION_AMBIGUITY, never an authoritative latest selection.

Later matching does not delete or silently close a case. An operator starts review and resolves with FIXED_AND_VERIFIED, citing a different completed MATCHED outcome whose exact group is still the current fresh allocation. For an already resolved accepted-risk or other conclusion, an explicit SUPERSEDE decision records FIXED_AND_VERIFIED and the later exact outcome without reopening a financially fixed condition. The old resolution stays in its original event. This is operational supersession with a preserved later-evidence link, not a new match. A superseded historical group cannot justify closure. Subsequent contradictory evidence makes current reconciliation false immediately through existing freshness checks; generation over a new unresolved run reopens the case. Polling/scheduling is deferred.

## Classification and exposure

Deterministic initial classes are MISSING_BANK_MOVEMENT, EXTRA_BANK_MOVEMENT, AMOUNT_MISMATCH, AMBIGUOUS_MATCH, PROCESSOR_INCONSISTENCY, BANK_INCONSISTENCY, SOURCE_INCOMPLETENESS, SOURCE_REVISION_AMBIGUITY, DUPLICATE_EVIDENCE, UNSUPPORTED_CASE and CURRENT_PROOF_INVALIDATED. TIMING_LATE_ARRIVAL is available for attributed human classification. Missing/extra describes the frozen received population, not proven source completeness or an independently authorized missing obligation. Ambiguity precedes arithmetic guesses. The original deterministic classification remains in each occurrence even after a human override; changes have events/audit.

Exposure is a nonnegative existing Money magnitude plus explicit mapped currency, or null with an exposure reason:

| Cause                                                                           | Exposure                                             |
| ------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Eligible unmatched settlement, no reference candidate                           | Absolute whole reported signed settlement            |
| Eligible extra bank movement, no reference candidate                            | Absolute whole booked signed movement                |
| Exactly one eligible pair with amount disagreement and no competing counterpart | Absolute exact processor-bank residual               |
| Ambiguous 1:1 or grouped match                                                  | Unknown; no arbitrary counterpart or sum             |
| Failed/grouped discrepancy without a unique eligible pair                       | Unknown                                              |
| Ineligible processor/bank or invalidated current proof                          | Unknown; stale/unsupported amounts are not assurance |
| Magnitude/residual exceeds Money's signed BIGINT maximum                        | Unknown with MONEY_MAGNITUDE_OUT_OF_RANGE            |

Pair residual can appear on both sides. Metrics always partition currency **and side**; never add processor and bank exposure together or aggregate across currencies. Grouped members are whole-item identities; unknown aggregate exposure is not fabricated from convenient subsets. Individual exposure stays BIGINT/Money; aggregate totals use exact NUMERIC strings. Classification never changes arithmetic. Unknown exposure counts accompany every subtotal.

## Resolution dispositions

Every resolution is operational. None creates a current allocation, changes a reconciliation outcome or automatically posts accounting.

| Reason                         | Meaning / subsequent action                                                                                                              |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| SOURCE_CORRECTION_REQUIRED     | Source repair required; new run after new evidence. Can instead await evidence if the operator wants the case open.                      |
| PROCESSOR_FEE_CONFIRMED        | Human documented interpretation; unchanged proof. Separate approved accounting if needed; new run for any future proof.                  |
| TIMING_DIFFERENCE              | Informational operational explanation; later arrival needs a new run.                                                                    |
| DUPLICATE_SOURCE_RECORD        | Documented duplicate claim; no evidence deletion/deduplication or release of allocations. Any financial reconsideration needs a new run. |
| ACCEPTED_RISK                  | Close operations while discrepancy stays unreconciled and exposed.                                                                       |
| ACCOUNTING_ADJUSTMENT_REQUIRED | Separate accounting command/approval required; no ledger write here. New run only after independently recorded evidence.                 |
| NOT_RECONCILED                 | Explicitly close review with no reconciliation claim.                                                                                    |
| UNSUPPORTED_SOURCE             | Cannot prove under supported source contract; coverage remains unknown.                                                                  |
| OTHER                          | Informational reason mandatory; no authority to match.                                                                                   |
| FIXED_AND_VERIFIED             | Operational closure cites already-existing fresh later-run proof. Creates no allocation; exact current allocation must already exist.    |

MANUAL_MATCH_APPROVED is intentionally unsupported. Phase 6/7 proof admits only named deterministic contracts and has no safe independent manual-reference approval model. Manual reconciliation, manual allocation/revocation and accounting action remain deferred rather than weakening conservation, ambiguity or global allocation uniqueness.

Accepted risk is valid with historical UNMATCHED. Exception reporting has no reconciled-value total. Accepted-risk exposure remains in unreconciled exposure until an actual fresh engine allocation exists; existing reconciliation value/current reporting does not consult exception status. Historical resolution remains visible after a later match.

## Notes, attachments, assignment and aging

NOTE events append author, DB timestamp and bounded text; no update/delete. Text is operational context, never source proof. Do not submit secrets or unnecessary personal data. Arbitrary uploads are absent. ATTACH supplies one typed FK reference: processor activity/settlement, bank entry, reconciliation run/group, existing processor/bank control evaluation or raw source record. FKs and scope guards validate the mapped accounts; run/group attachments require the same mapping. An attachment cannot change a rule or allocation. Frozen intrinsic controls are also retained transitively through the causing run snapshot without manufacturing additional evaluations.

Assignment is an optional synthetic actor ID or null; changes are versioned decisions. Priority, configurable SLA thresholds, reminders, escalation and scheduling are deferred. Case creation, every event time, first review, state-entry time and resolution events support age, time in state, first-review latency and resolution duration, including each reopen cycle from the event stream. Time is database transaction time, not an exact COMMIT timestamp or financial source ordering.

## Transactions, concurrency and enforcement

Migration 007 adds case_record, event, occurrence and attachment in a dedicated schema, plus read projections/metrics. It adds typed exception-event companions to the existing audit/outbox union while preserving earlier constraint branches and histories. Existing migrations/rules are unchanged.

Generation atomically commits all new cases/occurrences/decisions, audit and intent for one bounded completed population. Each human command commits one event, optional evidence/note, and audit/outbox together. Database deferred guards reject orphan cases, missing occurrence/attachment and missing companions. No external dual write. The lock order follows existing reconciliation: book NO KEY UPDATE, sorted ingestion source rows, case row. This serializes fresh-proof closure against ingestion and allocation advances; no source/network/human wait is inside a transaction. READ COMMITTED plus locks and database uniqueness is deliberate; no global SERIALIZABLE.

Logical case uniqueness, `(case,version)`, `(case,command key)` and `(case,run occurrence)` are final barriers. Full command JSONB is retained and compared; conflicting key reuse is P8001. Actor/reason are part of a human decision identity. Same successful command replays its original event version even after later state changes, plus a fresh separately labeled current-proof read. The outcome: command namespace is reserved for generation. The adapter snapshots command bytes before awaiting and retries whole transactions on 40001/40P01 up to five total attempts. Unknown COMMIT raises UnknownExceptionCommit; retry the unchanged identity on a healthy connection. No new command key per retry.

Immutable UPDATE/DELETE/TRUNCATE guards cover all exception history. Immediate guards validate event chains/fields/legal transitions, immutable occurrence derivation/exposure, typed attachments and companion scope/decision details. Deferred guards enforce complete decisions and creation. Narrow SECURITY DEFINER commands have fixed pg_catalog,pg_temp search paths and schema-qualified objects; runtime roles cannot mutate base tables, post ledger or change reconciliation/allocation. Owners/superusers remain trusted.

Every decision, including notes and observed evidence, writes attributable existing audit with previous/new state, actor/session principal, reason/policy and typed immutable event reference. Full reason, resolution, command, classification, evidence and assignee are retained in the event. Existing audit reason is capped at 512 characters; full operational reason is in the referenced event. Outbox event kinds are exception.created/resolved/reopened/updated, with immutable decision references. No publisher, consumer, broker, lease or worker infrastructure.

## Metrics and developer workflow

`operational_metrics` and `summary(mappingId)` expose counts by state/class; created/resolved/reopened event totals; unreconciled exposure and accepted risk by currency/side; unknown count; oldest unresolved age; exact numeric median observed resolution duration; and zero manual-reconciliation total. Counts are operational cases/decisions; reclosures count separate resolution events. Read-time current proof is independent of workflow state and is never cached as financial assurance. A closed operational conclusion does not suppress financial exposure.

```sh
pnpm exceptions pipeline <public-input> <book-id> <run-key> <mapping-id> <from-UTC> <to-UTC> [--grouped]
pnpm exceptions generate <completed-run-id>
pnpm exceptions apply <command-json-file>
pnpm exceptions summary <mapping-id>
```

The existing ingestion/processor/bank/reconciliation runtime URLs plus DATABASE_EXCEPTION_URL supply separate provisioned logins. The pipeline composes existing public source processing, reconciliation, explicit generation and summary. `apply` uses the current expected version and a stable command key. Normal output contains public runtime results only, no oracle truth or private anomaly labels. `simulator-exceptions` verification alone reads oracle truth after execution. Existing boundary checks deny runtime oracle imports/transitive dependencies.

Mechanisms checked against pinned PostgreSQL 18: [row locks](https://www.postgresql.org/docs/18/explicit-locking.html), [deferred triggers](https://www.postgresql.org/docs/18/sql-createtrigger.html), [restricted function security](https://www.postgresql.org/docs/18/sql-createfunction.html). Executed results belong in [verification](verification.md).

Deferred: manual matching, production authentication/two-person approvals, priority/SLA policy/reminders, unseen-obligation or Phase 9 period completeness/control-total expansion, arbitrary uploads, exceptions for raw records without a reconciliation outcome, accounting orchestration, asynchronous infrastructure, frontend, real integrations, cloud and AI. Phase 9 is not started.
