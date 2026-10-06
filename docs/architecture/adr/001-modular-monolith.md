# ADR-001 — Modular monolith

Status: proposed. Date: 2026-10-07.

## Context

The project needs atomic financial commands, independently testable boundaries and a small initial operating footprint. There is no measured scaling or team-ownership requirement for distributed services.

## Decision

Use Nx, pnpm and TypeScript, with Next.js web, NestJS API and NestJS/TypeScript worker processes sharing domain/application libraries and PostgreSQL. Bound module ownership and acyclic dependencies as specified in the [overview](../README.md). The composition layer coordinates modules in a single transaction.

## Consequences and alternatives

Cross-module commands can be atomic without distributed transactions. Domain/persistence boundaries and import rules need enforcement; one repo/DB does not excuse arbitrary coupling. Independently deploying processes requires compatible schema/event changes. Microservices add failure and consistency boundaries without current benefit; a single tightly coupled package would reduce independent testing. Reconsider service extraction only for demonstrated scale, access isolation or organizational ownership that cannot be met in this topology.

## Verification gate

Nx module-boundary/cycle checks and pure domain tests at scaffold time; shared transaction integration tests for every cross-module financial command.
