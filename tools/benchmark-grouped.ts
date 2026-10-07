import { readFile } from 'node:fs/promises';
import { Money } from '@flow/money';
import { evaluateGrouped } from '@flow/reconciliation-domain';
import type { SystemInput } from '@flow/simulator';
async function main() {
  const path = process.argv[2];
  if (!path) throw new Error('Supply public simulator input.json');
  const input = JSON.parse(await readFile(path, 'utf8')) as SystemInput;
  const processors = input.settlements.map((p) => ({
    id: p.id,
    externalId: p.id,
    eligible: true,
    reference: p.transferReference,
    amount: Money.fromJSON(p.net),
    time: p.reportedAt,
    declarations: p.payoutMemberIds ? [p.payoutMemberIds] : [],
  }));
  const banks = input.bankObservations.map((b) => ({
    id: b.id,
    eligible: true,
    reference: b.transferReference,
    amount: Money.fromJSON(b.amount),
    time: b.bookedAt,
  }));
  const start = performance.now(),
    result = evaluateGrouped(processors, banks);
  console.log(
    JSON.stringify({
      processorSettlements: processors.length,
      bankMovements: banks.length,
      groupingPartitions: result.groupingPartitions,
      candidateGroups: result.candidates.length,
      acceptedGroups: result.candidates.filter(
        (c) => result.outcomes.get(c.bank) === 'MATCHED',
      ).length,
      ambiguousGroups: result.candidates.filter(
        (c) => result.outcomes.get(c.bank) === 'AMBIGUOUS',
      ).length,
      durationMs: performance.now() - start,
      peakRssKiB: process.resourceUsage().maxRSS,
    }),
  );
}
main().catch(() => {
  console.error('Grouped public-input benchmark failed');
  process.exitCode = 1;
});
