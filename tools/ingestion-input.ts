import type { SystemInput } from '@flow/simulator';
import {
  canonicalJson,
  boundedText,
  type BatchCommand,
  type RawInput,
} from '@flow/ingestion-domain';

/** Only public processor-event evidence crosses this adapter. Other Phase 2 streams are deferred. */
export function simulatorBatch(
  input: SystemInput,
  sourceAccountId: string,
  batchKey: string,
  artifactBytes?: Uint8Array,
): BatchCommand {
  const records: RawInput[] = input.processorEvents.map((e, index) => {
    if (e.sourceAccountId !== input.scope.processorAccountId)
      throw new TypeError('Mixed source account artifact');
    let externalId: string | null = null;
    try {
      const r: unknown = JSON.parse(e.payload);
      if (
        r &&
        typeof r === 'object' &&
        'id' in r &&
        typeof r.id === 'string' &&
        r.id.length > 0 &&
        r.id.length <= 512
      ) {
        boundedText(r.id);
        externalId = r.id;
      }
    } catch {
      /* Malformed evidence is accepted, then explicitly fails normalization. */
    }
    return {
      locator: `${index}:${e.deliveryId}`,
      objectKind: 'synthetic-movement',
      externalId,
      sourceRevision: null,
      bytes: Buffer.from(e.payload, 'utf8'),
      sequence: null,
      sourceObservedAt: e.deliveredAt,
    };
  });
  return {
    sourceAccountId,
    batchKey,
    actorId: 'synthetic-ingestion-cli',
    records,
    provenance: {
      adapterVersion: 'simulator-input-v1',
      sourceAccountId: input.scope.processorAccountId,
      envelopes: input.processorEvents.map((e) => ({
        deliveryId: e.deliveryId,
        eventId: e.eventId,
        occurredAt: e.occurredAt,
        deliveredAt: e.deliveredAt,
      })),
    },
    artifactBytes: artifactBytes ?? Buffer.from(canonicalJson(input), 'utf8'),
  };
}
