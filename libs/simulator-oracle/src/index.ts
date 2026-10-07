import { Money, type MoneyJson } from '@flow/money';
import {
  sha256,
  stableJson,
  type SystemInput,
  type InternalExpectation,
  type ProcessorActivity,
  type SettlementReport,
  type BankObservation,
  type SourceEvent,
  type CaptureAttempt,
  type ScenarioManifest,
} from '@flow/simulator';
import {
  resolveConfig,
  ANOMALY_KINDS,
  type SimulationConfig,
  type ResolvedConfig,
  type AnomalyKind,
} from './config';
import { Random } from './random';
export { resolveConfig, SIMULATOR_VERSION, ANOMALY_KINDS } from './config';
export type {
  SimulationConfig,
  ResolvedConfig,
  AnomalyKind,
  AnomalySelection,
} from './config';

export interface PaymentTruth {
  readonly id: string;
  readonly payerId: string;
  readonly captureExpectationId: string;
  readonly captureActivityId: string;
  readonly feeActivityId: string;
  readonly adjustmentActivityId: string | null;
  readonly adjustmentKind:
    'full-refund' | 'partial-refund' | 'chargeback' | null;
  readonly gross: MoneyJson;
  readonly refundableRemaining: MoneyJson;
  readonly settlementId: string;
}
export interface AnomalyTruth {
  readonly id: string;
  readonly kind: AnomalyKind;
  readonly collection:
    'processorEvents' | 'settlements' | 'bankObservations' | 'captureAttempts';
  readonly canonicalIndex: number;
  readonly canonicalId: string;
  readonly observedIds: readonly string[];
  readonly before: unknown;
  readonly after: unknown;
  readonly expectedControl: string;
  /** Observed minus canonical monetary contribution, when defined. */
  readonly discrepancy: MoneyJson | null;
}
export interface Oracle {
  readonly replay: ResolvedConfig;
  readonly payments: readonly PaymentTruth[];
  readonly activities: readonly ProcessorActivity[];
  readonly settlements: readonly SettlementReport[];
  readonly bank: readonly BankObservation[];
  readonly expectedCaptureEffects: readonly InternalExpectation[];
  readonly anomalies: readonly AnomalyTruth[];
}
export interface Simulation {
  readonly manifest: ScenarioManifest;
  readonly input: SystemInput;
  readonly oracle: Oracle;
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

/** Test harness only: canonical economics first, observed corruption second. */
export function generateSimulation(
  configuration: SimulationConfig,
): Simulation {
  const config = resolveConfig(configuration);
  const configurationSha256 = sha256(stableJson(config));
  const scenarioId = `syn_scenario_${configurationSha256.slice(0, 32)}`;
  // Economics/identities do not depend on faults. Fault-only changes preserve canonical truth.
  const {
    anomalies: _anomalies,
    delayMilliseconds: _delay,
    ...economicConfig
  } = config;
  void _anomalies;
  void _delay;
  const namespace = sha256(stableJson(economicConfig));
  const id = (kind: string, index: number | string): string =>
    `syn_${kind}_${sha256(`${namespace}:${kind}:${index}`).slice(0, 32)}`;
  const base = Date.parse(config.startTime);
  const time = (offset: number): string =>
    new Date(base + offset).toISOString();
  const money = (amount: bigint): Money => Money.of(amount, 'PHP');
  const zero = (): Money => money(0n);
  const rng = new Random(config.seed, 'economics');
  const adjustmentRng = new Random(config.seed, 'adjustment-selection');
  const selections = adjustmentRng.sample(
    config.paymentCount,
    config.fullRefundCount + config.partialRefundCount + config.chargebackCount,
  );
  const adjustments = new Map<number, PaymentTruth['adjustmentKind']>();
  selections.forEach((index, i) =>
    adjustments.set(
      index,
      i < config.fullRefundCount
        ? 'full-refund'
        : i < config.fullRefundCount + config.partialRefundCount
          ? 'partial-refund'
          : 'chargeback',
    ),
  );
  const merchantId = id('merchant', 0);
  const processorAccountId = id('processor_account', 0);
  const bankAccountId = id('bank_account', 0);
  const expectations: InternalExpectation[] = [];
  const captureEffects: InternalExpectation[] = [];
  const activities: ProcessorActivity[] = [];
  const canonicalEvents: SourceEvent[] = [];
  const canonicalAttempts: CaptureAttempt[] = [];
  const payments: PaymentTruth[] = [];
  const settlements: SettlementReport[] = [];
  const bank: BankObservation[] = [];
  const min = Money.parse(config.amountMinorRange[0], 'PHP').amountMinor;
  const max = Money.parse(config.amountMinorRange[1], 'PHP').amountMinor;
  const fixed = Money.parse(config.feeFixedMinor, 'PHP');
  let batchMembers: string[] = [];
  let batchPayments: Omit<PaymentTruth, 'settlementId'>[] = [];
  let gross = zero(),
    fees = zero(),
    refunds = zero(),
    chargebacks = zero();
  let batchSize = rng.integer(...config.batchSizeRange);
  function activity(
    kind: ProcessorActivity['kind'],
    index: number,
    reference: string,
    parent: string | null,
    amount: Money,
    occurredAt: string,
  ): ProcessorActivity {
    const record: ProcessorActivity = {
      id: id(kind, index),
      kind,
      paymentReference: reference,
      parentCaptureId: parent,
      amount: amount.toJSON(),
      occurredAt,
    };
    activities.push(record);
    batchMembers.push(record.id);
    canonicalEvents.push({
      deliveryId: id('delivery', record.id),
      sourceAccountId: processorAccountId,
      eventId: id('event', record.id),
      occurredAt,
      deliveredAt: new Date(Date.parse(occurredAt) + 1000).toISOString(),
      payload: stableJson(record),
    });
    return record;
  }
  for (let i = 0; i < config.paymentCount; i++) {
    const paymentId = id('pay', i);
    const payerId = id(
      'payer',
      rng.integer(0, Math.max(0, Math.floor(config.paymentCount / 3))),
    );
    const occurredAt = time(i * 60000 + rng.integer(0, 999));
    const amount = money(rng.bigint(min, max));
    // Exact integer basis-point fee; floor per capture, no refund of original fee.
    const fee = money(
      (amount.amountMinor * BigInt(config.feeBasisPoints)) / 10000n,
    ).add(fixed);
    const expectation: InternalExpectation = {
      id: id('internal_capture', i),
      paymentReference: paymentId,
      payerId,
      kind: 'capture',
      amount: amount.toJSON(),
      occurredAt,
    };
    expectations.push(expectation);
    captureEffects.push(expectation);
    canonicalAttempts.push({
      attemptId: id('attempt', i),
      commandKey: id('command', i),
      expectation,
    });
    const capture = activity('capture', i, paymentId, null, amount, occurredAt);
    const feeActivity = activity(
      'fee',
      i,
      paymentId,
      capture.id,
      zero().subtract(fee),
      new Date(Date.parse(occurredAt) + 1000).toISOString(),
    );
    gross = gross.add(amount);
    fees = fees.add(fee);
    const adjustmentKind = adjustments.get(i) ?? null;
    let adjustmentActivityId: string | null = null;
    let remaining = amount;
    if (adjustmentKind !== null) {
      const debit =
        adjustmentKind === 'partial-refund'
          ? money(rng.bigint(1n, amount.amountMinor - 1n))
          : amount;
      const kind = adjustmentKind === 'chargeback' ? 'chargeback' : 'refund';
      const adjustmentTime = new Date(
        Date.parse(occurredAt) + 10000,
      ).toISOString();
      adjustmentActivityId = activity(
        kind,
        i,
        paymentId,
        capture.id,
        zero().subtract(debit),
        adjustmentTime,
      ).id;
      if (kind === 'refund') {
        refunds = refunds.add(debit);
        expectations.push({
          id: id('internal_refund', i),
          paymentReference: paymentId,
          payerId,
          kind: 'refund',
          amount: debit.toJSON(),
          occurredAt: adjustmentTime,
        });
      } else chargebacks = chargebacks.add(debit);
      remaining = remaining.subtract(debit);
    }
    batchPayments.push({
      id: paymentId,
      payerId,
      captureExpectationId: expectation.id,
      captureActivityId: capture.id,
      feeActivityId: feeActivity.id,
      adjustmentActivityId,
      adjustmentKind,
      gross: amount.toJSON(),
      refundableRemaining: remaining.toJSON(),
    });
    if (batchPayments.length === batchSize || i === config.paymentCount - 1) {
      const batchIndex = settlements.length;
      const settlementId = id('settlement', batchIndex);
      const net = gross.subtract(fees).subtract(refunds).subtract(chargebacks);
      const report: SettlementReport = {
        id: settlementId,
        sourceAccountId: processorAccountId,
        transferReference: id('transfer', batchIndex),
        reportedAt: time(i * 60000 + 86400000),
        componentIds: batchMembers,
        gross: gross.toJSON(),
        fees: fees.toJSON(),
        refunds: refunds.toJSON(),
        chargebacks: chargebacks.toJSON(),
        net: net.toJSON(),
      };
      settlements.push(report);
      for (const p of batchPayments) payments.push({ ...p, settlementId });
      if (net.amountMinor !== 0n)
        bank.push({
          id: id('bank', batchIndex),
          sourceAccountId: bankAccountId,
          transferReference: report.transferReference,
          status: 'booked',
          bookedAt: time(i * 60000 + 2 * 86400000),
          amount: net.toJSON(),
        });
      batchMembers = [];
      batchPayments = [];
      gross = zero();
      fees = zero();
      refunds = zero();
      chargebacks = zero();
      batchSize = rng.integer(...config.batchSizeRange);
    }
  }
  const input = corrupt(config, id, {
    scope: {
      environment: 'synthetic',
      merchantId,
      processorAccountId,
      bankAccountId,
    },
    internalExpectations: expectations,
    processorEvents: canonicalEvents,
    settlements,
    bankObservations: bank,
    captureAttempts: canonicalAttempts,
  });
  const safeAnomalies = Object.fromEntries(
    Object.entries(config.anomalies).map(([kind, s]) => [
      kind,
      { count: s.count },
    ]),
  );
  const manifest: ScenarioManifest = {
    scenarioId,
    simulatorVersion: config.version,
    seed: config.seed,
    startTime: config.startTime,
    configuration: {
      ...economicConfig,
      delayMilliseconds: config.delayMilliseconds,
      anomalies: safeAnomalies,
    },
    configurationSha256,
    inputSha256: sha256(stableJson(input.input)),
    recordCounts: {
      internalExpectations: input.input.internalExpectations.length,
      processorEvents: input.input.processorEvents.length,
      settlements: input.input.settlements.length,
      bankObservations: input.input.bankObservations.length,
      captureAttempts: input.input.captureAttempts.length,
    },
  };
  return freeze({
    manifest,
    input: input.input,
    oracle: {
      replay: config,
      payments,
      activities,
      settlements,
      bank,
      expectedCaptureEffects: captureEffects,
      anomalies: input.anomalies,
    },
  });
}

const CONTROLS: Record<AnomalyKind, string> = {
  'duplicate-source-event':
    'Deduplicate receipts by source fact identity; retain delivery count',
  'missing-source-event':
    'Source membership/completeness and independent internal expectation remain unexplained',
  'out-of-order-event':
    'Retain unresolved prerequisites; later observations must resolve without invented facts',
  'delayed-event':
    'Virtual arrival cutoff leaves pending/overdue exposure until delivery',
  'duplicate-settlement':
    'Same payout identity retransmission must not create a second settlement/effect',
  'missing-settlement':
    'Expected processor balance transfer and bank evidence lack a reported counterpart',
  'incorrect-amount':
    'Internal/processor capture and settlement contribution disagree exactly',
  'unexpected-processor-fee':
    'Reported fee disagrees with contractual fee and settlement composition',
  'missing-bank-transaction': 'Reported settlement lacks booked bank evidence',
  'duplicate-bank-observation':
    'Same bank identity cannot be counted/allocated twice',
  'wrong-reference':
    'Reference conflict must not fall back to amount/date equality',
  'corrupted-source-record':
    'Malformed bytes require retained processing disposition and coverage failure',
  'missing-ledger-posting':
    'Independent internal capture has no posted financial effect',
  'duplicate-ledger-command':
    'Repeated unchanged command must have one financial effect',
};
function corrupt(
  config: ResolvedConfig,
  id: (kind: string, index: number | string) => string,
  canonical: SystemInput,
): { input: SystemInput; anomalies: AnomalyTruth[] } {
  const events = new Map<number, SourceEvent>();
  const removedEvents = new Set<number>();
  const removedSettlements = new Set<number>();
  const removedBank = new Set<number>();
  const removedAttempts = new Set<number>();
  const extraEvents: SourceEvent[] = [],
    extraSettlements: SettlementReport[] = [],
    extraBank: BankObservation[] = [],
    extraAttempts: CaptureAttempt[] = [];
  const changedBank = new Map<number, BankObservation>();
  const anomalies: AnomalyTruth[] = [];
  const reserved = new Set<string>();
  const lastDelivery = canonical.processorEvents.reduce(
    (max, e) => Math.max(max, Date.parse(e.deliveredAt)),
    -Infinity,
  );
  for (const kind of ANOMALY_KINDS) {
    const selection = config.anomalies[kind];
    if (!selection) continue;
    const collection: AnomalyTruth['collection'] = kind.includes('settlement')
      ? 'settlements'
      : kind.includes('bank') || kind === 'wrong-reference'
        ? 'bankObservations'
        : kind.includes('ledger')
          ? 'captureAttempts'
          : 'processorEvents';
    const records = canonical[collection];
    const eligible = records
      .map((_, i) => i)
      .filter((i) => {
        if (kind === 'out-of-order-event')
          return (
            Date.parse(canonical.processorEvents[i]!.deliveredAt) < lastDelivery
          );
        if (
          kind === 'incorrect-amount' ||
          kind === 'unexpected-processor-fee'
        ) {
          const activity = JSON.parse(
            canonical.processorEvents[i]!.payload,
          ) as ProcessorActivity;
          return (
            activity.kind === (kind === 'incorrect-amount' ? 'capture' : 'fee')
          );
        }
        return true;
      });
    // Placements index the kind-specific eligible collection; no silent clipping.
    let targets: number[];
    if (selection.placements) {
      targets = selection.placements.map((p) => {
        const target = eligible[p];
        if (target === undefined)
          throw new RangeError(
            `Placement outside eligible population: ${kind}`,
          );
        return target;
      });
    } else {
      const available = eligible.filter(
        (i) => !reserved.has(`${collection}:${i}`),
      );
      const rng = new Random(config.seed, `anomaly:${kind}`);
      targets = rng
        .sample(available.length, selection.count)
        .map((i) => available[i]!);
    }
    for (const index of targets.sort((a, b) => a - b)) {
      const reservation = `${collection}:${index}`;
      if (reserved.has(reservation))
        throw new RangeError(
          'Overlapping anomalies on one canonical record are unsupported',
        );
      reserved.add(reservation);
      const original = records[index]!;
      const canonicalId =
        'eventId' in original
          ? original.eventId
          : 'attemptId' in original
            ? original.attemptId
            : original.id;
      const anomalyId = id('anomaly', `${kind}:${canonicalId}`);
      let after: unknown = null;
      let observedIds: string[] = [];
      let discrepancy: MoneyJson | null = null;
      if (collection === 'processorEvents') {
        const event = canonical.processorEvents[index]!;
        let changed = { ...event };
        if (kind === 'duplicate-source-event') {
          changed = {
            ...event,
            deliveryId: id('duplicate_delivery', anomalyId),
          };
          extraEvents.push(changed);
          after = [event, changed];
          observedIds = [event.deliveryId, changed.deliveryId];
        } else if (kind === 'missing-source-event') removedEvents.add(index);
        else {
          if (kind === 'delayed-event')
            changed.deliveredAt = new Date(
              Date.parse(event.deliveredAt) + config.delayMilliseconds,
            ).toISOString();
          else if (kind === 'out-of-order-event')
            changed.deliveredAt = new Date(lastDelivery + 1).toISOString();
          else if (kind === 'corrupted-source-record')
            changed.payload = event.payload.slice(0, -1);
          else {
            const activity = JSON.parse(event.payload) as ProcessorActivity;
            const delta = Money.of(
              kind === 'incorrect-amount' ? 1n : -1n,
              'PHP',
            );
            changed.payload = stableJson({
              ...activity,
              amount: Money.fromJSON(activity.amount).add(delta).toJSON(),
            });
            discrepancy = delta.toJSON();
          }
          events.set(index, changed);
          after = changed;
          observedIds = [changed.deliveryId];
        }
      } else if (collection === 'settlements') {
        const report = canonical.settlements[index]!;
        if (kind === 'missing-settlement') removedSettlements.add(index);
        else {
          extraSettlements.push(report);
          after = [report, report];
          observedIds = [report.id, report.id];
        }
      } else if (collection === 'bankObservations') {
        const record = canonical.bankObservations[index]!;
        if (kind === 'missing-bank-transaction') removedBank.add(index);
        else if (kind === 'wrong-reference') {
          const changed = {
            ...record,
            transferReference: id('unrelated_reference', anomalyId),
          };
          changedBank.set(index, changed);
          after = changed;
          observedIds = [changed.id];
        } else {
          extraBank.push(record);
          after = [record, record];
          observedIds = [record.id, record.id];
        }
      } else {
        const attempt = canonical.captureAttempts[index]!;
        if (kind === 'missing-ledger-posting') removedAttempts.add(index);
        else {
          const changed = {
            ...attempt,
            attemptId: id('duplicate_attempt', anomalyId),
          };
          extraAttempts.push(changed);
          after = [attempt, changed];
          observedIds = [attempt.attemptId, changed.attemptId];
        }
      }
      anomalies.push({
        id: anomalyId,
        kind,
        collection,
        canonicalIndex: index,
        canonicalId,
        observedIds,
        before: original,
        after,
        expectedControl: CONTROLS[kind],
        discrepancy,
      });
    }
  }
  return {
    input: {
      ...canonical,
      processorEvents: [
        ...canonical.processorEvents.flatMap((e, i) =>
          removedEvents.has(i) ? [] : [events.get(i) ?? e],
        ),
        ...extraEvents,
      ].sort((a, b) =>
        a.deliveredAt < b.deliveredAt
          ? -1
          : a.deliveredAt > b.deliveredAt
            ? 1
            : a.deliveryId < b.deliveryId
              ? -1
              : a.deliveryId > b.deliveryId
                ? 1
                : 0,
      ),
      settlements: [
        ...canonical.settlements.filter((_, i) => !removedSettlements.has(i)),
        ...extraSettlements,
      ],
      bankObservations: [
        ...canonical.bankObservations.flatMap((b, i) =>
          removedBank.has(i) ? [] : [changedBank.get(i) ?? b],
        ),
        ...extraBank,
      ],
      captureAttempts: [
        ...canonical.captureAttempts.filter((_, i) => !removedAttempts.has(i)),
        ...extraAttempts,
      ],
    },
    anomalies,
  };
}
