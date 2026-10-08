# Financial reconciliation and exception management

Production-oriented portfolio project using synthetic data. Phase 0 is the approved architectural baseline; Phase 1 implements the generic trusted financial core; Phase 2 adds an isolated deterministic synthetic financial simulator; Phase 3 adds immutable ingestion evidence and versioned normalization; Phase 4 adds processor activity interpretations, scoped payment associations and itemized settlement expectations with explicit internal controls. Phase 5 adds separate immutable bank observations, statement/balance evidence and bank-internal controls. Phase 6 implements exact 1:1 reconciliation, and Phase 7 extends it with explicit complete-declaration N:1 groups. Phase 8 adds separate operational exception management. No application host is implemented.

**Promise:** no unexplained financial discrepancy should fail silently.

Start with the [architecture and design status](docs/architecture/README.md). The design separates external evidence, internal business expectations, immutable accounting, and reconciliation decisions. PostgreSQL is the durability boundary; API and worker processes belong to one modular monolith.

Read the [Phase 1 implementation and reproducible commands](docs/phase1/README.md) and [verification evidence](docs/phase1/verification.md). The [implementation sequence](docs/architecture/implementation-sequence.md) defines later acceptance gates, unresolved product decisions and deferred scope. Architecture approval and financial-core verification do not constitute production approval.

```sh
pnpm install --frozen-lockfile
pnpm verify
```

Prerequisites: Node 24, pnpm 11.27.0 and Docker. Integration tests own a disposable real PostgreSQL container; no existing database is reset. No real processor/bank integration, frontend or cloud infrastructure is implemented. Internal PostgreSQL workers are implemented in Phase 10.

Read the [Phase 2 simulator model, configuration and reproduction procedure](docs/phase2/README.md) and [verification evidence](docs/phase2/verification.md). Generate safe input locally with `pnpm simulator generate --seed 828192 --payments 10000`; explicit private oracle export is a separate test-only option.

Read the [Phase 3 ingestion model and developer workflow](docs/phase3/README.md) and [verification evidence](docs/phase3/verification.md). Raw receipts, source revisions and interpretations are separate immutable evidence. Normalization never posts accounting or performs reconciliation.

Read the [Phase 4 processor model and developer pipeline](docs/phase4/README.md) and [verification/acceptance report](docs/phase4/verification.md). Processor claims never automatically create internal authorization or ledger entries, and settlement expectations do not prove bank receipt.

Read the [Phase 5 bank model and public pipeline](docs/phase5/README.md) and [verification/acceptance report](docs/phase5/verification.md). Bank observations never establish processor origin or ledger truth. The developer CLI prints separate processor and bank summaries without matching.

## Phase 6

[Exact synthetic 1:1 reconciliation](docs/phase6/README.md) and [verification report](docs/phase6/verification.md). Run `pnpm reconciliation` with public evidence and an explicitly provisioned source-account mapping. This original rule stays pair-only; Phase 7 and Phase 8 capabilities are separately documented below.

Phase 7 adds explicit complete-declaration N:1 settlement-bank reconciliation on the existing frozen-run/allocation model. See [semantics](docs/phase7/README.md) and [verification](docs/phase7/verification.md).

## Phase 8: operational exceptions

A separate exception domain supports deterministic case generation, review, evidence/notes, auditable assignment/classification, structured resolution and explicit reopening/supersession. Accepted risk closes operations while money stays unreconciled. Verified closure cites existing fresh later-run proof; it creates no allocation. [Model and CLI](docs/phase8/README.md), [verification](docs/phase8/verification.md), [ADR-014](docs/architecture/adr/014-operational-exceptions.md).

Use `pnpm exceptions pipeline` with the existing reconciliation arguments and separate `DATABASE_EXCEPTION_URL`, then `pnpm exceptions apply <command-json>` for review/resolution. Normal output contains runtime evidence only. Manual matching, new downstream worker policies, frontend, real integrations, cloud and AI remain deferred.

## Phase 9 financial controls

Versioned frozen control runs coordinate source/processing completeness, processor and bank totals, reconciliation coverage, allocation and ledger integrity, exposure and aging. UNKNOWN evidence stays explicit; operationally accepted risk remains unreconciled. See [implementation](docs/phase9/README.md) and [verification](docs/phase9/verification.md). `pnpm controls run <command-json>` and `pnpm controls pipeline <reconciliation arguments>` use separate synthetic runtime credentials. Phase 10 adds separate durable internal worker processing without changing these frozen control evaluations.

Phase 10 is complete and verified for internal PostgreSQL async workers: [protocol and developer commands](docs/phase10/README.md), [verification](docs/phase10/verification.md).

Phase 11 is complete and verified for independent read-only system integrity checks and synthetic/local adversarial resilience: [scope and commands](docs/phase11/README.md), [executed evidence](docs/phase11/verification.md). Use `pnpm integrity <book-id> [explicit-run-id ...]` with a narrow integrity-reader credential. Structural integrity and financial PASS/FAIL/UNKNOWN remain separate. Phase 12 remains deferred.
