# Phase 3: ingestion and versioned normalization

Scope: generic immutable evidence and synthetic movement interpretation only. This implements Phase 0's evidence/completeness model and ADRs 002/003/005/006/010. It preserves Phase 1 accounting and Phase 2 oracle boundaries. No reconciliation, accounting orchestration, production provider parser, worker executor, broker, UI, integration or deployment is included. See [verification](verification.md) for executed evidence and acceptance results.

## Packages and ownership

`@flow/ingestion-domain -> @flow/money` owns input contracts, exact serialization, pure normalizers and command validation. `@flow/ingestion-postgres -> @flow/ingestion-domain + pg` owns controlled SQL commands and reads. It cannot import ledger persistence, simulator or oracle. Neither foundation financial package imports ingestion. The composition tools adapt **public** simulator contracts to ingestion; the independent `tests/simulator-ingestion.integration.test.ts` harness alone generates/inspects private oracle truth. No additional external dependency or changed version is required.

Migration `002_ingestion.sql` adds owned `ingestion` tables and extends the existing append-only audit/outbox tables with typed ingestion references. The non-login/non-superuser `flow_ledger_owner` continues to own durability objects; separate ingestion writer/reader capability roles avoid granting ledger posting to an ingestion process. Runtime roles have SELECT and only four SECURITY DEFINER commands: source registration, batch acceptance, normalization request, normalization completion. Search paths are fixed to `pg_catalog, pg_temp`; all owned objects are qualified. No arbitrary INSERT/UPDATE/DELETE/TRUNCATE, DDL, owner-role access or trigger bypass is granted. Credentials and deployment are outside this milestone.

## Identity and evidence

Source identity is `(book, environment, provider)`; account identity adds the exact external account ID. Environment must match the immutable book and currently allows synthetic/test only. Source fact identity is `(source_account, object_kind, external_id)`. External IDs and upstream revision tokens are exact nonempty strings, bounded at 512 characters; they are never global IDs or numbers. Missing external identity remains a raw receipt with a private unlinked revision, then fails explicitly; no fabricated external ID is assigned.

A batch is one **whole, atomic, bounded logical acquisition**, identified by `(source_account, batch_key)`. It captures DB receipt time, original physical count, provenance, optional original artifact/manifest bytes, independently asserted count/sequence range and optional source UTC window. Accepted population is sealed. Its state is ACCEPTED; no durable LOADING or unfinished chunks are promised. The imported count is the physical receipt count, including duplicates and malformed records. Default preferred interpretation policy is the immutable `synthetic-movement-v1`. Each batch/locator is unique. Physical locator/order, claimed identity/revision, source observation time, raw bytes, checksum, account and revision links are immutable.

Limits: 10,000 receipts per batch; 16 MiB per record and per optional artifact/manifest. Batch construction and database JSON are in memory, so these are bounds, not simultaneous maximum-size capacity promises. Larger acquisition/chunking/storage is deferred. Batches may have zero records. No live/test aliasing, multi-tenant product or source credentials are stored.

### Exact representation and hashing

The generic API accepts `Uint8Array` and persists byte-identical PostgreSQL BYTEA, including invalid UTF-8 and zero bytes. SHA-256 checksums of raw records/revisions, artifact bytes and manifest bytes hash those **exact bytes**, without trimming, parsing, canonicalizing or adding a newline. Generated database checksum columns independently enforce integrity. Duplicate detection compares bytes as well as the hash and reports a collision rather than merging different bytes.

The simulator adapter receives Phase 2's JSON payload **string**, encodes it as UTF-8 and stores those bytes unchanged. This preserves that received logical string representation, not an unknown upstream network encoding. The CLI also stores the exact input file bytes as the batch artifact. Programmatic adaptation without file bytes stores canonical structured JSON and does not claim original file bytes. Envelope identifiers/times/order are retained in batch provenance; the raw record locator binds its array index and delivery ID. Only the public processor-event stream is interpreted. Other public streams remain in the original artifact and are deferred as normalization inputs.

The domain's canonical JSON sorts own object keys lexicographically, retains array order and permits only plain JSON objects, strings, booleans, null and safe integer metadata. Monetary values are strings. Undefined, bigint, floats and other objects fail explicitly. This is an explicit local contract, not a claim of RFC 8785 serialization. Payload byte arrays are snapshotted to hex before the first await.

The batch **request checksum** is a separate, database-owned fingerprint: SHA-256 of UTF-8 `request_payload::text`, using PostgreSQL JSONB rendering. Fingerprint ingestion-v1 binds account/key, all receipt locators/order/claimed identities/sequences/times/hex bytes, artifact/manifest hex, window, independent controls and provenance; actor is excluded so another authorized caller can replay the same command. PostgreSQL stores and compares the full JSONB request as well as its checksum. Interpretation result checksum likewise hashes UTF-8 PostgreSQL JSONB text, with Money strings; a CHECK verifies its calculated value. These hashes are not interchangeable with byte checksums or simulator `inputSha256`.

### Retransmissions and revisions

Same batch key + same semantic request returns the original batch and no extra evidence/audit/outbox. Same key + changed request raises P2001; use a new acquisition key for newly supplied evidence. A different batch key retains every physical receipt even when content repeats.

A source revision is unique by `(fact, opaque source_revision-or-absent, exact payload checksum)`, with byte comparison. Identified identical evidence across deliveries shares one revision and one interpretation per normalizer version; processing counts still account for every physical receipt. Changed bytes under the same fact create an immutable additional revision. Formatting changes conservatively create new revisions. The same explicit upstream revision token with changed bytes also preserves both and surfaces `conflicting_source_token=true`; no silent identical-success claim is made. An explicit token change with identical bytes is distinct source revision evidence.

`ingestion.fact_status` exposes `latest_received_revision_id`, `active_revision_id` and `revision_state`. Latest received is determined by durable receipt order, **not** authoritative economic order, source time or lexicographic token/hash order. With one revision the active revision is unambiguous; with multiple revisions the active pointer is NULL and state REVIEW_REQUIRED. Even explicit tokens are opaque and provide no automatic supersession ordering. Re-receiving an older observation may make it latest received without making it authoritative. No human review/exception workflow is implemented. This deliberately conservative view preserves Phase 0's requirement for authoritative sequence/as-of evidence before supersession.

## Normalization and processing

The only implemented interpretation is a minimal external **movement** with capture/fee/refund/chargeback subtype, claimed external ID, signed exact Money, currency, UTC occurred time, direction, payment/reference and optional parent reference. Scope and raw/source revision provenance remain in restrictive relational FKs. This describes synthetic source evidence; it never creates ledger accounts, entries, payments, matches or discrepancies. A wrong valid amount or reference is valid ingestion. Unsupported representations remain explicit failures rather than being forced into an unrelated model.

Both explicit version identifiers are registered immutably in the database and dispatched in pure code. v1 accepts strict UTF-8 JSON with canonical UTC millisecond timestamps. v2 retains v1 and additionally accepts explicit UTC seconds as zero milliseconds. Both follow the versioned ECMAScript JSON.parse object-member semantics (including last duplicate member); original bytes are always retained. Both reject invalid calendar dates/year zero, invalid Unicode identifiers/references, implicit/local time zones, unsupported currencies, malformed/unsafe/overflow amounts, missing or inconsistent identity and invalid structure. They call existing `Money.fromJSON`; the whole signed BIGINT range is preserved without Number conversion. No wall clock, randomness, DB ordering or locale enters interpretation.

Unique `(revision, normalizer_version)` interpretation rows include an exact `basis_raw_id`, safe failure code or immutable observation, SQL BIGINT/currency/time projection and result checksum. Failures contain enumerated codes, never payload copies or stack traces. Other receipts sharing the revision resolve to that same output. Database guards check provenance, output shape, currency/direction/amount/time consistency, immutability and uniqueness. The trusted normalizer capability supplies meaning; the database does not reimplement arbitrary parser code.

Every accepted raw receipt atomically receives PENDING disposition for the preferred version. A separately requested version adds its own PENDING rows, durable audit and outbox intent. Transitions are only PENDING -> NORMALIZED or PENDING -> FAILED; completed results never reset or disappear. There is no durable NORMALIZING state, lease or in-memory-only ownership. Computation occurs outside a transaction; completion locks the revision and atomically commits immutable result + receipt disposition. Crashing before commit leaves PENDING. Multiple workers may compute, but cannot commit conflicting same-version interpretations or duplicate results.

`summary(batch, version)` always partitions physical receipts:

```text
received = normalized + failed + pending
```

Duplicates count as successful/failed receipts while `distinctRevisions` reports logical evidence. The summary includes unrequested versions as pending potential work; processing is permitted only after an explicit request. Default reads remain v1. A newer version never implicitly becomes preferred: callers explicitly select its read version. Historical consumers should pin that selection and never add observations from several versions as separate financial effects.

### Replay, transactions and recovery

`normalizeRaw` recomputes even an already completed record, compares the entire result with durable history, returns the same result on agreement and raises P2001 on same-version drift. A failed version replays its same failure; repairing a parser uses a new version, not rewriting failed history. `requestNormalization` and `normalizeBatch` provide historical replay for registered versions. Requests are idempotent per batch/version, with one attributable audit/outbox companion. No dynamic plugin framework or version auto-upgrade exists.

Batch acceptance uses READ COMMITTED and a source-account row lock. Raw rows, dedup/revision decisions, provenance, default dispositions, batch audit and normalization intent commit together. Different acquisitions in one account serialize conservatively; different accounts can proceed independently. Unique batch/fact/revision keys remain final concurrency barriers. This deliberately favors correctness over source-account throughput; no high-volume capacity claim is made. A separate revision lock serializes normalization completion, including different receipts of the same revision.

There is no dual write. Audit uses the existing actor/session-principal/reason/policy conventions with typed batch/revision references. Accepted batches and explicit normalization requests are audited; newly changed upstream revision evidence receives an audit event. Every requested batch/version has transactional intent in the existing immutable outbox, pointing to batch/version/book. Ordinary per-receipt parsing diagnostics are dispositions, not noisy audit events. No publisher/consumer or delivery guarantee is claimed before Phase 5.

Adapters snapshot semantic inputs before awaiting connections, set durable commit/timeouts, retry whole transactions on SQLSTATE 40001/40P01 up to five attempts, handle client error events and discard dead connections. Lost acknowledgement around COMMIT raises `UnknownIngestionCommit`; recovery retries the unchanged command on a healthy connection. Never generate a new batch key because a commit was uncertain. Same-version normalization retry recomputes/comparisons with the existing result. Host-owned pools must handle idle pool error events; the CLI reports sanitized failures without payload/connection details.

Deferred batch/request commit guards enforce accepted population, coverage classification, processing rows and typed audit/outbox intent. Raw insertion is allowed only inside the batch's acceptance transaction. UPDATE/DELETE/TRUNCATE guards cover raw, revisions, interpretations, batch populations and histories even for accidental administrative SQL. PKs, composite scoped restrictive FKs, generated byte hashes and partial revision uniqueness provide independent barriers. Owners/superusers can deliberately bypass schema protection; operational access control is still required before production.

## Source completeness

Coverage is a declared **physical source coverage control**, separate from processing completeness and financial assurance:

- UNKNOWN: no independent count or sequence evidence.
- PROVEN_INCOMPLETE: any supplied count disagrees, or a supplied inclusive sequence range has missing, duplicate, null or extra sequence observations.
- PROVEN_COMPLETE: every supplied control agrees. Sequence proof requires the exact physical count and every unique sequence in range.

Count-only proof establishes count agreement and cannot detect an equal-count omission/duplicate substitution. Use independently supplied sequence evidence for that stronger claim. Expected count must count physical items under the source's declared convention. Original evidence/manifest bytes and structured assertions are preserved. The application cannot authenticate the truth of an arbitrary caller-supplied manifest in Phase 3; trusted adapter provenance is an explicit assumption. No balance totals, economic completeness, settlement membership or reconciliation reasoning is inferred.

The Phase 2 public manifest counts **delivered** input; they never become `expectedCount`. Missing simulator events therefore remain UNKNOWN unless the separate synthetic source fixture supplies independent sequence evidence. The verifier tests 10,000/9,999 and a duplicate masking the count; it does not pass oracle counts into runtime ingestion. All original oracle import and transitive dependency checks remain active, with additional ingestion probes.

## Developer path and operational signals

```sh
pnpm install --frozen-lockfile
pnpm verify
pnpm simulator generate --seed 828192 --payments 100 --out /tmp/phase3-public
# After local synthetic book + separate login membership in flow_ingestion_writer are provisioned:
DATABASE_INGESTION_URL=<local-runtime-url> pnpm ingestion simulator /tmp/phase3-public/input.json <book-uuid> artifact-1
# Same batch key replays; newer registered interpretation retains v1:
DATABASE_INGESTION_URL=<local-runtime-url> pnpm ingestion simulator /tmp/phase3-public/input.json <book-uuid> artifact-1 synthetic-movement-v2
```

Migration uses the existing explicitly configured admin workflow. Book/bootstrap/login creation is administrative; do not use migration/admin credentials for the CLI. No existing database is reset by tests. CLI stdout contains only batch ID, version, receipt/status/revision counts and coverage; never oracle truth, payload contents or accounting claims. The malformed raw payload is accepted by programmatic/adapter ingestion; a structurally invalid whole input artifact is rejected before acceptance rather than partially imported.

Summary reads and indexed PENDING dispositions supply current observability without a deployment/exporter. Operational signals to query/export when a host is added: batch count; raw receipts; retransmissions (`count(receipts)-count(distinct revisions)` within a chosen scope); source revision count; NORMALIZED/FAILED/PENDING counts **per version**; source-to-receipt and receipt-to-interpretation lag; incomplete and unknown batch counts. Failures and stale PENDING rows must alert; UNKNOWN must never be presented as green source assurance. Lag must distinguish source observation time from economic occurrence and database receipt time. Logs must use batch/raw IDs and safe codes, not raw payloads or URLs. No metrics backend, dashboards, publisher or unattended scheduler is implemented.

## Deferred

Reconciliation/matching, exception/review workflow, payments and accounting orchestration, typed settlement/bank interpretation, production bank/Stripe parsers/signatures/APIs, CSV/UI, external integrations, automatic supersession policy, dynamic normalizer plugins, chunked imports, S3, generalized worker leases/claims/publisher/consumer, independent financial balance controls, high-volume/soak benchmarks, cloud infrastructure and AI remain deferred. This phase does not start Phase 4.

PostgreSQL behavior was checked against installed-version official documentation: [BYTEA/SHA-256](https://www.postgresql.org/docs/18/functions-binarystring.html), [restricted SECURITY DEFINER search paths](https://www.postgresql.org/docs/18/sql-createfunction.html), and [row locking](https://www.postgresql.org/docs/18/explicit-locking.html). Executed database tests, rather than documentation alone, substantiate this implementation.
