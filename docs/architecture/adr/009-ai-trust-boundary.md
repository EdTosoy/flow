# ADR-009 — AI outside the trusted financial core

Status: proposed. Date: 2026-10-07.

## Context

Plausible generated explanations are not authenticated source evidence. Financial corrections and discrepancy resolution require exact facts, policy and accountable authorization.

## Decision

No AI subsystem in V1. If later justified, allow authorized read-only summaries/classification/evidence suggestions. Label outputs as suggestions, verify cited evidence and route decisions through normal controls. AI principals have no financial posting/history-editing/match-confirmation/case-resolution/money-movement capability. See INV-007.

## Consequences and alternatives

Financial correctness remains deterministic and testable. Human review cannot simply convert generated text into a source fact. Autonomous accounting or force-closing uncertain cases is rejected. This decision does not require adding an AI library, service or data schema today.

## Revisit and verification

Revisit product usefulness only after core controls exist. Prove capabilities/credentials block all financial writes and unsupported/invented evidence cannot pass confirmation guards.
