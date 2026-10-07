# Financial reconciliation and exception management

Production-oriented portfolio project using synthetic data. Phase 0 is the approved architectural baseline; Phase 1 implements the generic trusted financial core; Phase 2 adds an isolated deterministic synthetic financial simulator; Phase 3 adds immutable ingestion evidence and versioned normalization; Phase 4 adds processor activity interpretations, scoped payment associations and itemized settlement expectations with explicit internal controls. Phase 5 adds separate immutable bank observations, statement/balance evidence and bank-internal controls. Phase 6 implements exact 1:1 reconciliation, and Phase 7 extends it with explicit complete-declaration N:1 groups. No application host or later-phase workflow is implemented.

**Promise:** no unexplained financial discrepancy should fail silently.

Start with the [architecture and design status](docs/architecture/README.md). The design separates external evidence, internal business expectations, immutable accounting, and reconciliation decisions. PostgreSQL is the durability boundary; API and worker processes belong to one modular monolith.

Read the [Phase 1 implementation and reproducible commands](docs/phase1/README.md) and [verification evidence](docs/phase1/verification.md). The [implementation sequence](docs/architecture/implementation-sequence.md) defines later acceptance gates, unresolved product decisions and deferred scope. Architecture approval and financial-core verification do not constitute production approval.

```sh
pnpm install --frozen-lockfile
pnpm verify
```

Prerequisites: Node 24, pnpm 11.27.0 and Docker. Integration tests own a disposable real PostgreSQL container; no existing database is reset. No reconciliation, processor/bank integration, frontend, worker or cloud infrastructure is implemented.

Read the [Phase 2 simulator model, configuration and reproduction procedure](docs/phase2/README.md) and [verification evidence](docs/phase2/verification.md). Generate safe input locally with `pnpm simulator generate --seed 828192 --payments 10000`; explicit private oracle export is a separate test-only option.

Read the [Phase 3 ingestion model and developer workflow](docs/phase3/README.md) and [verification evidence](docs/phase3/verification.md). Raw receipts, source revisions and interpretations are separate immutable evidence. Normalization never posts accounting or performs reconciliation.

Read the [Phase 4 processor model and developer pipeline](docs/phase4/README.md) and [verification/acceptance report](docs/phase4/verification.md). Processor claims never automatically create internal authorization or ledger entries, and settlement expectations do not prove bank receipt.

Read the [Phase 5 bank model and public pipeline](docs/phase5/README.md) and [verification/acceptance report](docs/phase5/verification.md). Bank observations never establish processor origin or ledger truth. The developer CLI prints separate processor and bank summaries without matching.

## Phase 6

[Exact synthetic 1:1 reconciliation](docs/phase6/README.md) and [verification report](docs/phase6/verification.md). Run `pnpm reconciliation` with public evidence and an explicitly provisioned source-account mapping. No grouped matching or exception workflow.

Phase 7 adds explicit complete-declaration N:1 settlement-bank reconciliation on the existing frozen-run/allocation model. See [semantics](docs/phase7/README.md) and [verification](docs/phase7/verification.md).
