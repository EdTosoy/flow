# ADR-003 — Exact money with explicit units

Status: proposed. Date: 2026-10-07.

## Context

JavaScript Number and binary floating point cannot safely represent arbitrary financial amounts or decimal operations. Currency scales and provider unit conventions vary.

## Decision

Use BIGINT integer minor units with explicit currency/metadata for amounts, TypeScript bigint and JSON integer strings. Source parsing is lossless before Number conversion. Use exact NUMERIC/decimal strings for fractional evidence such as rates, with declared precision/scale and finite-value validation. V1 journals are single currency; FX is deferred. Round only under explicit policy with visible residual accounting. See INV-009 and [data model](../data-model.md).

## Consequences and alternatives

Bigint serialization and ORM mapping need explicit adapters; aggregate totals can exceed an individual BIGINT range and use wider exact types. Decimal major units could be exact but invite unit/scale ambiguity; integer units simplify V1. Integer representation alone cannot validate currency or correct rounding. Do not use PostgreSQL MONEY or FLOAT for financial values.

## Revisit and verification

Introduce approved decimal arithmetic dependency only when fractional financial calculation is required, after checking installed/current API. Verify algebra, scale/sign/bounds, large source tokens and JSON round trips with property tests.
