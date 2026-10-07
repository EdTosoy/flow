# Financial reconciliation and exception management

Production-oriented portfolio project using synthetic data. Phase 0 is the approved architectural baseline; Phase 1 implements the generic trusted financial core; Phase 2 adds an isolated deterministic synthetic financial simulator. No application host or later-phase features are implemented.

**Promise:** no unexplained financial discrepancy should fail silently.

Start with the [architecture and design status](docs/architecture/README.md). The design separates external evidence, internal business expectations, immutable accounting, and reconciliation decisions. PostgreSQL is the durability boundary; API and worker processes belong to one modular monolith.

Read the [Phase 1 implementation and reproducible commands](docs/phase1/README.md) and [verification evidence](docs/phase1/verification.md). The [implementation sequence](docs/architecture/implementation-sequence.md) defines later acceptance gates, unresolved product decisions and deferred scope. Architecture approval and financial-core verification do not constitute production approval.

```sh
pnpm install --frozen-lockfile
pnpm verify
```

Prerequisites: Node 24, pnpm 11.27.0 and Docker. Integration tests own a disposable real PostgreSQL container; no existing database is reset. No reconciliation, processor/bank integration, frontend, worker or cloud infrastructure is implemented.

Read the [Phase 2 simulator model, configuration and reproduction procedure](docs/phase2/README.md) and [verification evidence](docs/phase2/verification.md). Generate safe input locally with `pnpm simulator generate --seed 828192 --payments 10000`; explicit private oracle export is a separate test-only option.
