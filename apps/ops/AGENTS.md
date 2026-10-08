# Local operations dashboard

Read root instructions, Phase 12 documentation and ADR-016 before changes. App Router Server Components are the default; only real browser interaction needs client components. All database reads go through server/read.ts and @flow/operations-read-postgres. Every module under server/ imports server-only. Components contain presentation, never SQL or authoritative financial calculations.

Keep the application local/internal and bound to localhost until production identity, authorization, TLS and deployment are separately approved. No web mutations, Server Actions, requeue, resolution, manual matching or accounting commands. Never put connection strings in NEXT_PUBLIC_* variables, logs, props or browser artifacts.

Keep PASS/FAIL/UNKNOWN distinct. Unknown money is not zero, accepted risk is unreconciled, historical evaluations show freshness, and all currencies remain separate. Format money using integer strings and canonical currency scale. Preserve bounded keyset pagination, semantic tables, accessible status text/focus/navigation, usable narrow-screen overflow and explicit unavailable/empty states.

Run production build, presentation tests, real PostgreSQL read/permission tests, browser smoke and oracle/client dependency gates. Preserve all Phase 1–11 gates. No private oracle or test/demo imports from runtime application code.
