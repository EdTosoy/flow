# Financial invariant catalog

These are acceptance requirements, not implemented guarantees. DB means PostgreSQL under the runtime role; DB owners/superusers remain a privileged trust boundary. The [transaction design](transactions-and-outbox.md) defines controlled routines, guards, and retry semantics. A monitor detects corruption; it does not replace write-time prevention.

Phase 1 implements/verifies INV-001/002/003/009 and the ledger-creation portions of INV-006/016. Phase 1 realizes INV-008 as atomic durable outbox intent; Phase 10 adds the explicitly scoped internal normalization delivery/recovery worker boundary below. All source/reconciliation/AI/control-projection requirements remain future gates. The [Phase 1 acceptance evidence](../phase1/verification.md) defines the exact verified boundary, including conservative reversal scope and actual database permissions.

For each invariant below: purpose, enforcement (database and application), test, and failure signature are explicit. PBT means property-based tests; all constraints/locking tests execute on real PostgreSQL.

## INV-001 — Posted accounting is immutable

- **Why:** historical truth and corrections must remain reconstructable.
- **DB:** runtime roles cannot directly UPDATE/DELETE journals or entries; guard triggers reject mutation, including inserting entries into already-posted journals. Accounting fields and posting/effective dates are frozen. Restrictive FKs prevent cascading deletion. A narrowly scoped posting routine is the permitted write path.
- **Application:** correct with a linked full reversal and replacement; descriptions affecting interpretation are new annotations, not edits.
- **Test:** PostgreSQL tests attempt every mutation under runtime roles and controlled routines; PBT proves reversal restores original account deltas without changing originals.
- **Failure:** old report changes without new journals, entries added to a posted journal, or original payload/hash differs.

## INV-002 — Every posted journal balances and is complete

- **Why:** partial or unbalanced postings manufacture or lose value.
- **DB:** positive BIGINT entry amounts, debit/credit enum, currency/book composite FKs; at least two entries and sum(debits) = sum(credits) enforced by a deferred constraint trigger at commit. Trigger the journal insertion as well as entry changes so a zero-entry journal cannot escape. Serialize entry changes/posting on the journal parent. V1 journal currency is singular. No committed incomplete journal is permitted.
- **Application:** prevalidate account activity and posting policy, then create the entire journal in one transaction. No externally visible draft ledger records in V1.
- **Test:** PBT generates balanced/unbalanced journals including overflow edges; real DB multi-session tests and rollback tests reject all partial states. Independent verifier recomputes balances from entries.
- **Failure:** journal has fewer than two entries, cross-currency entries, orphan entries, or nonzero debit-minus-credit.

## INV-003 — One semantic financial effect per business-effect key

- **Why:** delivery deduplication alone misses the same fact delivered by different channels.
- **DB:** unique NOT NULL `(book_id, effect_namespace, business_effect_key)` for posting outcomes, plus unique client command keys and per-handler event receipts. The journal stores a canonical request hash. Constraint conflicts cannot silently accept a different amount/account mapping.
- **Application:** key represents capture/refund/fee/payout action, not webhook ID or normalizer/rule version. A source event may legitimately contain several distinct effect kinds; each kind has one key. Different upstream IDs for one real-world effect require source-specific canonical identity mapping or an explicit ambiguity exception.
- **Test:** 100 concurrent deliveries through webhook/file/poll variants; PBT permutations/retries give the same journal set. Conflicting key payload must fail visibly.
- **Failure:** repeated capture or fee, or silently returning old success for changed payload.

## INV-004 — Imported evidence has immutable, retrievable provenance

- **Why:** interpreted facts must be traceable to what was actually received.
- **DB:** raw bytes/text, checksum, source account, batch/receipt, locator, ingestion time, external identifier when available, and parser version are mandatory; append-only raw and normalized facts. Unique batch locator preserves each row. Source revision identity binds to one content hash; conflicting content is quarantined as a new observation, never overwritten.
- **Application:** verify checksums, preserve malformed rows and rejected envelope evidence, keep signed webhook body before interpretation. Hashing JSON after parsing is insufficient to prove received bytes. Access-controlled representation must remain available for its retention period.
- **Test:** replay files/bytes, corrupt checksum, mutate provenance, alternate parser versions, and conflicting revisions. PBT round-trips amount lexemes losslessly.
- **Failure:** no original row, irreproducible interpretation, or upstream change rewrites old evidence.

## INV-005 — Reconciled requires explainable deterministic evidence

- **Why:** a convenient match must not hide a discrepancy.
- **DB:** confirmed group requires evidence and approved rule version, currency/book consistency, valid membership, conservation equation, and current allocation uniqueness. Cross-row validation runs in a controlled confirmation transaction; ordinary CHECK cannot prove the rule.
- **Application:** evaluate relationship-specific references, amounts, timing, completeness and ambiguity guards; reject unexplained residuals. Confidence scores do not authorize confirmation. A manual accepted-risk disposition stays unreconciled.
- **Test:** PBT shows wrong currency, residual, missing member, unrelated reference, or ambiguity never confirms; positive deterministic fixtures do confirm. Check manual paths use the same guards.
- **Failure:** unmatched fee vanishes into tolerance, or equal amounts in a date window are treated as sufficient identity.

## INV-006 — Material decisions are attributable and atomic with audit

- **Why:** reviewers must reconstruct who changed what and why.
- **DB:** append-only audit rows contain actor/service identity, action, entity, previous/new state, DB timestamp, reason, evidence references, correlation/command ID and policy version. Restricted transition routines write decision and audit in the same transaction; no path may commit a decision without audit.
- **Application:** authorization and reason/evidence requirements for confirmation, supersession, closure, reopening, requeue, corrections and rule activation. Two-person approval for accounting correction and acceptance of discrepancies before real-data use.
- **Test:** fault between audit and state mutation rolls both back; unauthorized commands fail; PBT transition sequences have corresponding audit events.
- **Failure:** untraceable manual closure or audit says success for a rolled-back decision.

## INV-007 — Untrusted automation cannot independently assert financial truth

- **Why:** suggestions and plausible text are not evidence or accounting authority.
- **DB:** no AI principal has posting, confirmation, closure, or money-movement privileges. Separate credentials and allowed read views if introduced.
- **Application:** AI is deferred. Later outputs are labeled suggestions, require verified source links, and go through ordinary human/control workflows. No invented record accepted as external evidence.
- **Test:** capability/authorization tests and adversarial suggested commands cannot reach financial writes.
- **Failure:** model output closes a discrepancy, bypasses controls, or fabricates a source fact.

## INV-008 — Accepted asynchronous work is durable and recoverable

- **Why:** process death must neither lose financial work nor duplicate it.
- **DB:** state + outbox intent commit together; unique work identity, expiring claim generation, persistent attempts and receipts. Failure/retry/blocked rows are retained. Done status and local consumer effect commit atomically.
- **Application:** lease recovery, bounded backoff, explicit blocked cases, periodic work/completeness sweep independent of notification success. Operational requeue preserves identity and history.
- **Test:** kill workers before/after claim, effect, commit and publication; stale lease generation cannot commit; replay blocked work safely.
- **Failure:** old work permanently leased, acknowledged but not posted, or missing outbox for a committed change.

## INV-009 — Money is exact, unit-aware, and bounded

- **Why:** binary rounding, unit confusion and overflow cause systemic errors.
- **DB:** monetary amounts use BIGINT minor units plus a required currency FK; explicit bounds and side/direction checks. Aggregate SUM uses exact NUMERIC. Fractional rates use a declared NUMERIC precision/scale and reject NaN/infinities; no FLOAT, REAL, DOUBLE PRECISION or PostgreSQL MONEY for financial values.
- **Application:** TypeScript bigint; JSON monetary fields are base-10 integer strings, never Number. Parse source numeric tokens losslessly before any Number conversion. Currency scale comes from versioned allowlisted metadata, not “all currencies have two decimals.” Rounding mode and residual allocation must be specified for every conversion; initial V1 performs no FX.
- **Test:** PBT algebra, parser bounds, addition across currencies rejected, zero/three-decimal currency fixtures, signed rounding ties, negative refunds, BIGINT limits and JSON round trips.
- **Failure:** one-unit drift, silently rounded large IDs/amounts, scale mismatch or overflowing write.

## INV-010 — Every run has a complete, immutable input population and explicit outcomes

- **Why:** selecting only easy matches creates a misleading success rate.
- **DB:** unique `(run_id, item_id)` membership; immutable sealed population, counts/hash/totals and source revisions. Each member has a durable current outcome with append-only decisions. Finalization routine verifies every member has an explicit outcome and frozen counts/totals agree.
- **Application:** include internal expectations as well as received evidence, unknown/unsupported observations, and prior pending items in scope. Pending, exception, under_review, reconciled, and resolved_unreconciled are explicit outcomes. Failed/cancelled runs cannot masquerade as completed. Late facts create a new run.
- **Test:** interrupted/resumed runs, late arrival during seal, filter manipulation, PBT partition count/value conservation; 9,999 received does not prove 10,000 expected.
- **Failure:** unseen/unassigned members disappear from denominator or run reports all reconciled while coverage is unknown.

## INV-011 — Source coverage claims require independent evidence

- **Why:** receipt counts and checksums cannot establish missing upstream records.
- **DB:** immutable source manifest/coverage scope stores expected row count, distinct identity count, currency totals, sequence range/cursor closure, checksum and external closing balance when available. Verified state requires a successful control evaluation; mismatches have a case.
- **Application:** distinguish verified, unverified, and discrepancy. Count physical rows, malformed rows, repeated business IDs and distinct facts separately. Without an external manifest/closing watermark, say “received population complete,” not “source complete.” Silence from a webhook source is never proof of completeness; schedule independent pulls.
- **Test:** missing row, duplicate masking missing row, truncated page, unexpected row, wrong checksum, missing manifest; source-control queries bypass normalized projections.
- **Failure:** 9,999/10,000 batch marked verified, or duplicated row conceals a missing identity.

## INV-012 — Every received record has a processing disposition

- **Why:** a parse failure is itself an exception-worthy fact, not a skipped row.
- **DB:** raw receipt and normalization work/disposition created atomically; unique receipt processing identity. Allowed states are pending/retry, succeeded, duplicate-linked, or blocked with a case; work attempts are durable.
- **Application:** sweep `received = pending + succeeded + duplicate-linked + blocked` per batch/version. Unsupported record types remain blocked or explicitly classified nonfinancial with rationale; do not use an “ignored” bucket.
- **Test:** parser dies on row N, invalid last row, unknown currency, duplicate receipt, replay parser; every receipt still counted.
- **Failure:** raw rows without work/outcome, or rejection not represented in batch controls.

## INV-013 — Economic coverage cannot be consumed twice in one relationship

- **Why:** one bank credit must not settle two payouts or one charge appear twice in one payout composition.
- **DB:** current allocation PK `(item_id, relationship_scope)` across runs, restrictive membership FKs, locks on stable item identity. Restricted item registration enforces canonical economic component identity: a bank/normalized projection cannot create another item for the same source fact, and gross/net views cannot duplicate resources. Whole-item allocation only in V1. Revocation and replacement of claims are atomic and audited.
- **Application:** distinct scopes allow the same fact to be checked against internal activity, ledger, settlement composition and bank receipt without double counting. Facets do not provide a loophole to consume the same economic component twice within a scope.
- **Test:** racing confirmations and reopening across runs; PBT allocation conservation. No arbitrary partial allocations until a cumulative amount guard is implemented.
- **Failure:** identical bank credit appears in two active settlement matches.

## INV-014 — Revisions and rule changes never rewrite historical conclusions

- **Why:** a historical decision must remain reproducible while current conclusions can change.
- **DB:** immutable source/normalizer/rule versions and run snapshots; new decisions link to superseded decisions. Current revision pointers and allocations change only under locks, with audit/outbox.
- **Application:** corrections invalidate affected current assurance and schedule reevaluation; no automatic new financial effect just because a parser version changed.
- **Test:** replay old run, activate new rule, correct amount/reference, reject competing revision activation; history remains byte-equivalent.
- **Failure:** yesterday's run changes in place or replay silently posts the capture again.

## INV-015 — Independent aggregate financial controls remain explicit

- **Why:** balanced journals and individually matched rows can all be consistently wrong.
- **DB:** evaluations bind to book/account/currency/period, independent external control evidence, observed counts/totals, formula/rule version, cutoff and result. Missing evidence is unverified, never a pass. Failures persist as exceptions.
- **Application:** compare opening + signed movements = computed closing to an independently supplied closing; reconcile processor receivable, in-transit and bank balances. Do not derive both sides from the same normalized rows. Suppress cancellation of positive/negative residuals by tracking counts and gross exposure separately.
- **Test:** systematic sign error, omitted fee class, stale projection and two offsetting missing records; control must fail or be explicitly unverified.
- **Failure:** zero net discrepancy conceals two large opposing discrepancies or self-derived total passes itself.

## INV-016 — Financial scope and approval boundaries cannot be crossed

- **Why:** same currency/reference across different accounts/books does not establish identity, and operators can make consequential errors.
- **DB:** book/source-account composite keys and FKs prevent cross-book journal/member links; fixed account currency; runtime roles cannot alter controls or source evidence. Approval records bind to command payload hash and version.
- **Application:** enforce scoped authorization, source-account identity, distinct reviewer where required, safe evidence rendering, and separation of importer/normalizer permissions from ledger posting permissions.
- **Test:** hostile cross-book links, stale approval, unauthorized reversal/match, mass assignment and malformed evidence inputs.
- **Failure:** source record from another account matches or posts, or approval authorizes a changed correction.

## INV-017 — Authoritative results declare their freshness and coverage

- **Why:** a stale green UI can silently mislead while underlying controls fail.
- **DB:** projection checkpoints identify committed input/work processed, rule version and evaluation time; authoritative facts never depend on a projection.
- **Application:** dashboards show as-of time and coverage independently from match rate. Stale or unavailable health signals produce unknown/degraded status. Rebuild projections from immutable facts without posting again.
- **Test:** stop projector/check scheduler, restart and replay; UI cannot report current assurance from stale data.
- **Failure:** expired projection or missing verifier heartbeat is displayed as healthy.

## Acceptance mapping

| Control boundary | Invariants |
| --- | --- |
| Source completeness | INV-004, INV-011, INV-014 |
| Processing completeness | INV-008, INV-012 |
| Ledger integrity | INV-001, INV-002, INV-003, INV-009, INV-016 |
| Reconciliation completeness | INV-005, INV-006, INV-010, INV-013, INV-014 |
| Independent financial totals | INV-009, INV-011, INV-015, INV-017 |
| Human/automation trust | INV-006, INV-007, INV-016 |

Database enforcement of domain rules uses the smallest explicit controlled routines/triggers that protect the stated boundary. PostgreSQL documents that a [CHECK cannot guarantee cross-row constraints](https://www.postgresql.org/docs/18/ddl-constraints.html); a CHECK invoking a hidden aggregate query is therefore not an acceptable balance implementation. Deferrable [constraint triggers](https://www.postgresql.org/docs/18/sql-createtrigger.html) can validate transaction-end state. Exact types alone are also insufficient: [NUMERIC accepts special values and has specific rounding behavior](https://www.postgresql.org/docs/18/datatype-numeric.html), so validation and declared rounding remain necessary.

## Phase 6 implemented proof boundary

Phase 6 realizes the synthetic 1:1 settlement_bank slice of INV-005/010/013/014 and decision portions of INV-006/016: named exact evidence, frozen populations/complete outcomes, stable source-fact allocation uniqueness and immutable historical proof. Current read checks invalidate changed evidence conservatively; controlled reevaluation writes retirement/supersession audit/intent. Period source completeness, later group shapes and exception/manual workflows are not implied. [Executed acceptance evidence](../phase6/verification.md).

## Phase 9 implemented control boundary

Phase 9 independently evaluates the supported received-evidence portions of INV-002/009/010/011/012/013/014/015/017 without replacing write-time guarantees. Missing independent period evidence stays UNKNOWN. Financial exposure is canonical, excludes case duplication, preserves accepted risk and refuses unproven cross-side addition. Historical frozen evaluations and results remain immutable. [Semantics](../phase9/README.md); [verification](../phase9/verification.md).

## Phase 10 worker boundary

Phase 10 adds immediate durable outbox registration, explicit operational work state, append-only attempts, DB-clock leases, fenced domain writes, bounded deterministic retries and retained terminal failures. At-least-once normalization reuses existing domain idempotency; worker state is never financial truth. Completed domain notifications have no invented local workflow. Manual requeue, external publication, UI/integrations/cloud/AI and later phases remain deferred. See [protocol](../phase10/README.md) and [verification](../phase10/verification.md).
