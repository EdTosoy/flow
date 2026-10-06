# Phase 1: trusted financial core

Scope: generic synthetic/test accounting mechanics only. This milestone implements exact money, immutable atomic journals, semantic idempotency, full reversals, append-only audit and durable outbox intent. It does not implement a complete GL, reconciliation, processor/bank imports, simulator, frontend, worker execution, cloud resources or AI.

The [approved Phase 0 baseline](../architecture/README.md) governs architectural intent. [Verification evidence](verification.md) records the final commands, acceptance mapping and limitations.

## Reproduce from a clean checkout

Prerequisites: Node 24 (tested 24.21.0), pnpm 11.27.0 and a running Docker daemon. Direct dependencies and the PostgreSQL image digest are pinned. No local PostgreSQL installation, credentials, existing database or .env file is needed for tests.

```sh
pnpm install --frozen-lockfile
pnpm verify
```

`pnpm test:integration` creates its own randomly named, disposable PostgreSQL 18 container with a random loopback port, durable commit settings and real separate non-superuser writer/reader logins. It migrates from empty, checks migration hashes, runs the suite, and stops only its own container in `finally`. The container has no persistent volume and contains only synthetic data. Trust authentication is intentional for this isolated test fixture; it is not a production authentication policy. The pinned image resolved to PostgreSQL 18.6 in this environment.

For optional persistent **local synthetic development**:

```sh
docker compose up -d --wait
DATABASE_ADMIN_URL=postgresql://flow_test_admin@127.0.0.1:55432/flow_test pnpm db:migrate
```

The environment value above is a local test identity with no password/secret. Provision `ledger.book` and separate runtime login/group membership using an administrative connection; never use that admin identity as the application pool. `db:migrate` requires an explicitly supplied admin URL and never guesses a production target. The integration runner does not touch the Compose database. Removing persistent volumes is not part of the test command.

## Actual package/dependency structure

```text
@flow/money                    pure exact value object
@flow/ledger-domain            command/read ports and validation -> money
@flow/ledger-postgres          controlled SQL adapter -> ledger-domain + money + pg
database/migrations            reviewed financial/audit/outbox SQL
tools                          migration + disposable PostgreSQL test infrastructure
tests                          real SQL, concurrency, crash and generated-property verification
```

Nx build/test targets are explicit `nx:run-commands`; no generators, Nx Cloud, app hosts or build-service dependencies. Lint explicitly generates the project graph first, so a clean checkout cannot silently skip module-boundary checks for lack of a cached graph; lint warnings are errors. Tag rules enforce the direction above and detect circular imports. TypeScript project references build three independent library outputs. Runtime builds use pnpm workspace package links; `tsx` tests resolve the same packages to source via the root paths. Formatting covers implementation/configuration and Phase 1 documentation; the approved Phase 0 prose/table layout is retained rather than reformatted wholesale.

| Direct dependency               | Why required                                                                                                                       |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `nx` 23.2.1                     | Approved monorepo task graph/orchestration                                                                                         |
| `@nx/eslint-plugin` 23.2.1      | Enforce module boundaries/cycles                                                                                                   |
| `typescript` 5.9.3              | Strict type checking, declarations and library builds; compatible with selected Nx and TypeScript ESLint                           |
| `@types/node` 24.19.1           | Types for Node runtime/test/crypto/process APIs                                                                                    |
| `pg` 8.23.1                     | One-client PostgreSQL transactions and reviewed parameterized SQL; runtime dependency of ledger adapter, root tooling also uses it |
| `@types/pg` 8.23.1              | Driver types                                                                                                                       |
| `tsx` 4.23.15                   | Run TypeScript tools/tests using Node's built-in test runner without another test framework                                        |
| `fast-check` 4.10.2             | Exact arithmetic, generated balanced journals, reversal/replay properties with recorded seeds                                      |
| `eslint` 10.12.0                | Supported lint engine                                                                                                              |
| `typescript-eslint` 8.71.1      | TypeScript lint rules                                                                                                              |
| `eslint-config-prettier` 10.1.8 | Prevent contradictory formatter/lint style rules                                                                                   |
| `prettier` 3.9.9                | Consistent formatting of implementation/configuration and new docs                                                                 |

Node's built-in test/assert, crypto, filesystem, TCP and process APIs supply the rest. PostgreSQL's built-in SHA-256 requires no extension. No NestJS host, Drizzle ORM, Testcontainers package or decimal library is needed: direct `pg` plus a small Docker runner verifies the actual SQL boundary with fewer dependencies. These are deliberate uses of “where appropriate,” not changes to the eventual stack.

## Money and database mapping

`Money` is a frozen value object containing `amountMinor: bigint` and explicit supported currency. PHP/USD metadata version 1 has scale 2. This is an allowlist, not an assumption about all currencies. No FX, rounding or major-unit parsing exists.

Supported Money range is the full signed PostgreSQL BIGINT interval: **−9223372036854775808 through 9223372036854775807**. Zero and negatives are valid Money values. Creation rejects Number, unsupported currency, overflow and noncanonical integer strings (`-0`, leading zeros, exponent, decimal, whitespace). JSON is exactly `{ "amountMinor": "123", "currency": "PHP" }`; SQL parameters are integer strings. Read queries cast BIGINT/NUMERIC to text and explicitly construct bigint/Money. No driver-global Number parser is installed.

Ledger entries require a **positive** magnitude between 1 and 9223372036854775807 plus an explicit debit/credit side. Debits and credits are not encoded as signed entries. Journal sums and debit-minus-credit account effects use exact SQL NUMERIC/TypeScript bigint and may exceed an individual BIGINT range. `accountDelta` is a derived debit-minus-credit effect, not a complete accounting balance product; missing accounts throw instead of returning a false zero.

## Actual schema and constraint review

One reviewed migration introduces three owned schemas and eight authoritative tables, plus the admin-owned migration registry. All financial/evidence FKs are restrictive. Runtime roles cannot insert/update/delete/truncate any authoritative table directly.

| Table                          | Primary/semantic keys and controls                                                                                                                                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ledger.currency_definition`   | Currency PK; PHP/USD/scale/version allowlist; immutable                                                                                                                                                             |
| `ledger.book`                  | UUID PK, unique code, synthetic/test environment only; immutable bootstrap configuration                                                                                                                            |
| `ledger.ledger_account`        | UUID PK, unique book/code, composite book/id/currency reference keys; classification/normal-side checks; immutable; only open accounts in Phase 1                                                                   |
| `ledger.ledger_transaction`    | UUID PK; unique book/namespace/business-effect key; composite book/id/currency keys; unique non-null reversal_of; same-book/currency original FK; complete state/timestamp checks; immutable canonical request/hash |
| `ledger.ledger_entry`          | UUID PK; unique journal/line; positive BIGINT, debit/credit, line range 1–1000; composite journal/account currency/book FKs; account index; immutable                                                               |
| `ledger.command_receipt`       | PK book/command key; exactly one typed account/journal result FK; immutable canonical request/hash; durable aliases for same semantic effect                                                                        |
| `audit.audit_event`            | UUID PK; one creation event per account/journal in Phase 1; typed book/resource/original/command FKs; allowed action/state/resource checks; mandatory actor/principal/reason/policy/time; immutable                 |
| `outbox.outbox_event`          | UUID PK; unique account-or-journal/aggregate version; typed book/resource/command FKs; schema/aggregate version 1; payload identity CHECK; allowed event kinds; immutable                                           |
| `public.flow_schema_migration` | Migration filename PK, SHA-256 checksum, applied time; migration admin only; edited applied files or out-of-order history rejected                                                                                  |

PostgreSQL CHECKs intentionally address one-row conditions, never an aggregate masquerading as a CHECK. The transaction-end guard verifies exact debit-credit equality, 2–1000 entries, posted state, matching receipt/audit/outbox and exact reversal inversion. Both journal header insertion/posting and entry insertion schedule the deferred guard; an empty journal cannot bypass it. Composite FKs independently enforce book/currency compatibility. Entry insertion locks its journal parent and requires constructing state; UPDATE/DELETE and late insertion are rejected. Journal UPDATE permits only constructing -> posted with assigned posting time; all other fields are frozen. Statement-level guards also reject TRUNCATE, including accidental admin SQL.

Audit and outbox cardinality is deliberately creation-only in Phase 1. Later annotations/account lifecycle events need reviewed schema evolution preserving existing events; no mutable status/lease field is placed on an outbox fact.

## Posting and transaction boundaries

Public SQL command routines are `ledger.create_account(jsonb)`, `ledger.post_journal(jsonb)` and `ledger.reverse_journal(jsonb)`. Internal helpers are not executable by runtime roles. SECURITY DEFINER command routines belong to the non-superuser/non-login owner, fix search_path to `pg_catalog, pg_temp` (temporary schema explicitly last), use schema-qualified tables/helpers and accept no arbitrary SQL or caller-provided fingerprint. An adversarial temporary UUID-domain test verifies that caller-owned types cannot hijack privileged casts; specifying pg_catalog without explicitly ordering pg_temp was insufficiently conservative and was corrected before sign-off.

Standalone `PostgresLedger` commands check pure-domain input, acquire one PoolClient, BEGIN READ COMMITTED, set local durable commit/timeouts, call a controlled routine, and COMMIT. Every successful creation commits result identity, all rows, audit and outbox together. Deferred guards run at COMMIT; a failure rolls everything back. No durable DRAFT is supported. Constructing state can exist only inside an uncommitted transaction and is rejected at commit.

`ledgerCommandsInTransaction(client)` exposes the same typed commands without BEGIN/COMMIT. A trusted application use case supplies an already-started transaction, durable commit settings and error handling, then commits its domain writes with ledger writes. It must retry/recover the **whole use case**, not one inner operation. This preserves the Phase 0 composition boundary without implementing later domain modules. Never mix pool.query with a client-owned transaction or treat an inner returned ID as committed before the outer commit.

Locks: command alias uses a transaction-scoped advisory lock; its PK and the journal semantic unique key remain final barriers. Unique effect insertion handles different command keys for the same action. Accounts are checked under sorted FOR SHARE locks; journal parents serialize entry construction; original journal FOR UPDATE serializes competing full reversals. No global balance lock or authoritative balance cache. Multi-command caller-owned transactions can still deadlock; retry their full command group using unchanged identities.

Standalone commands serialize their semantic payload once before awaiting a connection and reuse those exact bytes on retries; JavaScript caller mutation cannot change an in-flight command despite TypeScript's compile-time readonly limitation. They retry SQLSTATE 40001/40P01 up to five total attempts with bounded exponential backoff/jitter. Server-side deterministic rejection is explicit; transport/ambiguous failure around COMMIT raises `UnknownCommitOutcome`. The checked-out client's error event is handled and dead connections are discarded. Caller-supplied pools must also report idle-pool error events through their host's observability; this library does not own that host or pool lifecycle.

## Semantic idempotency and unknown outcomes

Two independent barriers:

1. `(book_id, command_key)` cannot refer to a materially different command.
2. `(book_id, effect_namespace, business_effect_key)` cannot create a second original financial effect even through different command keys.

The database builds canonical JSONB and SHA-256 itself, stores both, and compares both. Fingerprint version 1 includes operation kind, book, currency, semantic effect identity, effective time, policy version, reason, reversal target and the sorted multiset of entries. UUIDs and integer-string amounts normalize; entry reordering is equivalent, duplicate entries remain duplicate entries. Command key and actor are excluded to allow different transport attempts/trusted callers to replay the same action; first successful actor/principal remains in the immutable audit. Changing amount, accounts, sides, currency, dates, policy or reason conflicts. Account identity has equivalent checks against book/code.

Pure replay returns the original ID with `replayed=true`, without new audit/outbox events or entries. A new alias records an immutable command receipt. `P1001` is an explicit semantic conflict, never success. Failed/conflicting attempts do not create successful financial audit events; diagnostic/security-attempt recording is deferred to a host. `P1002` denotes incompatible/missing origin/account, `P1003` immutable mutation, `P1004` commit-integrity failure and `P1005` invalid reversal. Ordinary PostgreSQL SQLSTATEs also remain explicit.

If COMMIT acknowledgement is lost, do not issue a new identity or report a definitive failure as fact. Retry the unchanged command on a new healthy connection. If the original committed it returns the existing ID; if it rolled back, it creates exactly one effect. Ambiguous commit failures are conservatively unknown except identified deterministic data/constraint/transaction-retry rejections. This is one idempotent financial effect, **not exactly-once delivery**.

## Reversals and account lifecycle

Only one full reversal of an original journal. The routine reads immutable original entries, copies each positive amount/account/currency with the opposite side, uses reserved namespace `ledger.reversal` and original ID as business key, and posts new history atomically. Unique reversal_of is an independent backstop; the deferred guard checks exact inverse multisets and rejects reversal-of-reversal. Same reversal identity/meaning safely replays; conflicting correction metadata is explicit conflict. Original stays posted and byte-equivalent.

Partial reversals, reversal-of-reversal and a dedicated approved reversal-plus-replacement workflow are deferred. A replacement is a separately identified journal; callers requiring atomic reversal/replacement can compose typed commands in one caller-owned transaction, but no approval/workflow product is implemented.

Accounts are fully immutable and open in Phase 1. Closure/reopening is deferred, avoiding an unnecessary lifecycle/approval feature. Phase 0's future closed-account exact-reversal exception remains a required gate when closure is introduced; ordinary posting to closed accounts must then be denied while approved exact correction remains possible. The current schema cannot create a closed account, so no false closed-account guarantee is claimed.

## Audit, outbox and permission boundaries

Successful account/journal/reversal creation has one durable append-only audit event, with actor claim, actual database session principal, action, resource, prior `absent`/new state, command, reason/policy, DB transaction timestamp and original reversal reference. `absent` refers to creation of the new reversal entity, not alteration of the original. Timestamps are not global causal order or exact COMMIT timestamps. Replays are not additional financial decisions. No full financial payload or secrets are copied into audit.

Outbox intent contains immutable UUID, event kind, typed resource/book, aggregate/schema version 1, creation time, causation command and immutable resource-reference payload. It contains no worker/publication boolean or lease. Journal events point to an immutable complete journal and reversal link. No publication or consumption occurs; the crash-after-commit test proves intent survives without a dual write.

`flow_ledger_owner` is NOLOGIN, non-superuser and owns schemas/tables/routines. `flow_ledger_writer` can read and execute only the three command routines. `flow_ledger_reader` can read and execute the read routine. Runtime roles cannot gain owner privileges, change/disable triggers, use replication-role bypass, perform DDL in the financial schemas or write base tables. Caller-created temporary objects cannot hijack the controlled routines. Migration/bootstrap credentials remain offline/admin. Provision actual authenticated runtime logins outside the migration; test-only logins are created by the disposable runner.

This is a database capability boundary, not an end-user authorization product. The actor supplied by a trusted caller is a claim recorded alongside the actual DB principal. Writer privileges can submit balanced but semantically wrong journals across provisioned books; domain authorization, chart/policy approval and two-person consequential review are required before real use. DB owners/superusers can intentionally disable controls; ordinary admin SQL mistakes are guarded, deliberate owner bypass is outside the guarantee. Caller-owned sessions must retain durable commit settings.

## Material refinements to Phase 0

- One small reviewed SQL migration is authoritative; Drizzle adds no useful boundary here and is deferred until ordinary persistence justifies it.
- Fingerprints are computed and normalized in PostgreSQL rather than trusted from a caller, strengthening raw-SQL verification. Command aliases and business-effect identity are separate.
- Reversal-of-reversal and account closure are explicitly deferred. No dedicated approval/replacement workflow is claimed. No two-person product is built for synthetic mechanics.
- Outbox persistence alone satisfies this milestone; consumers/work/leases remain Phase 5.
- A typed caller-owned transaction port prevents later domain modules from being forced into dual writes.

No later-phase functionality was implemented to resolve these choices.

## Technical sources checked against selected versions

- [Nx Node support](https://nx.dev/docs/technologies/node/introduction) and [TypeScript support](https://nx.dev/docs/technologies/typescript/introduction) support the selected Nx 23/Node 24/TypeScript 5.9 combination.
- [pnpm settings](https://pnpm.io/settings) describe workspace settings/build-script allowlists; only Nx/esbuild lifecycle scripts are explicitly allowed.
- [node-postgres transactions](https://node-postgres.com/features/transactions) require the same client throughout; [types](https://node-postgres.com/features/types) support explicit string conversion. Installed pg source was inspected when testing its connection-error behavior.
- PostgreSQL 18 [constraints](https://www.postgresql.org/docs/18/ddl-constraints.html), [triggers](https://www.postgresql.org/docs/18/sql-createtrigger.html), [function security](https://www.postgresql.org/docs/18/sql-createfunction.html), [binary SHA-256](https://www.postgresql.org/docs/18/functions-binarystring.html), [isolation](https://www.postgresql.org/docs/18/transaction-iso.html) and [locking](https://www.postgresql.org/docs/18/explicit-locking.html) support the concrete mechanisms. SQL tests exercise them rather than assuming documentation establishes correctness.
