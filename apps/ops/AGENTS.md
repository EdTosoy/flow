# Operations Dashboard Guidance

This directory contains the operator-facing financial operations dashboard.

Read the root `AGENTS.md`, relevant architecture documentation, Phase 12 documentation, and applicable domain-specific `AGENTS.md` files before making non-trivial changes.

## Core principle

The operations dashboard presents financial truth.

It does not create financial truth.

The intended boundary is:

PostgreSQL authoritative state  
→ operations read model  
→ server-side application  
→ presentation

Never move financial semantics into React or browser code.

## No financial calculations in the UI

Do not implement authoritative calculations in React components, client utilities, or browser state.

This includes:

- reconciliation decisions
- financial exposure
- accepted-risk treatment
- control evaluation
- ledger balancing
- source completeness
- reconciliation completeness
- allocation validity

Consume authoritative read-model results instead.

Presentation-only calculations such as percentages from supplied integer counts are acceptable when clearly non-authoritative.

## PASS / FAIL / UNKNOWN

Preserve all three states.

Never present `UNKNOWN` as:

- PASS
- healthy
- zero
- no issue
- green merely because no failure is known

UNKNOWN means the system lacks sufficient evidence.

The visual design must preserve that distinction.

## Exact money

Financial values must remain exact through the application boundary.

Do not convert authoritative `bigint`, PostgreSQL `NUMERIC`, or exact monetary strings to JavaScript `Number` for calculations.

Format monetary values safely.

Always display currency.

Never aggregate different currencies into one financial amount.

## Accepted risk

Operational closure with `ACCEPTED_RISK` does not mean the underlying money is reconciled.

The UI must keep accepted-risk exposure visibly unreconciled unless a valid reconciliation later resolves it.

## Exposure

Use canonical exposure values from the read model.

Do not add together:

- reconciliation discrepancy
- exception exposure
- control discrepancy
- accepted-risk amount

when they represent the same economic discrepancy.

The UI must not invent aggregate exposure calculations.

## Server-only database boundary

Browser code must never:

- import `pg`
- connect to PostgreSQL
- import privileged database packages
- access database credentials
- access simulator oracle packages
- access resilience/failure-test utilities

Database interaction remains server-side.

## Read-model boundary

Pages and components should consume the operations read layer.

Do not place arbitrary SQL inside React components or route rendering code when an established read-model operation exists.

If a new query is needed, implement it through the dedicated read-model boundary.

## Server Components first

Prefer server-side rendering and React Server Components by default.

Use client components only where actual browser interactivity requires them.

Do not convert large sections of the application to client components merely for convenience.

## Client state

Client state may represent:

- filters
- pagination
- expanded rows
- navigation
- display preferences

It must not become authoritative financial state.

Refreshing the page should recover authoritative state from the server/database.

## Error handling

A query failure must never render as an empty healthy state.

Distinguish:

- no data
- UNKNOWN
- query failure
- unavailable subsystem
- genuine zero

Do not collapse these into one presentation.

## Empty systems

An empty database does not prove completeness.

Where appropriate, show:

`Assurance: UNKNOWN`

rather than presenting an empty system as healthy.

## Freshness

Make snapshot/evaluation freshness visible when it affects interpretation.

Distinguish:

- current query time
- control evaluation time
- integrity evaluation time
- stale historical result

Do not make historical evaluations appear live.

## Time

Do not use the browser clock to determine financial truth, lease validity, control validity, or reconciliation state.

Browser/local time is presentation only.

## Filtering

All filter values must be validated server-side.

Do not concatenate user input into SQL.

Use parameterized queries through the read-model package.

Filtering must not alter financial semantics.

## Pagination

Large operational lists must remain bounded.

Do not fetch complete financial histories into the browser.

Preserve deterministic ordering and established pagination semantics.

## Search

Search should remain bounded to useful identifiers and indexed/safe fields.

Do not implement broad searches over raw financial payloads merely for convenience.

## Sensitive information

Do not expose:

- database credentials
- raw source payloads unless explicitly required
- secrets
- internal stack traces
- privileged SQL errors
- simulator oracle labels
- test-only failure controls

Client bundles must remain clean.

## Operations actions

Phase 12 is intentionally investigation-first.

Do not casually add mutations such as:

- exception resolution
- accepted-risk approval
- manual reconciliation
- worker requeue
- financial correction

Such actions require explicit authorization, audit, idempotency, and domain-command design.

If added in a future phase, they must go through the owning domain.

## Accessibility

Preserve:

- keyboard navigation
- semantic headings
- accessible tables
- form labels
- focus states
- status text not conveyed by color alone

Financial state must remain understandable without relying only on visual color.

## Performance

Do not fix slow pages by duplicating financial logic in the UI.

Do not hide slow authoritative queries behind fake/stale client values without explicit freshness semantics.

Profile the server/read-model/database path first.

## Charts

Charts are presentation aids.

They must not replace exact values when operators need those values.

Do not combine currencies in charts unless the architecture defines an explicit conversion model.

## Simulator data

The public simulator may populate demo data.

Runtime/browser code must never receive simulator oracle labels.

Synthetic data should travel through the same runtime/read-model path as ordinary data.

## Required review before completion

For any non-trivial dashboard change, ask:

1. Did financial logic move into React or browser code?
2. Could UNKNOWN appear healthy?
3. Could exact money become an unsafe Number?
4. Could currencies be mixed?
5. Could accepted-risk money appear reconciled?
6. Could exposure be counted twice?
7. Could a query failure look like an empty healthy state?
8. Could privileged/database code enter the browser bundle?
9. Could sensitive payloads or secrets reach the client?
10. Could the UI claim fresher assurance than the underlying evaluation provides?
11. Does a mutation bypass the owning domain?
12. Is new client-side complexity actually necessary?

If any answer reveals unresolved financial or security risk, do not report the change as complete.
