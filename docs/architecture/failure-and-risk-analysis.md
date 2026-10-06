# Failure scenarios, threats and correctness boundaries

The mechanisms below are design requirements to prove in integration/simulation tests. They are not claims about implemented behavior. See [invariants](invariants.md), [transactions](transactions-and-outbox.md) and [test gates](verification-and-operations.md).

## A. Same processor event delivered 100 times concurrently

1. Authenticate source envelopes and durably accept receipts with byte-preserving provenance. Repeated HTTP requests may have separate receipt locators; retries of the same persisted locator cannot create a second row. Count retransmissions independently from financial facts.
2. Canonicalize scoped source object/revision identity under uniqueness. Same revision/same hash links to existing evidence; same identity/different payload is a conflict case, never ignored.
3. Each normalization stage converges under its unique fact-revision/version/output key. Work may be duplicated in transport; durable event/handler receipt keys converge.
4. If policy authorizes a financial effect, all attempts use the same semantic action key, even if webhook and polled events have different IDs. Unique ledger effect key permits one committed journal. Losing attempts compare canonical request hash and return existing result; conflicting payload is blocked.
5. Journal/effect/audit/outbox/handler completion are atomic. Expect 100 observed deliveries and one financial effect, not 100 journals or deleted evidence. Domain policies decide which effects are permitted; a processor event alone does not create an independent internal expectation.

**Boundary:** different external IDs for the same real-world action require adapter-supported mapping. Without it, flag ambiguity; generic hash deduplication must not collapse legitimate identical-value payments. INV-003/004/008/012.

## B. Worker crashes after inserting financial state, before marking work complete

1. If inserts are uncommitted, PostgreSQL rolls back journal, receipt, audit, outbox and completion together. Claim/started attempt from the earlier claim transaction remains until lease recovery.
2. Recovery expires the lease and records abandonment. New worker gets a new generation and reruns the stable command.
3. If the final transaction actually committed, financial state and local work-done committed together; a lost client acknowledgement is resolved using the command key/receipt.
4. If a legacy path separates local effect and completion commits, it violates the intended boundary; semantic uniqueness still prevents another journal, but that path must be removed rather than normalized as acceptable design.

**Result:** no partial committed journal, duplicate effect, or permanent loss. INV-001/002/003/008.

## C. Worker crashes after commit, before downstream publication

1. Financial write and immutable outbox intent/required work already committed.
2. Polling worker/dispatcher finds uncompleted delivery without depending on the crashed process's memory.
3. Local delivery uses receipt/effect/done transaction; remote publication uses stable event ID and durable receiver deduplication.
4. Crash after remote send/before acknowledgement results in retry/duplicate delivery, never an exactly-once claim. An uncertain non-idempotent remote effect requires investigation and is outside V1.

**Result:** recoverable intent survives; stuck/blocked work alerts. INV-003/008.

## D. Settlement arrives before payment events

1. Import payout and itemized membership exactly as received. Preserve scoped unresolved component references; do not fabricate payments, charges or journal entries to fill the batch.
2. Settlement can be reported/in_transit according to actual source evidence. Composition remains unverified/pending; known payout amount is independent of missing members.
3. A booked bank receipt may later prove settlement-bank scope while payment-composition scope remains pending. End-to-end assurance remains incomplete.
4. New payment/fee/refund observations resolve references idempotently and schedule another run. Compare complete membership count/currency sum against manifest before confirming N:1.
5. Missing components beyond due window open/update a case; they are not silently removed from the group.

**Result:** out-of-order facts are accepted without premature confirmation. INV-004/005/010/011/014.

## E. Bank record arrives several days late

1. Expected/reported payout remains pending for bank receipt, with due_at and amount exposure. Passing the contractual window opens an overdue case.
2. Bank observation is imported with booking/value dates and late ingestion time preserved. Pending bank rows do not prove cash receipt.
3. Booked receipt produces a new reconciliation run, potentially scoped to an earlier economic period. Exact identity, amount, currency and destination-account proof is required.
4. Confirm under item locks, add audited decisions and resolve case only after verification. Historical run's as-of pending outcome remains reproducible.
5. Keep original late-arrival/exception duration metrics; do not erase the operational breach. Source coverage/control totals are reevaluated for affected periods.

**Result:** lateness is explainable and recoverable, never hidden by rewriting timestamps. INV-005/006/010/014/015.

## F. Source file expects 10,000 rows; only 9,999 imported

1. Record independent expected count, source artifact checksum, and any identity/count/value totals at batch creation. Durable chunks preserve locators and parser failures.
2. Compare physical receipts to manifest during sealing/control evaluation; 9,999 != 10,000 is discrepancy even if all received rows normalize successfully.
3. Block verified coverage, persist control failure/case, show missing-count residual and retry/cursor state. Individual valid matches may exist, but period assurance cannot be clean.
4. Retry missing chunk/page with the same batch locators or ingest corrected artifact as a new linked batch. Deduplicate facts, retain receipts and rerun coverage.
5. Also test 10,000 receipts containing a duplicate and a missing ID: distinct identity/sequence/item manifest and value controls catch what physical count alone cannot.

**Boundary:** if provider supplies no count/identity/closing assertion, cannot prove complete source. Label unverified and use independent pulls/balance controls. INV-010/011/012/015.

## G. Posted journal is semantically wrong

1. Preserve the balanced original journal. Open case linking original request, accounting policy, internal expectation and source evidence; suspend affected current assurance.
2. Authorized proposer creates an exact correction payload/reason; distinct reviewer approves before real financial use. Balanced is not synonymous with semantically correct.
3. One DB transaction posts full reversal, replacement under correct account/amount/policy if appropriate, correction execution, audit and outbox. Unique reversal_of/command/effect keys prevent repeated correction effects.
4. Original entries and dates never change. Reevaluate account balances/control totals and reconciliation using the original/reversal/replacement chain. Close case only after evidence-backed verification.
5. If reversal/replacement cannot post, whole transaction rolls back and case remains open. Do not mutate the original as an emergency shortcut.

**Boundary:** detection needs independent business/policy evidence; a balance check cannot detect a wrong revenue/liability classification. INV-001/002/003/006/015/016.

## H. Two workers reconcile the same records concurrently

1. Both may compute candidates outside transactions from the same evidence.
2. Each confirmation locks run coordination and stable item IDs in canonical order, verifies current evidence versions, supported rule and expected outcome versions.
3. First commits group/allocations/decisions/audit/case changes. `(item_id,scope)` uniqueness across runs protects stable economic coverage.
4. Second either sees stale version or conflicts on claim; roll back whole group, not only one member. It rereads current result and returns equivalent confirmation or creates a conflict/retry outcome.
5. If revisions/revocation raced, confirmation fails stale-input checks and schedules reevaluation. No stale worker can resurrect released proof.

**Result:** one current consumption per economic item/scope, all-or-nothing groups. INV-005/006/010/013/014.

## I. Reconciliation rule changes after historical runs complete

1. Add immutable new rule version and implementation/configuration hash; approve activation with audit and impact scope. Never edit the version used by old runs.
2. Create new runs with frozen input revision selection. First evaluate in shadow/replay mode if change may revoke existing proof.
3. Historical results remain as-of old rule. Current assurance explicitly identifies which rule governs it; activation marks affected scope stale until reevaluation rather than presenting an old green status as current.
4. Replacement confirmation/revocation updates current allocations under item locks, records supersession and dependent invalidations. Old groups remain queryable.
5. Rule replays never repost financial effects. If accounting policy changes, use an independently authorized correction/migration, not reconciliation rule execution.

**Result:** reproducible history and explicit current-rule coverage. INV-003/006/014/017.

## J. Upstream corrects source data after import

1. Accept new raw bytes and source revision with original external identity and upstream sequence/as-of evidence. Do not UPDATE old raw/normalized records.
2. Same revision token/different payload creates a conflict case; unversioned conflicting observations require adapter sequence evidence or review to choose current. Ingestion order alone is insufficient.
3. Normalize new revision with a named version. Guard current pointer change and immediately invalidate current assurance dependent on old evidence; schedule new runs/control evaluations.
4. For economic changes, stable action key prevents another original capture. Different amount under same effect key cannot be accepted as duplicate success. Approved accounting correction posts reversal/replacement when policy demands it; no automatic rewrite.
5. Revocation/reconfirmation retains old match/audit history. If correction is only a reference/status change, it may need no journal; the policy decides, and evidence remains explicit.

**Result:** observed corrections evolve current conclusions without corrupting historical truth. INV-001/003/004/006/014/015.

## Risk ranking

Severity: critical = duplicated/lost/misstated financial truth or false assurance; high = materially delayed detection or untraceable decisions. Likelihood is qualitative **before controls**, for the synthetic V1 evolving toward production, not a statistical estimate. Rank prioritizes controls/tests, not product release approval.

| Rank | Risk / severity / likelihood | Silent failure path | Required prevention/detection |
| --- | --- | --- | --- |
| 1 | Duplicate financial effects / critical / high | Webhook + poll + retry all post same capture | Scoped semantic effect uniqueness, request-hash conflict check, atomic receipt/effect, concurrency replay |
| 2 | Incomplete source / critical / high | Only received rows are matched and UI shows 100% | Independent manifests/cursors/identity counts, raw coverage, signed/gross totals, unverified status, periodic independent pulls |
| 3 | Incorrect match / critical / high | Similar amount/date or guessed subset looks plausible | Identity evidence, exact equation/type/currency/account checks, ambiguity blocking, complete batch composition, manual guard parity |
| 4 | Correlated/self-derived controls / critical / medium | Expected internal record and journal copied from processor, both match | Independent internal source, evidence lineage, external closing reports, assurance scope labels |
| 5 | Cross-currency/book/account error / critical / medium | USD amount or another merchant reused in a PHP/book match | Currency/book/account keys/FKs, scoped rules, cross-currency rejection, no summed mixed-currency metric |
| 6 | Manual-review or approval error / critical / medium | Reviewer closes unexplained discrepancy as reconciled | Resolution distinct from proof, immutable audit, reason/evidence, two-person consequential approvals, stale-payload protection |
| 7 | Semantic accounting error / critical / medium | Balanced journal uses wrong accounts/date/revenue model | Approved chart/policy templates, independent account controls, reversal/replacement, domain expert sign-off |
| 8 | Race/lease/retry error / critical / high | Two workers allocate one bank credit or old worker commits | Stable item locks/claims across runs, fenced leases, whole-command retry, failure injection at commit boundaries |
| 9 | Money parsing/rounding/overflow / critical / medium | Number conversion loses units or scale | Lossless parser, bigint/string, currency metadata, bounded integers, explicit decimal rounding, edge PBT |
| 10 | Silent worker/checker failure / high / high | Durable rows never processed and no one notices | Work age/lag, expired lease recovery, blocked cases, independent progress/check heartbeat and missing-telemetry alert |
| 11 | Stale projection/green dashboard / high / high | UI uses old aggregate after rule/correction/failure | Checkpoints/as-of time, stale assurance invalidation, authoritative drilldown, rebuild/replay |
| 12 | Corrupt/conflicting imports / critical / medium | File altered or parser skips unknown rows | Immutable bytes/checksums, authenticated source, versioned parsing, every-row disposition, quarantine not deletion |
| 13 | Unauthorized history/control changes / critical / medium | Broad DB role edits journal/rule/audit or source scope | Least privilege, guarded routines, reviewed migrations, credentials separation, privileged-action review and retained backups |
| 14 | Evidence loss / critical / medium | Cleanup removes unresolved batch/audit or storage loses commits | Retention holds, durable WAL/storage, backups/PITR, restore tests, no unresolved pruning |
| 15 | Poison input/resource exhaustion / high / medium | Huge file/regex/JSON stalls pipeline while new work accumulates | Bounded batch/chunk/payload limits, parser timeouts, backpressure, safe evidence rendering, classified failure, work saturation alerts |

## Threat boundaries

- Untrusted external payloads: authenticate source channels, validate schema/units, preserve rejection evidence safely, parameterize SQL, prevent spreadsheet formula/script execution in previews/exports. Do not log payloads, secrets, webhook signatures or credentials. Uploaded evidence must not be executable in the operations UI.
- Authorized but fallible operators: scoped access, review exact payload, require evidence, explicit accepted-risk visibility, independent review for consequential commands. A person cannot bypass immutable ledger history via UI.
- Compromised runtime process: privileges protect posted/source/audit history, but an authorized compromised posting principal can still submit malicious yet balanced journals. Approval, independent controls and incident procedures remain necessary; no claim of absolute fraud prevention.
- DB owner/migration role: can bypass normal controls. Keep out of runtime credentials, review privileged changes and validate backups. Hashes in the same DB are integrity evidence, not tamper-proof evidence against that owner; an external audit anchor/WORM store may be evaluated if compliance requires it, not introduced speculatively.
- Simulator oracle: separate process/role/artifact path, no production reader access, no expected-answer field in accepted source payload. Reconciliation consumes only source formats and approved internal expectations.

## Highest-risk architectural assumptions

1. External IDs and revision order can be mapped reliably across delivery channels. Prove each adapter's identity contract; otherwise keep ambiguity explicit.
2. Independent completeness/balance evidence is obtainable. Some streams cannot prove complete coverage; the product must accept an unverified status instead of marketing complete assurance.
3. The proposed accounting entity/basis is appropriate. Merchant sales accounting is not custodial/platform liability accounting; approve before expanding examples into actual policy.
4. PostgreSQL roles/routines/migrations enforce controls as intended. Real DB, multi-session and direct-SQL tests are release gates, not optional ORM tests.
5. Current-proof invalidation and dependency traversal are complete. Track lineage explicitly and mark impacted assurance stale atomically, even before asynchronous reevaluation finishes.
6. PostgreSQL worker throughput is enough for V1. Measure realistic contention, backlog and storage growth before choosing a broker. Durable backlog is recoverable but operationally harmful without owners/alerts.
7. Test-mode processor evidence may be less rich than production reporting. Stripe documents [report/payout-mode-dependent composition](https://docs.stripe.com/reports/payout-reconciliation); confirm test-mode endpoint/report support in its integration milestone. Synthetic bank data never becomes evidence of an actual bank deposit.
