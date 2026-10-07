import { canonicalJson } from '@flow/ingestion-domain';
import {
  evidence,
  evaluate,
  MAX_GROUP_SIZE,
  type Outcome,
  type RuleInput,
} from './index';
export interface GroupedInput extends RuleInput {
  readonly externalId: string;
  /** All declarations from preserved variants; uncertain revisions may block competitors. */
  readonly declarations: readonly (readonly string[])[];
}
export interface GroupCandidate {
  readonly key: string;
  readonly processors: readonly string[];
  readonly bank: string;
  readonly valid: boolean;
  readonly limitExceeded: boolean;
  readonly totalMinor: string;
}
/** Whole declared sets only. Never search subsets, and never discard colliding failed candidates. */
export function evaluateGrouped(
  processors: readonly GroupedInput[],
  banks: readonly RuleInput[],
) {
  if (
    new Set([...processors, ...banks].map((x) => x.id)).size !==
    processors.length + banks.length
  )
    throw new TypeError('Duplicate item identity');
  const declarations = new Map<
    string,
    { reference: string; currency: string; members: readonly string[] }
  >();
  for (const p of processors)
    for (const members of p.declarations)
      if (p.reference !== null) {
        const claim = {
          reference: p.reference,
          currency: p.amount.currency,
          members: [...members].sort(),
        };
        declarations.set(canonicalJson(claim), claim);
      }
  const declared = new Set(
    [...declarations.values()].flatMap((x) => x.members),
  );
  const refs = new Set([...declarations.values()].map((x) => x.reference));
  const pairs = evaluate(
    processors.filter(
      (p) => !declared.has(p.externalId) && !refs.has(p.reference ?? ''),
    ),
    banks.filter((b) => !refs.has(b.reference ?? '')),
  );
  if (
    declarations.size > 256 ||
    processors.reduce((n, p) => n + p.declarations.length, 0) > 10000
  )
    throw new RangeError('Unsupported grouped declaration/variant bound');
  const byExternal = new Map<string, GroupedInput[]>();
  for (const p of processors)
    byExternal.set(p.externalId, [...(byExternal.get(p.externalId) ?? []), p]);
  const candidates: GroupCandidate[] = [];
  for (const [key, claim] of declarations) {
    const members = [...new Set(claim.members)].flatMap(
      (id) => byExternal.get(id) ?? [],
    );
    const total = members.reduce((sum, p) => sum + p.amount.amountMinor, 0n);
    const complete =
      members.length === claim.members.length &&
      new Set(claim.members).size === claim.members.length;
    const agrees =
      !processors.some(
        (p) =>
          p.reference === claim.reference &&
          !claim.members.includes(p.externalId),
      ) &&
      members.every(
        (p) =>
          p.reference === claim.reference &&
          p.amount.currency === claim.currency &&
          p.declarations.length === 1 &&
          canonicalJson([...p.declarations[0]!].sort()) ===
            canonicalJson(claim.members),
      );
    for (const b of banks)
      if (
        b.reference === claim.reference &&
        b.amount.currency === claim.currency
      ) {
        // Compare each member's non-amount predicates; total equality is a separate exact check.
        const valid =
          complete &&
          agrees &&
          members.length >= 2 &&
          members.length <= MAX_GROUP_SIZE &&
          b.eligible &&
          members.every((p) => {
            const checks = evidence(p, b);
            return (
              p.eligible &&
              checks.currencyExact &&
              checks.referenceExact &&
              checks.directionCompatible &&
              checks.bookingWindowValid
            );
          }) &&
          total === b.amount.amountMinor;
        candidates.push({
          key,
          processors: members.map((p) => p.id).sort(),
          bank: b.id,
          valid,
          limitExceeded: claim.members.length > MAX_GROUP_SIZE,
          totalMinor: total.toString(),
        });
      }
  }
  if (candidates.length > 4096)
    throw new RangeError('Unsupported grouped candidate bound');
  const incidence = new Map<string, GroupCandidate[]>();
  for (const c of candidates)
    for (const id of [c.bank, ...c.processors])
      incidence.set(id, [...(incidence.get(id) ?? []), c]);
  const outcomes = new Map<string, Outcome>();
  for (const item of [...processors, ...banks]) {
    const own = incidence.get(item.id) ?? [];
    const competing = own.some((c) =>
      [c.bank, ...c.processors].some(
        (id) => (incidence.get(id)?.length ?? 0) > 1,
      ),
    );
    outcomes.set(
      item.id,
      !item.eligible
        ? 'INELIGIBLE'
        : own.some((c) => c.limitExceeded)
          ? 'INELIGIBLE'
          : own.length > 1 || competing
            ? 'AMBIGUOUS'
            : own[0]?.valid
              ? 'MATCHED'
              : (pairs.get(item.id) ?? 'UNMATCHED'),
    );
  }
  return { candidates, outcomes, groupingPartitions: declarations.size };
}
