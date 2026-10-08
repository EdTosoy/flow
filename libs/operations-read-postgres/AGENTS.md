# Operations read boundary

Read root instructions, Phase 8–12 semantics and ADR-016 before changing this package.

This is a versioned read surface. It must never write, repair, normalize, match, resolve or requeue. Reuse controls.summary, reconciliation.summary, exceptions.case_view and integrity.sweep. Do not recalculate canonical exposure or infer current financial truth from arrival ordering, case closure, worker success or empty tables.

Use a non-owner login with only flow_operations_reader. Keep book scope, UUIDs, enum filters, limits and cursor shape validation explicit. Approved PostgreSQL projections exclude raw bytes, commands, outbox payloads, arbitrary errors and credentials. Observe one read-only REPEATABLE READ snapshot per request. Preserve exact integer strings and currency metadata. Query failure is unavailable, never healthy empty state.

No simulator oracle, test utilities, demo provisioner or domain writer dependency. Browser code cannot import this package; only the server-only application boundary can. Verify permissions, pagination, UNKNOWN, exposure, historical freshness and migration compatibility against real PostgreSQL before reporting completion.
