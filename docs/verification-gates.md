# Verification gates

Inspected for the P0 engineering baseline. Use the root AGENTS.md and actual
package scripts; this inventory does not assert that any check passed.
Package manager: `pnpm@11.27.0` from package.json.

| Gate                     | Existing command                                                                    | Scope / prerequisite                                                                                                              |
| ------------------------ | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Types                    | `pnpm typecheck`                                                                    | Shared TypeScript check plus ops app typecheck                                                                                    |
| Static analysis          | `pnpm lint`                                                                         | Nx graph, ESLint with no warnings, oracle dependency boundaries; writes .nx graph artifact                                        |
| Formatting               | `pnpm format:check`                                                                 | Existing source/phase-doc globs; excludes this root docs file                                                                     |
| Units/contracts          | `pnpm test:unit`                                                                    | Nx unit tests, boundary tests, Stripe HTTP contract fixtures, deployment configuration tests                                      |
| Build                    | `pnpm build`                                                                        | Nx targets including the ops frontend; creates build artifacts                                                                    |
| Database/integration     | `pnpm test:integration`                                                             | Docker-hosted disposable PostgreSQL 18; sequential migration preservation/hash checks, restricted roles, application integrations |
| Scoped browser journey   | `pnpm exec tsx tools/test-postgres.ts tests/operations-browser.integration.test.ts` | Same real database bootstrap, operations server and Chromium; console/page errors and UI assertions                               |
| Resilience               | `pnpm test:resilience`                                                              | Database-backed failure, load, and restart tests; slower, select when affected                                                    |
| Stripe contracts         | `pnpm test:stripe:contract`                                                         | Local HTTP fixtures; not evidence of live Stripe behavior                                                                         |
| Deployment configuration | `pnpm test:deployment`                                                              | Local tests; does not deploy or authorize cloud changes                                                                           |
| Aggregate                | `pnpm verify`                                                                       | Format, lint, build, types, unit, and real integrations in sequence                                                               |

The integration runner accepts only its allowlisted test-file paths. It creates
and stops its own Docker container and tests migration preservation across prior
schema phases. Docker access is a privileged host boundary: review and authorize
the fixture lifecycle before running it. Do not point `pnpm db:migrate` or other
tools at production to satisfy a verification gate.

Browser tests use Playwright and either its configured Chromium or the existing
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` / system Chromium fallback. They capture
temporary screenshots and exercise narrow/wide layouts and keyboard behavior.
Missing Docker, database, or browser access is NOT RUN; do not install browsers
or change launch security flags without separate approval.

Security evidence currently includes dependency-boundary checks, API/role tests,
and real database privilege constraints. The new `.github/workflows/verify.yml`
runs format, lint, types, units/contracts, and build using Node 24 and the pinned
pnpm package manager. It has read-only repository permissions and a bounded,
cancellable job. It does not run PostgreSQL, browser, or resilience tests; those
remain a release-verification gap. There is no dedicated dependency-audit script.
Local checks do not prove a hosted CI run, live cloud security, or accessibility.

For a change, select the relevant subset and record exact commands with PASS,
FAIL, SKIPPED, or NOT RUN and a reason. Do not alter assertions merely to pass.
Preserve unrelated working-tree edits and keep screenshots/logs free of secrets.

## P1 local evidence

On the current working tree, `pnpm format:check`, `pnpm lint`, `pnpm typecheck`,
`pnpm test:unit`, and `pnpm build` passed. Units ran 15 Nx targets plus 5 boundary,
4 HTTP-contract, and 9 deployment/access tests. Build ran 24 targets in 31.6s.
Existing uncommitted ops/config and access-test edits were preserved; this is not
a clean-HEAD result. Hosted execution is NOT RUN.

Installed Playwright 1.63.0 expects Chromium revision 1243 (153.0.8010.12).
Its cached generic headless shell failed on the NixOS dynamic loader. The existing
Nix Chromium 153.0.8010.52 passed launch, DOM, screenshot, and trace probes with
Chromium sandbox enabled. The real application/database browser suite is NOT
RUN: its database lifecycle falls outside this task's no-destructive-DB boundary.
Do not equate that platform probe with financial or application integration proof.
