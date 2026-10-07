# Reconciliation semantics and completeness

## What a confirmed result proves

A confirmed match proves a **specified relationship**, for a specified book/source account/currency, over immutable evidence revisions, under one approved rule version. It asserts identity/correspondence and an exact conservation equation. It is not a confidence threshold and cannot be inferred from a ledger balancing by itself.

Separate relationship scopes initially:

1. `internal_processor_capture`: internal capture expectation versus processor capture/balance fact.
2. `internal_processor_refund`: each approved internal refund versus reported refund fact(s).
3. `business_ledger`: approved internal activity versus required accounting account effects.
4. `processor_ledger`: reported processor movements versus accounting effects; indicates consistency, not independent internal authorization.
5. `settlement_composition`: reported payout versus the complete reported set of processor balance components.
6. `settlement_bank`: reported payout versus booked bank receipt.
7. `bank_ledger`: booked bank movements versus bank-cash journal effects.

End-to-end status is derived from required scopes and coverage controls. It is never a manually editable global payment `reconciled=true`. “Capture reconciled; bank receipt pending; source coverage unverified” is a valid and useful status.

## Evidence requirements

| Evidence type | Permitted use | Insufficient on its own |
| --- | --- | --- |
| Exact scoped external/internal reference | Establish identity when adapter contract supports that reference and it is unique for the relationship | Reference equality does not prove amount, currency, account or status |
| Explicit authoritative cross-reference/membership | Prove capture/refund/payout relationship or itemized settlement composition | A guessed association or description substring |
| Exact amount + currency | Required conservation check; use exact minor units, signed component semantics | Equal amount/date, especially for common amounts |
| Occurrence/effective/booking dates and window | Plausibility guard using named timezone/calendar/window version | Identity proof; absence before deadline |
| Booked bank evidence | Establish cash receipt for the correct destination account | Pending bank row, processor paid status, estimated arrival date |
| Complete itemized report + manifest | Establish expected membership/count/signed total for N:1 | Net payout number alone or a subset with equal sum |
| Ledger entry/account-effect proof | Establish posting and account mapping under policy | Balanced journal net zero or a UI projection |
| Authorized human attachment/reference mapping | Add verified identity evidence with reason and, where required, reviewer | Clicking “force match” despite residual or contradictory evidence |

Rules have explicit amount sign/type conventions, eligible statuses, reference precedence, time precision, windows, policy/calendars, supported shape, expected controls, and ambiguity behavior. An adapter must prove its ID semantics; “external_id” is not assumed globally unique. Conflicting references do not fall back to amount-only matching.

Phase 6 auto-confirms only exact scoped identity/reference with exact amount/currency and valid type/status/time evidence. Unique amount/currency within a time window produces a candidate for review, even if it is the only row received: missing coverage can hide another candidate. Statistical confidence is for prioritization, never proof.

All unexpected currencies, unknown record classes, signs, source identity conflicts, missing counterpart evidence and rule failures stay pending or exception. No filtering them out to inflate a reconciliation rate. `nonfinancial` source rows may have an explicit classification with rule/reason and remain in processing coverage; this is not permission to hide an unidentified financial row.

## Supported group equations

Members contain stable economic item identities, evidence revisions, sides, roles and signed minor-unit contributions. Confirmation verifies book/currency, allowed roles and shape, source membership coverage, and exact side totals. Negative components are meaningful, not discarded absolute values.

### 1:1 capture

An independent internal capture `CAP-17`, amount `10000 USD`, maps through an authoritative processor reference to charge `CH-9`, amount `10000 USD`. Confirmation also validates source account/status/date. A fee of `300 USD` is a distinct component: a net processor balance of `9700` cannot directly match gross capture `10000` without explicit fee evidence and the appropriate rule.

### N:1 settlement batch

```text
sum(captures)
- sum(refunds)
- sum(chargeback debits)
- sum(fees)
+ sum(chargeback recoveries)
+ sum(explicit signed reserve/adjustment movements)
= reported payout amount
```

The itemized report identifies every component assigned to the payout. Count, distinct identities and per-currency totals agree with its manifest; every membership reference resolves or remains pending. Fees are either separate signed rows or gross/net decomposition once, depending on the adapter contract, never both. Reserves/taxes/FX classes are retained but block unsupported rules until policy is approved. The system must not search arbitrary subsets of same-day payments for a convenient total.

Example: captures `10000 + 20000`, partial refund `4000`, capture fees `300 + 600`, explicit adjustment `-100` yield payout `25000`, all USD minor units. The bank receipt is a separate group proving `25000`, not another composition member. A `24900` receipt remains a discrepancy unless an independently evidenced `100` bank fee/adjustment is accounted for under an approved rule.

### Refunds and controlled 1:N

Capture and each partial refund are separate economic activities/facets. A `10000` capture followed by refunds `3000` and `2000` retains the original capture match; each refund is independently matched to its own expected refund. The remaining refundable amount is `5000`, a derived business control, not a mutation of capture evidence.

A future 1:N rule may compare one internal refund `5000` to two processor refund components `3000 + 2000` **only when authoritative evidence explicitly identifies the split** and each component can be fully allocated once. Multiple payments sharing a reference are not automatically a split. V1 implements 1:1 first and N:1 settlement next; shape support preserves evolution to 1:N without implementing arbitrary N:M or partial monetary slicing.

## Fees, rounding and adjustments

Actual fee evidence and expected contractual fee calculation are separate inputs. A processor fee can exactly agree with a ledger posting yet still violate the contractual fee control. Retain both checks. If fee terms are unavailable, expected-fee assurance is unverified, never declared correct.

No automatic tolerance in V1. A rounding policy introduced later must name currency scale, mode, calculation boundary and exact residual allocation, with an explicit accounting entry when needed. Never make a residual disappear by declaring it immaterial in a match rule. Materiality can govern review/approval priority, not alter evidence.

## Pending, exception and time

Before a contractual/configured arrival window ends, missing settlement evidence is `pending` with due time and reason. After the window, an idempotent scheduled sweep opens/updates an overdue case; amount remains in pending exposure. No silent timeout closure. Use source-specific business-day calendars and explicitly record window/timezone policy; these are product inputs, not hard-coded assumptions about universal banking days.

Absence-based exceptions require a known cutoff and coverage quality. A late counterpart can explain a previously overdue item, but confirmation must evaluate currency/reference/amount and revoke/replace affected claims atomically. New external events are interpreted by source effective sequence, not simply ingestion order. Replay uses a virtual clock; the current real time cannot change a seeded expected result.

## Manual review, reopening and allocation

- A manual match may supply missing verified identity evidence, but must pass the same amount/currency/book/type/conservation and allocation guards. Audit actor, previous/new states, reason, evidence, rule and approval.
- An operator can conclude `accepted_risk`, `unsupported_source` or `not_a_match` after required approval. Case can be resolved; the item remains `resolved_unreconciled` and its monetary discrepancy remains in exposure/control reporting. No “force reconciled” endpoint.
- Accounting correction is a separate authorized command. It can produce evidence for a later match but is not executed automatically by a match rule.
- A new source revision, later contradictory record, control failure or review request can reopen a case and revoke affected current groups. Preserve previous run/member/group evidence; record dependency links and reason; reevaluate with a new run. Recursively invalidate dependent current conclusions where their proof used revoked evidence.
- The same stable item may belong to historical groups and to active groups in **different scopes**. Within one scope/facet it has one current allocation across all runs. A processor capture can prove an internal relationship and later be a settlement component; it cannot belong to two active settlement compositions. A bank credit cannot satisfy two payouts.
- Items identify canonical economic components, not arbitrary alternate views. A bank transaction and its raw/normalized source representation use one source-fact item identity. Gross capture and fee are separate components; their derived net is not a third allocatable resource. Restricted registration and rule component guards prevent uniqueness being bypassed by creating a new facet label.
- Confirmation races lock stable items in sorted order and rely on `(item_id,scope)` uniqueness. Reopening releases/replaces claims in the same transaction as the new decisions, case state and audit. An old worker cannot restore a revoked claim from a stale snapshot.

## Frozen populations and source coverage

A run captures both independent expectations and received evidence within its declared source-account/currency/period scope, including prior pending carryovers, unmatched records, unsupported items and negative movements. Preserve exact chosen revisions and a manifest of input IDs, counts and per-kind/currency signed/gross totals. A run cannot select only “eligible matches” as its entire population; rule eligibility is an outcome reason for retained members.

Capture the population in a consistent REPEATABLE READ transaction or from explicitly sealed immutable batch ID lists; seal before processing. A numeric maximum sequence/UUID alone is not a safe watermark: another transaction can commit an earlier allocated identity afterward. Persist actual member identities, source closure/coverage evidence, and late-arrival detection. New committed items outside the sealed snapshot belong to a new run, even if their occurrence date is old.

At finalization:

```text
sealed member count
= pending + reconciled + exception + under_review + resolved_unreconciled
```

No member may remain unassigned. The same partition is checked per kind/source/currency; amount subtotals agree with frozen totals. Match-member counts differ from group counts and must be reported distinctly. A processing run can finish with all members pending; “completed” must never mean “financially clean.”

Coverage is reported independently as verified/unverified/discrepancy. To detect 9,999/10,000, compare imported physical row locators to an independently supplied manifest and, if available, expected identity set/sequence range, distinct identity count, signed/gross currency totals and artifact checksum. A duplicate can preserve the row count while hiding a missing fact; row count alone is insufficient. Where the source cannot supply an independent completeness assertion, report the narrower assurance explicitly and schedule polling/balance controls. Webhooks alone cannot prove no missing events.

## Five completeness/control obligations

| Obligation | Independent input / computation | Explicit result |
| --- | --- | --- |
| Source completeness | Provider manifest/closing cursor/sequence/report vs raw received rows and distinct identities | Verified, unverified, discrepancy per scope/field |
| Processing completeness | Raw receipt population vs stage dispositions/work | All processed/duplicate-linked/pending/blocked; orphan is control failure |
| Ledger integrity | Recompute journal balance, scope, entry count, reversal deltas and account trial balance from authoritative entries | Pass/fail, plus verifier freshness |
| Reconciliation completeness | Sealed run members vs recorded outcomes, current allocations and frozen totals | Complete partition or failed run; independent coverage flag |
| Financial totals | External opening/closing reports vs signed period movements and ledger account effects | Pass/fail/unverified with exact residual and evidence |

Examples: processor opening + captures - refunds - fees - payouts + explicit adjustments = expected processor closing; bank opening + booked credits - booked debits = expected bank closing; opening in-transit + dispatched payouts - booked receipts/returns = expected in-transit closing. Use separate source accounts/currencies and exact date boundaries. Never net currencies together or compare counts as substitutes for value.

An independently supplied external closing balance is essential: reconstructing both sides from the same normalized rows is a tautology. Likewise, a journal auto-derived from a processor charge is correlated evidence, not proof that an independent internal capture exists. Track evidence lineage and label assurance levels accordingly. Control failures may suspend period-level assurance even when individual identity matches remain valid.

## Phase 7 implementation

The existing Phase 6 model now supports explicit complete-declaration N:1 settlement-bank groups under a separately versioned rule. Whole typed membership, exact same-currency conservation, global allocation uniqueness, immutable history, current freshness and atomic audit/outbox remain required. Declared groups are evaluated before residual pairs, with fixed conservative search bounds and no subset search or new exception lifecycle. [Concrete semantics and transaction/database boundaries](../phase7/README.md); [executed verification](../phase7/verification.md).
