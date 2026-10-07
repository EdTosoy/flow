import type { SystemInput } from '@flow/simulator';
import { canonicalJson, type BatchCommand } from '@flow/ingestion-domain';
/** Only public booked bank evidence; received rows do not establish expected source counts. */
export function simulatorBankBatch(
  input: SystemInput,
  sourceAccountId: string,
  batchKey: string,
  artifactBytes?: Uint8Array,
): BatchCommand {
  return {
    sourceAccountId,
    batchKey,
    actorId: 'synthetic-bank-cli',
    provenance: { adapterVersion: 'simulator-bank-v1' },
    artifactBytes: artifactBytes ?? Buffer.from(canonicalJson(input), 'utf8'),
    records: input.bankObservations.map((b, index) => {
      if (b.sourceAccountId !== input.scope.bankAccountId)
        throw new TypeError('Mixed bank source account');
      return {
        locator: String(index),
        objectKind: 'synthetic-bank-entry',
        externalId: b.id,
        sourceRevision: null,
        sequence: null,
        sourceObservedAt: null,
        bytes: Buffer.from(canonicalJson(b), 'utf8'),
      };
    }),
  };
}
