# Phase 5: immutable bank claims

Scope: synthetic/test booked bank entries, optional statement evidence, stock observations and **bank-internal** controls. These answer what the bank claims happened. They establish no processor relationship, payment authorization, accounting posting or reconciliation proof. [Verification](verification.md) records executed acceptance evidence and limits.

## Terminology and packages

A **bank source account** is the existing ingestion scope `(book, environment, provider, exact external account ID)`. A **bank account** is an opaque internal UUID for that source account and one fixed currency. This is an evidence identity, separate from a ledger cash account. External account identifiers are not global. Environments remain synthetic/test; no credentials or actual bank data are supplied.

A **bank entry** is an immutable interpreted booked flow with `CREDIT` or `DEBIT` direction and strictly positive minor-unit magnitude. A **bank reference** is ordinary source text, never an inferred identity or a processor join. A **statement group** is a scoped external statement-reference identity; creating it from an entry's explicit reference does not manufacture a statement report. A **statement** is one immutable versioned source report for that group. A **statement line** associates an entry with the source-claimed group, optional source line identity and optional sequence. A **balance observation** is a signed stock, separately labeled OPENING, CLOSING or RUNNING. Stocks are never added as movements.

`@flow/bank-domain -> @flow/money + @flow/ingestion-domain` owns contracts, exact pure arithmetic, direction conversion and semantic identity. `@flow/bank-postgres -> @flow/bank-domain + pg` owns controlled writes and reads. Neither imports processor, ledger persistence, simulator nor oracle. Tools adapt the public simulator contract and invoke existing public workflows. Nx and repository import/transitive dependency gates enforce direction. No external dependency/version is added.

## Provenance and identities

```text
exact raw receipt bytes + source/account/revision
                    ↓
versioned immutable normalized bank observation
                    ↓
versioned immutable bank derivation
                    ↓
entry or statement + explicit line/balance evidence
```

A derivation has restrictive FKs to `(revision, normalizer version)`, scoped source revision, optional scoped source fact and currency-fixed bank account. The interpretation's exact basis receipt supplies locator, source revision token, received time, original bytes/checksum and source observation time. No processor or ledger evidence is substituted.

Logical derivation identity is `(revision ID, normalizer version, bank interpreter version)`. The current explicit interpreter is `bank-v1`; normalizers are `synthetic-bank-entry-v1` and `synthetic-bank-statement-v1`. Registries and outputs are append-only. Reproduction requires historical implementation/source and pinned lockfile plus evidence/version IDs. Changed rules require a new registered/implemented version; no version automatically becomes preferred. Historical legacy movement/settlement normalizers and migrations 001–003 remain unchanged in meaning.

The synthetic source contract treats a supplied entry `id` as its stable exact ID **within source account/object kind**, never across accounts. A missing ID is permitted only by the new bank-entry normalizer: the revision remains unlinked to a source fact and derivation is labeled `OBSERVATION_ONLY`. Its receipt/revision gives stable local observation identity, not invented upstream identity. Reference, date, amount or receipt arrival are never deduplication heuristics. An independent no-ID receipt remains a separate observation, even if byte-identical; cross-import deduplication without trustworthy source identity is deliberately unproven. Summaries exclude these observations from authoritative selected totals; statement controls expose UNVERIFIED_ENTRY_IDENTITY and cannot certify their full closing calculation.

Repeated identified evidence across acquisitions shares Phase 3 revision/interpretation identity. Same normalized revision and interpreter repeatedly derives one logical entry/statement and one intent. Statement membership has one immutable row per interpreted entry. Different entries can retain duplicated source line identities, allowing a control to show inconsistency instead of silently discarding evidence. Repeated source report line references are retained by ordinal.

## Supported source contracts and exact money

Bank entry JSON accepts existing public simulator `{id, status:'booked', amount, bookedAt, transferReference}` and optional `sourceOccurredAt`, `valueDate`, `bankReference`, `statementReference`, `lineIdentity`, `sequence`, `runningBalance`. Missing optional fields become explicit null. Statement context is required for line identity/sequence. An optional source `direction` must agree with signed flow. Pending/reversed status and zero movement are unsupported explicit normalization failures.

Normalized entry retains the exact signed source Money; bank projection converts it to direction and positive magnitude:

```text
positive flow → CREDIT magnitude
negative flow → DEBIT absolute magnitude
```

Each movement magnitude is 1…9223372036854775807 minor units. Signed source minimum −9223372036854775808 cannot have a positive Money/BIGINT magnitude and explicitly fails INVALID_MONEY; its raw evidence remains durable. Balance stocks support the entire signed Money range, including negative balances. Money JSON uses canonical integer strings and explicit PHP/USD currency; no Number or floating-point arithmetic. Aggregate bigint/PostgreSQL NUMERIC totals may exceed an individual Money range.

Statement JSON has stable `id`, currency and UTC `reportedAt`. Optional fields: `period:{from,to}`, `opening`, `closing`, `expectedLineCount`, `lineIds`, `sequenceRange:{from,to}`. Monetary fields are Money JSON. Source counts and sequences are exact bounded integer metadata. Missing balances/counts/membership assertions remain null, distinct from zero or an explicitly empty line list. Duplicate line references, reversed periods and reversed sequence bounds are retained for deterministic controls. Mixed balance currencies and malformed monetary structure/time fail normalization with retained raw bytes and enumerated dispositions.

New typed Phase 3 interpretation checks allow a statement's nullable closing-stock projection and explicit currency/null direction. Existing non-bank shape guards continue to run unchanged. Bank guards verify exact provenance, known key population, amount/currency/direction/time and optional fields. Existing default movement dispositions still exist; bank normalization is explicitly requested, never promoted silently. Malformed direction/amount are visible INVALID_MONEY failures in bank-version normalization summaries, rather than fabricated bank entries or duplicate exception objects.

## Date/time and stock semantics

`booked_at` comes from mandatory canonical UTC millisecond `bookedAt`. It does not stand in for optional `source_occurred_at` or calendar `value_date` (`YYYY-MM-DD`, validated calendar, no timezone). Receipt/source observation times remain distinct in immutable provenance. Bank snapshots serialize booking timestamps explicitly in UTC, independent of session timezone. Date reads should use SQL `value_date::text`, rather than pg's local-Date hydration.

Statement period endpoints are optional explicit UTC instants, **inclusive** under the synthetic contract. No local banking calendar is inferred. Opening/closing balance effective time is the respective supplied period endpoint; absent period means effective time is unknown/null, not report time. Reported time remains separate. Running balance effective time is the source entry's booked time. No balance is inferred from last entry, settlement or another account. Running-balance ordering arithmetic is deferred because source booking order is not guaranteed by sequence coverage alone.

## Statement calculation, controls and completeness

Evaluation freezes one statement interpretation and the available bank evidence under `bank-v1`/`synthetic-bank-entry-v1`. Entry selection uses only unambiguous source revisions. A new evaluation key explicitly captures new evidence; a replay returns its original as-of result even after corrections/late arrivals. It never refreshes historical totals. Input retains typed selected-entry links, all historical membership IDs, source revision states, declared line references and competing statement groups.

```text
opening stock + credit magnitudes − debit magnitudes = calculated closing stock
```

Reported closing and calculated closing remain separate. A full calculated close is returned only with known opening, independently proven line coverage and supported unambiguous, distinct, same-currency membership. Unknown/incomplete/ambiguous/duplicate/conflicting populations produce null, never a made-up zero. `knownMovementNetMinor`, credits and debits are **diagnostic received subtotals**, not proof of a complete statement. Arithmetic is PASS or FAIL only with complete calculable membership and both stocks; otherwise UNVERIFIED. Passing arithmetic/coverage alone is not overall financial assurance.

| Control                               | Source-internal meaning                                                  |
| ------------------------------------- | ------------------------------------------------------------------------ |
| CLOSING_BALANCE_MISMATCH              | Complete calculated stock disagrees with reported stock                  |
| LINE_COUNT_MISMATCH                   | Independently expected distinct statement-line count disagrees           |
| MISSING_REFERENCED_LINE               | Source-listed line identity absent from interpreted membership           |
| LINE_REFERENCE_COVERAGE               | Missing/unlisted/extra line population under source list                 |
| DUPLICATE_SOURCE_LINE_REFERENCE       | Statement source itself lists an identity twice                          |
| DUPLICATE_LINE_IDENTITY               | Distinct received entry identities claim the same source line            |
| SEQUENCE_COVERAGE_FAILED              | Independent inclusive range has a gap, duplicate, null or extra sequence |
| CROSS_CURRENCY_MEMBERSHIP             | Retained entry claim differs from statement currency                     |
| INVALID_STATEMENT_ORDERING            | Source period or sequence endpoints are provably reversed                |
| ENTRY_OUTSIDE_STATEMENT_PERIOD        | Booking lies outside explicit inclusive report period                    |
| AMBIGUOUS_ENTRY / AMBIGUOUS_STATEMENT | Source identity has several unordered revisions                          |
| PENDING_ENTRY                         | Selected supported interpreted entry unavailable                         |
| CONFLICTING_STATEMENT_ASSOCIATION     | Same stable entry history claims different statement groups              |
| UNVERIFIED_ENTRY_IDENTITY             | Receipt-local identity cannot certify an upstream distinct line          |

Controls are explicit, deterministic, sorted/deduplicated, frozen and audited on failure. They are never matches, bank reconciliation or exception cases. Conflicting associations are retained across revisions; no correction arbitrarily releases a prior statement claim. Foreign keys prevent cross-account associations; cross-currency **source claims** remain preserved and fail controls, rather than being silently removed.

Completeness reuses Phase 3's UNKNOWN / PROVEN_COMPLETE / PROVEN_INCOMPLETE meanings with an explicit **distinct bank statement line** convention. Independent expected count, source line list or inclusive sequence range may prove their scoped coverage. Every supplied control must agree; no supplied assertion means UNKNOWN. A count alone cannot detect a count-preserving omission/duplicate replacement; independent sequence/line identity provides stronger evidence. This is separate from Phase 3 physical acquisition coverage, which includes retransmissions and malformed receipts. Successful parsing, delivered simulator counts and bank balances do not manufacture independent expected line counts. Ambiguous/pending referenced interpretations prevent proven line selection. Bank internal arithmetic does not prove omitted economic flows, source authenticity or processor origin.

## Corrections and current selection

Changed bytes or source tokens create new immutable Phase 3 revisions and bank derivations. Original entries, statements, memberships, stocks, audits and evaluations remain intact. This synthetic source offers no reliable authoritative revision ordering; tokens and timestamps remain opaque evidence. `ingestion.fact_status` and `bank.current_entry` expose REVIEW_REQUIRED / unambiguous flags; multiple revisions have no selected current entry. No latest-received fallback, supersession decision or automatic activation is implemented. Consumers must pin versions and require `source_unambiguous`; observation-only records are separately labeled and never given that flag. Normal CLI totals exclude ambiguous and observation-only history.

## Transactions, concurrency, audit and retry

Acquisition and normalization remain independent Phase 3 commits. Derivation uses READ COMMITTED and the existing source-account row lock, shared with ingestion/processor scope operations. Bank account association, derivation, entry plus optional membership/running stock **or** statement with all source line references/opening/closing stocks, and existing-outbox intent commit atomically. No previously committed raw/normalized evidence is rolled back if this stage fails. Unique keys are the final barriers; unrelated source accounts progress independently.

Control evaluation is a separate short transaction under the same scope lock. Stable helpers read one PostgreSQL snapshot; frozen input/result, complete typed entry-link population and required failed-control audit commit together. No file/network/oracle read is inside a DB transaction. Sealed creation-transaction guards prevent late child inserts; deferred guards reject incomplete derivations, stocks/references, selected-entry populations or companions. Runtime bank role has SELECT plus derive/evaluate/summary capabilities, no ingestion write, processor write/read, ledger posting, owner access or direct table mutations. SECURITY DEFINER search paths are fixed to `pg_catalog, pg_temp`; objects are qualified.

Every derivation has one typed `bank.interpreted` intent in the existing outbox. Pure interpretations already have provenance and do not generate high-volume acceptance audit noise. A failed control snapshot writes one typed `bank.controls_failed` audit with actor, actual session principal, version, reason and DB time. Logs diagnose execution with sanitized errors; they never replace provenance/audit. Publishers, consumers, leases and a new queue are deferred.

Whole-command retries keep original identity, roll back and retry 40001/40P01 up to five attempts. Lost transport acknowledgement around COMMIT raises `UnknownBankCommit`; retry unchanged revision/version or statement/evaluation key on a healthy connection. Repeated and concurrent recovery cannot add another logical bank fact, membership, audit or intent. No exactly-once delivery claim.

## Developer workflow

```sh
pnpm simulator generate --seed 828192 --payments 100 --out /tmp/phase5-public
# Provision a synthetic book and three separate runtime logins; use existing admin migration workflow.
DATABASE_INGESTION_URL=<local-ingestion-runtime-url> \
DATABASE_PROCESSOR_URL=<local-processor-runtime-url> \
DATABASE_BANK_URL=<local-bank-runtime-url> \
  pnpm bank /tmp/phase5-public/input.json <book-uuid> run-1
```

The CLI invokes the established public processor workflow and separately ingests/normalizes/derives public booked bank observations. It prints `{processor: ..., bank: ...}` summaries without comparing amounts, references or relationships. Exact bank totals exclude ambiguous/unidentified history. The existing simulator has no source statement assertions, so statement count/control evaluations are zero and statement completeness remains UNKNOWN. Public manifest delivered counts are not used as source expected counts. Original public artifact bytes and canonically encoded bank row evidence remain retrievable. Duplicate public bank observations retain physical receipts but share identified interpretations. Runtime receives no oracle object; only the independent verifier compares canonical bank effects after pipeline execution.

For statement experiments, use `PostgresIngestion.ingest` with separate source-supplied entry/statement JSON receipts, explicitly request their bank normalizer, call `PostgresBank.deriveBatch`, then `evaluate(statementId, evaluationKey)`. Integration fixtures exercise this full path, including independent source balances/counts/sequences/references. They never seed bank tables or pass oracle structures into the runtime. No generator version/golden artifact changed.

## Deferred and trust assumptions

Phase 6+ reconciliation/matching/allocations; processor-to-bank joins; payment or accounting orchestration; real bank/processor APIs/signatures/credentials/order guarantees; pending/reversed bank statuses; trustworthy cross-import no-ID deduplication; authoritative revision activation/supersession/review; exception product; local-calendar/banking-day rules; running-balance ordered controls; standalone unsolicited balance feed; durable worker/publisher/consumer infrastructure; frontend/cloud/AI; streaming/soak/production readiness. Existing 10,000 receipt / 16 MiB acquisition limits and source-account serialization apply. Account/provider identities and independent source assertions rely on trusted synthetic adapters and DB administration. Dependency checks prevent accidental oracle coupling, not malicious same-user filesystem reads; future hosts must exclude private artifacts/packages.

[ADR-012](../architecture/adr/012-bank-observations.md) records the bank-only milestone and intrinsic-control ownership. PostgreSQL 18 mechanisms were checked against official [stable snapshots](https://www.postgresql.org/docs/18/xfunc-volatility.html) and [restricted SECURITY DEFINER](https://www.postgresql.org/docs/18/sql-createfunction.html) documentation; executed tests establish the stated implementation boundary.
