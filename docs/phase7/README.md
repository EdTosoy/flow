# Phase 7: complete-declaration N:1 settlement-bank proof

Synthetic/test scope only: 2–32 whole processor settlement records to exactly one booked bank movement. Phase 6 `settlement-bank-exact-v1` remains available with its original predicates. No subset-sum, partial allocation, cross-currency, 1:N/N:M, exception workflow, tolerance, fuzzy/ML/AI, real integration, ledger posting, worker/broker or infrastructure is introduced. [Executed verification and complete report](verification.md).

## Proof and runtime evidence

`settlement-bank-grouped-v1` extends the existing runs, typed groups/members, outcomes, decisions and allocation index. MATCHED means historical exact correspondence under this rule; current assurance additionally needs a fresh valid whole-item allocation. Candidates are not allocations.

The new public synthetic processor source reports **complete `payoutMemberIds`** on each settlement belonging to a shared transfer. This is an explicit upstream declaration of membership, independent of bank receipt and hidden oracle labels. All declared members must exist in the frozen population and agree on the exact complete identity set, transfer reference, account and currency. Duplicate IDs, missing members, contradictory declarations or additional same-reference settlement variants prevent acceptance. Lists are canonicalized for comparison; identities are never deduplicated to repair an invalid source list.

Phase 3 `synthetic-settlement-group-v1` is a supplemental immutable normalization version of the same raw settlement revision. It preserves the original financial fields and adds the declaration. Missing declaration normalizes to null; malformed declaration fails visibly. Phase 4 financial facts remain pinned to `synthetic-settlement-v1` / `processor-v1`. Group proof requires the supplemental financial observation, minus its declaration, to equal that exact normalized financial observation. Supplemental evidence links revision/version, and the processor fact still links its own normalized basis receipt. No duplicate processor interpretation or financial movement is manufactured. Failed supplemental interpretation blocks the new grouped rule; it does not change Phase 6 interpretation policy.

An explicitly provisioned existing synthetic account mapping fixes book/environment, processor/bank source accounts, currency and transfer-reference contract. Equal references establish the claimed transfer relationship only inside that trusted synthetic contract. This is not authenticated production proof. Amount/time similarity has no fallback authority. Period completeness remains UNKNOWN; a complete declared transfer group does not prove no other transfers exist.

## Candidate algorithm and bounds

1. Freeze actual processor/bank populations and group declarations in the existing REPEATABLE READ seal.
2. Partition by mapped account/currency, exact transfer reference and canonical **complete member list**.
3. Resolve only that whole declared set; never enumerate subsets. Preserve failed/ineligible candidate collisions.
4. Require every member's booked timing guard, same nonzero direction/currency, clear intrinsic controls, complete agreeing declarations and exact sum equal to the bank movement.
5. Require one candidate at every participating processor and bank item. Any competing declared group/bank candidate prevents arbitrary acceptance, even if its amount/control check fails.

Limits are part of the fixed rule version: group size 2–32, original run population at most 2,000 items, at most 256 distinct declarations, 10,000 retained historical/group variants, and 4,096 plausible grouped bank candidates. Oversized individual declarations remain INELIGIBLE with GROUP_SIZE_LIMIT when a bank candidate exists. Search bounds refuse sealing with explicit P6002 unsupported-bound error; the durable run stays DRAFT and source evidence is untouched. No truncated search may accept a result. Changing a bound requires a new rule version.

The pure evaluator indexes external identity and candidate incidence. Grouped work is polynomial: declaration construction plus O(D×(P+B) + C×M) membership/reference/timing work, with M bounded by the declared set, and incidence classification O(C×M + P+B). SQL uses bounded JSON scans and joins; candidate/proof guards deliberately repeat calculations, including pairwise conflict detection O(C²×M). Neither performs exponential subset enumeration. Residual pair evaluation retains Phase 6's bounded implementation and its existing complexity. The benchmark measures public-input **pure candidate evaluation** on generated valid artifacts, assumes domain eligibility for that microbenchmark, and writes no reconciliation facts. It does not measure PostgreSQL throughput or full-pipeline capacity.

## Rule precedence and outcomes

Declared grouped evidence reserves its members and transfer references from 1:1 evaluation **inside the new rule**. Therefore a failed or ambiguous group cannot fall back to a convenient pair, even when one member alone equals the bank amount. Undeclared residual evidence uses the unchanged exact 1:1 predicates. This evidence-first precedence is deterministic and pinned to grouped-v1; a separate Phase 6 command remains pair-only. Workers do not race independent rule pipelines to choose winners.

Outcomes remain MATCHED/UNMATCHED/AMBIGUOUS/INELIGIBLE. Cardinality is orthogonal `shape='1:1'|'N:1'`. Every frozen item gets an outcome, including missing counterpart or control-failed cases. A bank-side plan's first processor ID is navigation to the already unique **whole** group, not a tie-break or financial selection. Actual group membership always contains every full processor contribution and one full bank contribution.

## Exact allocation, history and controls

Signed settlement contributions all have the same nonzero sign as the bank movement: CREDIT is positive, DEBIT negative. Each individual value uses Money/BIGINT; totals use bigint/SQL NUMERIC. No float, tolerance, rounding, FX or amount slicing:

```text
sum(processor member signed amounts) = bank member signed amount = group amount
```

One global stable source-fact allocation key is reused across 1:1/grouped runs. Alternate interpretations do not create another allocatable item. Current overlap is a defensive CONFLICT; equal complete member sets can be explicitly superseded. Invalid reservations are retired through existing append-only audited decisions before replacement. No completed run, member amount, evidence or decision is rewritten.

All existing processor composition/payment controls and relevant bank statement/receipt controls continue to block proof. Unidentified and unordered revised evidence remains ineligible. New corrections preserve historical groups and invalidate current assurance immediately. A new run reevaluates frozen current evidence; there is no latest-receipt preference. A late competitor makes a frozen accepted result STALE for activation, while its historical conclusion remains explainable.

## PostgreSQL and transactions

Migration 006 adds immutable `group_candidate`, one normalizer/rule registry entry and `grouped_metrics`. It adds N:1 to the existing match shape and evolves existing guards/functions; migrations 001–005 remain unchanged. Group candidates have scoped bank/member provenance, SHA-256 key uniqueness with full-key verification (hash collision refuses rather than merges), and seal/plan transaction identity guards. A new function reconstructs group evaluation from frozen/runtime-visible population JSON. No new financial domain or queue is created.

Existing stages persist independently: create; REPEATABLE READ seal; deterministic plan; bounded advance; complete. A grouped advance atomically commits header, all typed members, outcomes, allocation decision, all current allocations, audit and existing outbox. Requested progress can exceed its item limit to commit the entire group, at most 33 members. Book NO KEY UPDATE → sorted source-account locks → run lock remains the current-write order across both shapes and all runs.

Insert guards verify frozen membership, exact contribution/currency/role and complete accepted evidence. Deferred group checks enforce exactly one bank, supported processor cardinality, exact same-direction totals, outcome coverage and audited activation. Deferred allocation checks use actual member cardinality. Mutation/late insertion/truncation and unaudited release remain prohibited. Runtime still has only narrow stage commands and reads; no generic table or ledger write capability.

Whole-stage transient retries keep the original command. Lost COMMIT acknowledgement is unknown, not failure; unchanged retry recovers the durable group. Interrupted candidate work rolls back planning; interrupted member/conservation/companion work rolls back the complete acceptance transaction. Completed replay does not restore superseded reservations. Owners/superusers and trusted synthetic source provisioners remain operational trust boundaries.

Audit uses actual run rule/version, actor/database principal and typed decision→group→members→full evidence links, including grouping declaration and exact member totals. One accepted decision and one existing-outbox intent commit together; supersession/invalidation use existing linked decisions. Candidates do not generate financial audit noise. No publisher or broker is added.

PostgreSQL mechanisms follow official version 18 [deferred constraint triggers](https://www.postgresql.org/docs/18/sql-createtrigger.html), [stable function snapshots](https://www.postgresql.org/docs/18/xfunc-volatility.html), and [restricted function search paths](https://www.postgresql.org/docs/18/sql-createfunction.html); executed real database tests establish the concrete guarantees.

## Developer workflow, metrics and oracle isolation

```sh
pnpm simulator generate --seed 828192 --payments 100 --group-size 3 --out /tmp/phase7-public
# Provision the existing synthetic book/mapping and separate runtime logins first.
pnpm reconciliation /tmp/phase7-public/input.json <book-id> run-7 <mapping-id> \
  2026-01-01T00:00:00.000Z 2026-01-10T00:00:00.000Z --grouped
pnpm benchmark:grouped /tmp/phase7-public/input.json
```

Use the Phase 6 documented ingestion/processor/bank/reconciliation runtime URLs. The pipeline ingests public artifacts, normalizes and derives the original processor/bank domains, adds supplemental group normalization, then executes the combined versioned rule. Summaries retain separate processor/bank/reconciliation outputs, with grouped candidate/partition/group/member/ambiguity/refusal counts and per-currency values. Original pair CLI behavior is unchanged without --grouped.

`phase7-grouped-v1` generation is a separate dispatch around unchanged phase2-v1; golden Phase 2 bytes remain unchanged. Source grouping declarations are produced before synthetic bank aggregate artifacts. A separate private oracle stores the generated group truth and replay config. Grouped generation currently requires an uncorrupted base; adversarial imports exercise corruptions independently. CLI replay reproduces both grouping and artifacts. Runtime libraries/tooling read public input only; test-only evaluators inspect truth after runtime decisions. Dependency/import checks include grouped oracle denial probes.

Existing operational metrics remain available. `grouped_metrics`/summary add candidate/partition counts, matched groups and processor members, refused-size/ambiguous input counts, exact per-currency value, partition size and allocation conflicts. Duration measures whole grouped run; the benchmark separately records pure candidate evaluation time and peak RSS. No monetary total crosses currencies and no observability deployment is introduced.

Deferred: 1:N/N:M, partial allocation, subset search, real grouping/reference/source authentication/revision policies, exception/manual-review workflows, general production mappings/calendars, accounting orchestration, production integrations, workers/publishers, UI/cloud/AI, scale/soak approval and advanced grouped anomaly generation. Precision is preferred to recall; unproven groups stay unreconciled.
