# Stripe Integration Guidance

This package contains the Stripe-specific external processor adapter.

Read the repository root `AGENTS.md`, Phase 14 documentation, ADR-017, ingestion/processor guidance, worker guidance, and the `verify-financial-change` skill before making non-trivial changes.

## Core principle

Stripe is an external source of processor evidence.

Stripe does not directly define Flow's internal financial truth.

The intended boundary is:

```text
Stripe evidence
    ↓
authenticated external ingress
    ↓
immutable ingestion/provenance
    ↓
asynchronous interpretation
    ↓
provider-neutral Flow domains
```

Keep Stripe-specific behavior at this boundary.

## Sandbox-only

Phase 14 supports Stripe sandbox/test mode only.

Do not:

- enable live Stripe processing
- accept `livemode=true` events
- add production payment initiation
- add checkout/subscriptions/billing
- add Connect/multi-account behavior

without an explicit later architecture decision.

Live-mode evidence must fail safely and visibly.

## Official SDK

Use the official Stripe Node SDK for:

- webhook signature verification
- Stripe API interaction
- supported test utilities

Do not manually reimplement Stripe cryptographic verification.

Keep the pinned SDK and API-version policy explicit.

## Raw webhook bytes

Webhook signatures must be verified against the exact raw request bytes.

Never:

- parse JSON before verification
- reserialize the body before verification
- normalize whitespace before verification

Any framework/middleware change affecting request bodies must preserve this invariant.

## Webhook signature verification

Verification must include:

- exact raw body
- `Stripe-Signature`
- configured signing secret
- nonzero timestamp tolerance

Invalid, missing, tampered, or stale signatures must never enter trusted ingestion.

Do not disable replay/timestamp protection for convenience.

## Webhook secrets

Signing secrets must come from runtime configuration.

Never commit or log:

- `whsec_*`
- secret API keys
- restricted keys

Support documented secret rotation semantics without persisting secrets as evidence.

## Durable acknowledgement

Do not return successful webhook acknowledgement merely because the request was authenticated.

The required sequence is:

```text
verify
→ validate sandbox/source context
→ durably persist immutable evidence
→ persist work intent
→ COMMIT
→ return 2xx
```

If durable acceptance fails or commit outcome is uncertain, do not falsely acknowledge success.

## Fast ingress

Webhook ingress must remain small and bounded.

Do not perform expensive operations synchronously such as:

- Stripe enrichment reads
- reconciliation
- controls
- integrity sweeps
- broad normalization
- dashboard updates

Those belong behind the worker boundary.

## Immutable external evidence

Accepted Stripe evidence is historical provenance.

Do not rewrite:

- event identity
- original raw bytes
- event API version
- event timestamps
- provider/source identity
- evidence digest

Later evidence creates new evidence.

It does not replace old evidence.

## Duplicate delivery

Stripe may deliver the same event more than once.

Duplicate acquisition must not create duplicate:

- source events
- interpretations
- processor movements
- reconciliation outcomes
- financial effects

Use established event/provenance identity and downstream semantic idempotency.

## Conflicting duplicate evidence

If the same Stripe event identity appears with materially conflicting evidence:

- preserve the original
- surface the conflict
- do not overwrite history
- do not arbitrarily choose the latest arrival

Conflict is not idempotency.

## Event ordering

Stripe does not guarantee webhook delivery order.

Never use arrival order as economic truth.

Do not assume:

```text
first received
=
first economically valid
```

Related event histories must remain conservative under out-of-order delivery.

## Event timestamps

Preserve distinctions between:

- Stripe event creation time
- resource timestamps
- balance-availability timing
- Flow arrival time
- normalization time

Do not use one timestamp as a substitute for another.

## API versioning

Preserve event-time API version information.

Do not reinterpret historical Stripe events silently using a newer schema.

Unsupported event/resource versions must fail visibly or remain UNKNOWN according to established policy.

## Provider-neutral core

Do not leak Stripe SDK types into:

- Money
- ledger
- reconciliation
- exceptions
- controls
- integrity

Map Stripe concepts into provider-neutral Flow contracts.

If Stripe exposes a concept that Flow genuinely lacks, design a general domain concept rather than adding `Stripe.*` types to core packages.

## API enrichment

Stripe API reads belong behind the Stripe client abstraction.

Do not call Stripe directly from core financial-domain packages.

Use enrichment only where external evidence is required to interpret the processor event correctly.

## Balance Transactions

Treat Stripe Balance Transactions as authoritative processor-side financial evidence where supported.

Use exact Stripe-provided:

- amount
- fee
- net
- currency
- source identity
- timing

Do not estimate Stripe fees.

Do not derive fees from percentages.

## Charges

Only map charge/capture evidence when the supported authoritative relationships are proven.

Do not infer a capture merely from a superficially matching amount.

## Refunds

Preserve distinct Stripe refund identities.

Support multiple and partial refunds without collapsing them.

Pending, failed, reversing, or unsupported refund economics must remain explicit.

Do not invent final financial meaning before Stripe evidence proves it.

## Disputes

Preserve dispute identity and linked charge identity.

Status updates are not independent unrelated economic movements.

Unsupported funds-reinstatement/reversal economics must remain UNKNOWN/unresolved rather than force-mapped.

## Payouts and settlement

Map Stripe payouts conservatively into the existing settlement model.

N:1 payout membership requires explicit evidence.

Never use:

- subset-sum guessing
- amount-only matching
- arbitrary candidate choice

to establish settlement membership.

If membership cannot be proven, preserve uncertainty.

## Exact money

Stripe integer amounts must be validated and converted into Flow Money safely.

Do not use JavaScript floating point for financial calculations.

Do not assume every currency has two decimal places.

Do not mix currencies.

## Supported currencies

Current supported currency coverage must remain explicit.

An unsupported currency should fail or remain unsupported visibly.

Do not silently reinterpret or convert unsupported currency.

FX requires a separate architecture decision.

## Account binding

Runtime evidence must remain bound to the configured Stripe sandbox account/source.

Unexpected account/source context must not silently enter another source population.

Phase 14 is single-account.

Do not introduce Connect semantics accidentally.

## Backfill

Backfill is another acquisition path for the same Stripe evidence.

It must feed the same durable ingestion semantics.

Webhook and backfill acquisition of the same event must converge to one logical event/economic effect.

Do not create a privileged alternate interpretation path.

## Backfill completeness

Successful backfill does not prove unlimited historical completeness.

Preserve UNKNOWN outside the supported evidence horizon.

Do not convert:

```text
all retrieved events processed
```

into:

```text
all Stripe history proven complete
```

without independent evidence.

## Pagination

Stripe list APIs are paginated.

Handle pagination explicitly.

Do not assume one page is complete.

Repeated/invalid cursors and configured bounds must fail safely.

## External failures

Classify failures explicitly.

Examples:

- timeout
- network failure
- rate limit
- Stripe 5xx
- authentication failure
- invalid request
- missing resource
- unsupported schema

Retry transient failures only.

Do not retry permanent configuration or schema failures forever.

## Rate limiting

Respect bounded retry behavior.

Do not create tight retry loops.

Stripe retries must integrate with the existing worker retry/fencing model rather than inventing a separate retry architecture.

## Worker integration

Stripe processing must reuse established:

- durable work
- leases
- fencing
- attempt history
- retry classification
- terminal failure semantics

Do not create another queue system.

## Crash safety

Assume:

```text
Stripe API enrichment succeeds
→ internal financial-domain commit succeeds
→ worker acknowledgement is lost
```

Replay must remain safe.

Use existing semantic idempotency.

Do not assume one worker execution equals one economic effect.

## API writes

Normal runtime Phase 14 integration should remain read-oriented.

Stripe POST operations used for sandbox event generation belong in test/demo tooling, not in Flow's financial runtime.

Do not add payment-creation product behavior here.

## Synthetic bank boundary

Stripe processor evidence may be real sandbox evidence.

Bank evidence remains synthetic in Phase 14.

Never describe synthetic bank evidence as independent real-bank proof.

## Completeness

Receiving valid webhooks does not prove complete Stripe evidence.

Successful worker processing does not prove source completeness.

Preserve explicit:

- PASS
- FAIL
- UNKNOWN

according to actual evidence.

## Logging

Safe logs may contain bounded identifiers such as:

- event ID
- event type
- operation
- internal evidence ID
- duration
- outcome classification

Do not log:

- API secrets
- webhook secrets
- full signatures
- complete raw payloads
- card/payment-sensitive fields

## Metrics

Keep metric labels bounded.

Do not use:

- event IDs
- charge IDs
- refund IDs
- account IDs
- external object IDs

as uncontrolled metric labels.

## Dashboard presentation

Provider provenance may be exposed through the existing operations read model.

The dashboard must not independently reinterpret Stripe economics.

Never expose secrets or unrestricted raw Stripe payloads to browser clients.

## Oracle isolation

Runtime Stripe integration must never import simulator-oracle packages.

Real Stripe evidence and synthetic/oracle truth must remain strictly separated.

## Tests

For non-trivial changes, preserve coverage for:

- signature verification
- tampered raw bodies
- stale timestamps
- live-mode rejection
- account/source mismatch
- duplicate delivery
- conflicting duplicates
- out-of-order events
- API pagination
- transient/permanent Stripe failures
- worker replay
- exact Money
- currency isolation
- webhook/backfill convergence
- provider-neutral boundaries

Use real PostgreSQL where persistence/concurrency guarantees matter.

## External verification

Local fixtures prove adapter behavior.

They do not prove the actual Stripe external boundary.

Do not claim full external verification unless a real sandbox event successfully traverses:

```text
Stripe sandbox
→ authenticated ingress
→ immutable evidence
→ worker
→ processor interpretation
```

If credentials or external access are missing, report the verification as blocked.

## Required review before completion

For any non-trivial Stripe integration change, ask:

1. Could a live Stripe event enter the sandbox pipeline?
2. Could body parsing occur before signature verification?
3. Could invalid/stale signatures be accepted?
4. Could `2xx` be returned before durable acceptance?
5. Could duplicate delivery create a duplicate economic effect?
6. Could conflicting evidence overwrite history?
7. Could arrival order decide financial truth?
8. Could Stripe-specific types leak into provider-neutral core packages?
9. Could unsupported reversal/recovery economics be force-mapped instead of remaining UNKNOWN?
10. Could payout membership be inferred rather than proven?
11. Could money pass through unsafe floating point?
12. Could currencies be mixed?
13. Could Stripe API failure retry forever?
14. Could secrets or sensitive payloads be logged?
15. Could backfill falsely prove historical completeness?
16. Could runtime code gain simulator-oracle access?
17. Could synthetic bank evidence be presented as real-bank proof?

If any answer exposes unresolved correctness or security risk, do not report the change as complete.
