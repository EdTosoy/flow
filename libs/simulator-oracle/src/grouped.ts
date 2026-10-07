import { Money } from '@flow/money';
import {
  sha256,
  stableJson,
  type BankObservation,
  type SettlementReport,
  type SystemInput,
} from '@flow/simulator';
import { generateSimulation, type SimulationConfig } from './index';
/** Private source generator: declares processor transfer membership BEFORE producing bank artifacts. */
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}
export function generateGroupedSimulation(
  config: SimulationConfig,
  groupSize: number,
) {
  if (!Number.isSafeInteger(groupSize) || groupSize < 2 || groupSize > 32)
    throw new RangeError('Group size must be 2..32');
  const base = generateSimulation(config);
  if (base.oracle.anomalies.length)
    throw new TypeError(
      'Grouped generator v1 requires uncorrupted base; adversarial imports are separate tests',
    );
  const settlements: SettlementReport[] = [],
    bank: BankObservation[] = [];
  const groups: {
    reference: string;
    settlementIds: string[];
    amountMinor: string;
    bankId: string | null;
  }[] = [];
  for (
    let offset = 0;
    offset < base.input.settlements.length;
    offset += groupSize
  ) {
    const reports = base.input.settlements.slice(offset, offset + groupSize);
    const reference = reports[0]!.transferReference;
    const settlementIds = reports.map((r) => r.id);
    const currency = reports[0]!.net.currency;
    let total = 0n;
    for (const r of reports) {
      const m = Money.fromJSON(r.net);
      if (m.currency !== currency)
        throw new TypeError('Cross-currency source grouping');
      total += m.amountMinor;
      settlements.push({
        ...r,
        transferReference: reference,
        ...(reports.length >= 2 ? { payoutMemberIds: settlementIds } : {}),
      });
    }
    const amount = Money.of(total, currency);
    const bookedAt = new Date(
      Math.max(...reports.map((r) => Date.parse(r.reportedAt))) + 86400000,
    ).toISOString();
    const bankId =
      total === 0n ? null : 'group-bank-' + sha256(reference).slice(0, 32);
    if (bankId)
      bank.push({
        id: bankId,
        sourceAccountId: base.input.scope.bankAccountId,
        transferReference: reference,
        status: 'booked',
        bookedAt,
        amount: amount.toJSON(),
      });
    groups.push({
      reference,
      settlementIds,
      amountMinor: total.toString(),
      bankId,
    });
  }
  const input: SystemInput = {
    ...base.input,
    settlements,
    bankObservations: bank,
  };
  const replay = {
    version: 'phase7-grouped-v1',
    base: base.oracle.replay,
    groupSize,
  };
  const inputSha256 = sha256(stableJson(input));
  return freeze({
    input,
    manifest: {
      ...base.manifest,
      simulatorVersion: replay.version,
      scenarioId: 'grouped-' + inputSha256.slice(0, 24),
      configuration: {
        version: replay.version,
        base: base.manifest.configuration,
        groupSize,
      },
      configurationSha256: sha256(
        stableJson({
          version: replay.version,
          base: base.manifest.configuration,
          groupSize,
        }),
      ),
      inputSha256,
      recordCounts: {
        ...base.manifest.recordCounts,
        bankObservations: bank.length,
      },
    },
    oracle: { replay, base: base.oracle, groups, bank, settlements },
  });
}
