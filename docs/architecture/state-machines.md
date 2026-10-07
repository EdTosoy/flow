# Lifecycle and state machines

Each stateful aggregate has one explicit lifecycle enum, version and guarded transition command. A compare-and-set on `(id,state,version)` plus appropriate locks rejects stale writers. Audit is part of material transition transactions. The transition lists are allowlists: **every transition not listed is illegal**. External statuses are immutable observations, not automatic permission to move internal state.

Phase 1 implements only the transaction-private constructing -> posted journal transition and immutable open account creation. Closure, reversal-of-reversal, correction approval/workflow and every later-module machine below remain deferred. Full reversal creates a second posted journal; no original state transition occurs. See [concrete scope](../phase1/README.md).

## Import, source interpretation and coverage

`ingestion_batch`:

```text
created -> loading -> sealed
loading -> retry_wait -> loading
created/loading/retry_wait -> blocked
blocked -> loading                 authorized resume, same artifact identity
```

`sealed` means artifact and received row population are fixed, not source completeness. Truncation can be sealed as received evidence with a failed coverage evaluation. New/corrected source artifacts create a new batch; sealed -> loading is illegal. Operational cancellation becomes blocked with a recorded reason, not dropped work.

Per receipt/stage `processing_disposition`:

```text
pending -> processing
processing -> succeeded | duplicate_linked | retry_wait | blocked
retry_wait -> processing
processing -> retry_wait           expired claim recovered
blocked -> pending                 authorized repair/requeue, audit + same identity
```

Processing ownership is the durable work lease; disposition transition and lease generation agree. `succeeded` requires output/evidence links; `duplicate_linked` requires canonical result link; `blocked` requires error category and case. Terminal successful interpretations never become pending to rewrite output: a new parser/stage version creates a new disposition and immutable outputs. Permanent unsupported data is retained as blocked, not ignored.

Source coverage is an independent evaluation:

```text
unverified -> verified | discrepancy
verified -> unverified | discrepancy     new evidence invalidates current assurance
discrepancy -> unverified -> verified    repaired evidence, new evaluation
```

Evaluations are append-only; these arrows describe the current coverage projection. A checksum alone cannot permit unverified -> verified. “Verified” is always scoped to a report/interval and its available control fields, not a global guarantee about the provider.

## Ledger and account lifecycle

No persisted draft journal in V1:

The SQL write routine may use a transaction-private `constructing` header while inserting entries; a deferred guard rejects commit unless it becomes complete and posted. This is not a persisted/public draft state and is invisible to other transactions. See the [posting protocol](transactions-and-outbox.md).

```text
in-memory posting request -> validated request -> posted (one DB commit)
any pre-commit failure -> no committed journal
posted -> no further lifecycle transition
```

Reversal creates **another posted journal**, with a reversal-of link and opposite entries. The original remains `posted`; its effective outstanding effect can be derived from linked reversals. `posted -> edited/deleted/draft/reversed-state` is illegal. A rejected request has an attempt/case, not a half-journal. One full reversal per original is supported initially; partial corrections require reversal + replacement, not mutation. Reversing a reversal is a new fully linked action and requires explicit approval.

Accounts: `open -> closed`; reopening is deferred. Historical references to closed accounts are valid; ordinary new postings are rejected. A narrowly authorized exact reversal may negate original entries on a closed account without reopening it; replacement entries require open accounts. Closure takes an exclusive account lock; posting takes compatible shared account locks so closure cannot race posting while independent journals remain concurrent. Classification/currency cannot change once used.

## Internal payment activity

Payment intent: `created -> authorized -> fulfilled`, or `created/authorized -> cancelled`. Fulfilled means approved internal capture activities satisfy the expected obligation, not processor/bank confirmation. Multiple captures are unsupported initially unless explicitly authorized as product scope.

An activity: `proposed -> approved -> recorded`; `proposed/approved -> cancelled`. `recorded` means internal accounting command accepted/posted according to policy. Refunding/charging back creates new activities linked to the capture; it does not change a capture to “unpaid.” A source refund with no internal parent stays an external pending/exception item; it does not create an authorized internal activity.

Approval and cumulative refund bounds are validated under parent aggregate locks. External activity can violate those bounds and must still be preserved and escalated. Payment fulfillment and the refund state are separate concepts, not independent `is_paid/is_refunded/is_failed` booleans.

## Settlement lifecycle

```text
expected -> reported -> in_transit -> received
expected -> cancelled              explicit cancellation evidence/approval
reported -> failed                 authoritative failed payout observation
in_transit -> failed                authoritative failure before receipt
received -> returned               new booked bank-return evidence
reported -> received               direct complete proof; still validate transit accounting
failed -> reported                 explicit retry report and preserved attempt history
```

`expected`: contractual/scheduled obligation exists; no payout report required yet. `reported`: source says a payout exists but no evidence yet of departure/receipt. `in_transit`: authoritative departure status/evidence under the payout policy. `received`: confirmed booked bank receipt in settlement-bank scope. `returned`: a later independent return movement; received proof history remains.

Processor “paid” alone does not permit `received`. Dates passing do not permit `received` or `failed`; overdue work produces a case while settlement stays expected/reported/in_transit. If records arrive out of order, materialize missing prerequisites from actual available evidence in one guarded command, with audit explaining the direct transition; never fabricate a departure record. A retry with a new payout identity is a new linked settlement, not reuse of old external identity. Lifecycle status is a projection of evidence, not posted accounting.

Batch composition: `unverified -> loading -> verified | discrepancy`; a new report revision creates a new batch. Verification requires reported membership coverage and equation, not just matching net amount. Missing individual events leaves composition unverified/pending even if reported payout amount is known.

## Reconciliation run and outcomes

```text
draft -> sealed -> running -> completed
running -> retry_wait -> running
sealed/running/retry_wait -> failed | cancelled
failed -> running                  authorized resume of same sealed population/rule
```

`draft` population capture is unfinished and cannot confirm. `sealed` fixes population/rule/input hash. `completed` requires every member's explicit outcome and valid counts/totals; completion can include pending cases and unverified source coverage. Completed or cancelled runs never mutate their population. A new run reevaluates new inputs/rules. Cancellation retains all evidence, creates explicit pending/not-evaluated dispositions for unfinished members, and cannot advertise a success rate.

Run-member/current outcome:

```text
pending -> reconciled | exception | under_review
exception -> under_review | pending
under_review -> reconciled | pending | exception | resolved_unreconciled
exception -> resolved_unreconciled    authorized accepted-risk/nonmatch disposition
reconciled -> pending | exception | under_review   invalidate current proof + audit
resolved_unreconciled -> under_review | pending    reopen with reason/evidence
```

These are append-only decision changes; current outcome pointers advance. Completed run decisions remain as-of conclusions. Invalidation adds linked decisions/current-status annotations and a new run, preserving the original snapshot/proof. Manual commands cannot skip confirmation guards. `resolved_unreconciled -> reconciled` needs actual evidence and the confirmation path.

Match groups: `proposed -> confirmed | rejected`; `confirmed -> revoked` through controlled reopening. Revoked/rejected groups never reconfirm: make a new proposed group linked to history. Proposed/rejected groups claim no financial value. Confirmation and all current allocations commit together; revocation releases allocations and invalidates dependent current decisions together.

## Exception case lifecycle

```text
open -> under_review
under_review -> awaiting_evidence | resolved
awaiting_evidence -> under_review
resolved -> under_review            reopen with reason/new evidence
```

Resolution requires disposition, reason, evidence and authorization. `fixed_and_verified` requires passing reevaluation; `accepted_risk` leaves discrepancy visible in financial exposure; `unsupported_source` does not certify source completeness. An assignee is metadata, not lifecycle state. New duplicate evidence attaches to the existing active case. `open -> deleted`, `awaiting_evidence -> reconciled`, and automatic close-on-timeout are illegal. Escalation affects priority/SLA, not deletion or forced resolution.

## Outbox event and work lifecycle

Outbox event is immutable. Its delivery summary is derived from all required work rows. Per-handler work:

```text
ready -> leased
leased -> done | retry_wait | blocked
retry_wait -> leased                  when available_at <= DB now
leased -> retry_wait                  lease expired, recovery records abandonment
blocked -> ready                      authorized repair/requeue with audit
```

`done` is terminal for that handler/version. A replay under a new handler version is new work; existing business-effect keys still protect accounting. `leased -> done` requires current generation and committed receipt/effect. No `blocked -> done` shortcut, no deletion after retry exhaustion, no universal event “done” while a required handler is blocked. Leases are fencing tokens, not proof of exactly-once delivery.

## Phase 4 processor lifecycle projection

Processor-associated lifecycle is derived from pinned immutable activities: observed, captured, partially_refunded, refunded, charged_back, or under_review when controls fail. It conveys no internal authorization, ledger posting or bank receipt. Multiple refunds are evaluated per parent capture; invalid external claims remain retained and no excessive total is labeled valid. Processor reports remain reported claims; Phase 4 has no received/in_transit transition or reconciliation proof. [Concrete state/control semantics](../phase4/README.md).
