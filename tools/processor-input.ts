import type { SystemInput } from '@flow/simulator';
import { canonicalJson, type BatchCommand } from '@flow/ingestion-domain';
/** Only public processor reports. No bank stream or internal/oracle expectations are interpreted. */
export function simulatorSettlementBatch(
  input: SystemInput,
  sourceAccountId: string,
  batchKey: string,
): BatchCommand {
  return {
    sourceAccountId,
    batchKey,
    actorId: 'synthetic-processor-cli',
    provenance: { adapterVersion: 'simulator-settlements-v1' },
    records: input.settlements.map((r, index) => {
      if (r.sourceAccountId !== input.scope.processorAccountId)
        throw new TypeError('Mixed settlement source account');
      return {
        locator: String(index),
        objectKind: 'synthetic-settlement',
        externalId: r.id,
        sourceRevision: null,
        sequence: null,
        sourceObservedAt: r.reportedAt,
        bytes: Buffer.from(canonicalJson(r), 'utf8'),
      };
    }),
  };
}
