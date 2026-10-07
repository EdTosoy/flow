# ADR-015 — Frozen system controls coordinate independent evidence

Status: accepted for the authorized synthetic Phase 9 scope. Date: 2026-10-08.

## Context

Individual matches cannot prove source or economic completeness. Ingestion, processor and bank already own intrinsic controls; reconciliation owns frozen outcomes and current allocation proof. Exceptions own operations, including accepted risk without reconciliation. Combining their mutable latest summaries could invent a consistent-looking population or double-count money.

## Decision

Add pure control contracts and a PostgreSQL control coordinator, with no domain dependency back edges. This makes the conceptual reconciliation/control ownership in Phase 0 concrete as a separate module for system-wide evaluations. Reviewed SQL reads existing domain-owned snapshot functions; it never writes financial truth. Preserve intrinsic control implementations.

Freeze all received evidence in one book at one REPEATABLE READ snapshot. Explicitly select at most one reconciliation run per mapping for exposure; retain that run's currency/window and expose incomplete/stale selection. Never select a financial source revision or reconciliation run by arrival order. Register immutable control semantics and configuration; semantic command identity is book/run key with full canonical payload comparison. DRAFT → SEALED → EVALUATING → COMPLETED stages are resumable. Results are deterministic functions of frozen inputs; completion requires every input result plus attributable existing audit/outbox companions.

Historical evaluations are immutable. Read-time current assurance additionally compares the underlying evidence and elapsed freshness threshold; new evidence requires a new command key. UNKNOWN is first-class, including absent independent account-period closure. Acquisition count evidence does not prove a closed economic period. Independent source counts, processor calculated/reported net, bank calculated/reported closing stock, ledger balancing and individual-match proof remain distinct assertions.

Use exact per-currency, per-account/mapping totals. Canonical exposure starts from selected reconciliation items and fresh allocation proof; cases contribute disposition metadata only. Deduplicate both ends of a uniquely evidenced pair residual. Keep unproven unmatched processor/bank claim subtotals separate; a combined economic exposure is UNKNOWN when their overlap cannot be proven. Accepted risk remains a subset of unreconciled exposure and never creates reconciled value.

Optional failed-control integration uses existing Phase 8 generation and immutable result→case links. Only relevant named financial/source failures link mapped unresolved items. New arbitrary control-subject cases are deferred: raw/source-only/ledger failures remain durable controls with explicit FAIL, without fabricated reconciliation items. Evaluation history and case history remain separate; informational UNKNOWN alone creates no case. Completion, generation, links and companions commit atomically.

## Consequences and verification

A book summary can remain UNKNOWN despite every individually received record matching. Operators see batch/normalizer partitions and separate mapping/currency exposure; this is not a complete accounting-position or loss product. The bounded snapshot refuses oversized populations instead of truncating them. No balances/projections, worker, UI, external integration or AI is introduced.

Verify real PostgreSQL snapshot races, observed concurrent duplicates, immutable/forgery/permission guards, stage crashes, deferred companion failures and lost successful COMMIT acknowledgements. Public simulator artifacts enter existing pipelines; only tests consult the oracle. Verify independently missing source records and inconsistent bank closing stock despite valid historical matches. See [implementation](../../phase9/README.md) and [verification](../../phase9/verification.md).
