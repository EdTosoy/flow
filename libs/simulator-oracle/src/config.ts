import { Money, MAX_MINOR_UNITS } from '@flow/money';

export const SIMULATOR_VERSION = 'phase2-v1' as const;
export const ANOMALY_KINDS = [
  'duplicate-source-event',
  'missing-source-event',
  'out-of-order-event',
  'delayed-event',
  'duplicate-settlement',
  'missing-settlement',
  'incorrect-amount',
  'unexpected-processor-fee',
  'missing-bank-transaction',
  'duplicate-bank-observation',
  'wrong-reference',
  'corrupted-source-record',
  'missing-ledger-posting',
  'duplicate-ledger-command',
] as const;
export type AnomalyKind = (typeof ANOMALY_KINDS)[number];
export interface AnomalySelection {
  readonly count?: number;
  /** Zero-based index into the documented canonical eligible collection. */
  readonly placements?: readonly number[];
}
export interface SimulationConfig {
  readonly version?: typeof SIMULATOR_VERSION;
  readonly seed: number;
  readonly paymentCount: number;
  readonly startTime?: string;
  readonly batchSizeRange?: readonly [number, number];
  readonly amountMinorRange?: readonly [string, string];
  readonly feeBasisPoints?: number;
  readonly feeFixedMinor?: string;
  readonly fullRefundCount?: number;
  readonly partialRefundCount?: number;
  readonly chargebackCount?: number;
  readonly delayMilliseconds?: number;
  readonly anomalies?: Partial<Record<AnomalyKind, AnomalySelection>>;
}
export interface ResolvedConfig {
  readonly version: typeof SIMULATOR_VERSION;
  readonly seed: number;
  readonly paymentCount: number;
  readonly startTime: string;
  readonly batchSizeRange: readonly [number, number];
  readonly amountMinorRange: readonly [string, string];
  readonly feeBasisPoints: number;
  readonly feeFixedMinor: string;
  readonly fullRefundCount: number;
  readonly partialRefundCount: number;
  readonly chargebackCount: number;
  readonly delayMilliseconds: number;
  readonly anomalies: Readonly<
    Partial<
      Record<
        AnomalyKind,
        Required<Pick<AnomalySelection, 'count'>> &
          Pick<AnomalySelection, 'placements'>
      >
    >
  >;
}
function integer(
  value: number,
  min: number,
  max: number,
  name: string,
): number {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new RangeError(`Invalid ${name}`);
  return value;
}
export function resolveConfig(config: SimulationConfig): ResolvedConfig {
  const allowed = [
    'version',
    'seed',
    'paymentCount',
    'startTime',
    'batchSizeRange',
    'amountMinorRange',
    'feeBasisPoints',
    'feeFixedMinor',
    'fullRefundCount',
    'partialRefundCount',
    'chargebackCount',
    'delayMilliseconds',
    'anomalies',
  ];
  if (
    !config ||
    typeof config !== 'object' ||
    Object.keys(config).some((k) => !allowed.includes(k))
  )
    throw new TypeError('Unknown simulation configuration');
  if ((config.version ?? SIMULATOR_VERSION) !== SIMULATOR_VERSION)
    throw new TypeError('Unsupported simulator version');
  const seed = integer(config.seed, 0, 0xffffffff, 'explicit uint32 seed');
  const paymentCount = integer(config.paymentCount, 1, 1000000, 'paymentCount');
  const startTime = config.startTime ?? '2026-01-01T00:00:00.000Z';
  if (
    typeof startTime !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(startTime) ||
    !Number.isFinite(Date.parse(startTime)) ||
    new Date(startTime).toISOString() !== startTime
  )
    throw new TypeError('Expected canonical UTC startTime');
  const batch = config.batchSizeRange ?? [10, 30];
  if (!Array.isArray(batch) || batch.length !== 2)
    throw new TypeError('Invalid batchSizeRange');
  const batchSizeRange = [
    integer(batch[0]!, 1, 1000000, 'minimum batch size'),
    integer(batch[1]!, batch[0]!, 1000000, 'maximum batch size'),
  ] as const;
  const amounts = config.amountMinorRange ?? ['10000', '1000000'];
  if (
    !Array.isArray(amounts) ||
    amounts.length !== 2 ||
    typeof amounts[0] !== 'string' ||
    typeof amounts[1] !== 'string'
  )
    throw new TypeError('Invalid amountMinorRange');
  const min = Money.parse(amounts[0]!, 'PHP');
  const max = Money.parse(amounts[1]!, 'PHP');
  if (
    min.amountMinor < 2n ||
    max.amountMinor < min.amountMinor ||
    max.amountMinor * BigInt(Math.min(batchSizeRange[1], paymentCount)) >
      MAX_MINOR_UNITS
  )
    throw new RangeError('Invalid or overflowing amount/batch range');
  const feeBasisPoints = integer(
    config.feeBasisPoints ?? 300,
    0,
    10000,
    'feeBasisPoints',
  );
  const feeFixedMinor = config.feeFixedMinor ?? '0';
  if (typeof feeFixedMinor !== 'string')
    throw new TypeError('feeFixedMinor requires an integer string');
  const fixed = Money.parse(feeFixedMinor, 'PHP');
  if (
    fixed.amountMinor < 0n ||
    (min.amountMinor * BigInt(feeBasisPoints)) / 10000n + fixed.amountMinor >
      min.amountMinor
  )
    throw new RangeError('Fee exceeds smallest capture');
  const fullRefundCount = integer(
    config.fullRefundCount ?? 0,
    0,
    paymentCount,
    'fullRefundCount',
  );
  const partialRefundCount = integer(
    config.partialRefundCount ?? 0,
    0,
    paymentCount,
    'partialRefundCount',
  );
  const chargebackCount = integer(
    config.chargebackCount ?? 0,
    0,
    paymentCount,
    'chargebackCount',
  );
  if (fullRefundCount + partialRefundCount + chargebackCount > paymentCount)
    throw new RangeError('Refund/chargeback selections must be disjoint');
  const delayMilliseconds = integer(
    config.delayMilliseconds ?? 604800000,
    1,
    31536000000,
    'delayMilliseconds',
  );
  const endTime =
    Date.parse(startTime) +
    paymentCount * 60000 +
    3 * 86400000 +
    delayMilliseconds;
  if (
    !Number.isSafeInteger(endTime) ||
    !Number.isFinite(new Date(endTime).getTime()) ||
    endTime > Date.parse('9999-12-31T00:00:00.000Z')
  )
    throw new RangeError('Simulation time overflows supported calendar');
  const anomalies: Record<string, { count: number; placements?: number[] }> =
    {};
  if (
    config.anomalies !== undefined &&
    (config.anomalies === null ||
      typeof config.anomalies !== 'object' ||
      Array.isArray(config.anomalies))
  )
    throw new TypeError('Invalid anomalies');
  for (const [kind, selection] of Object.entries(config.anomalies ?? {})) {
    if (
      !(ANOMALY_KINDS as readonly string[]).includes(kind) ||
      !selection ||
      Object.keys(selection).some((k) => k !== 'count' && k !== 'placements')
    )
      throw new TypeError('Unknown anomaly configuration');
    const placements = selection.placements;
    if (
      placements !== undefined &&
      (!Array.isArray(placements) ||
        new Set(placements).size !== placements.length)
    )
      throw new TypeError('Anomaly placements must be distinct indices');
    const count = integer(
      selection.count ?? placements?.length ?? 0,
      0,
      10000000,
      'anomaly count',
    );
    if (placements !== undefined && count !== placements.length)
      throw new RangeError('Anomaly count must equal placement count');
    if (count > 0)
      anomalies[kind] =
        placements === undefined
          ? { count }
          : {
              count,
              placements: [...placements]
                .map((p) => integer(p, 0, 10000000, 'placement'))
                .sort((a, b) => a - b),
            };
  }
  return {
    version: SIMULATOR_VERSION,
    seed,
    paymentCount,
    startTime,
    batchSizeRange,
    amountMinorRange: [amounts[0]!, amounts[1]!],
    feeBasisPoints,
    feeFixedMinor: fixed.amountMinor.toString(),
    fullRefundCount,
    partialRefundCount,
    chargebackCount,
    delayMilliseconds,
    anomalies,
  };
}
