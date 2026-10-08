import assert from 'node:assert/strict';
import { test } from 'node:test';
import fc from 'fast-check';
import {
  classifyFailure,
  normalizationPayload,
  WorkFailure,
  type Claim,
} from '../src/index';
const claim: Claim = {
  id: 'work',
  eventId: 'event',
  handler: 'normalize-batch',
  handlerVersion: 1,
  attempt: 1,
  token: 'token',
  owner: 'owner',
  timeoutMs: 100,
  eventType: 'ingestion.normalization_requested',
  schemaVersion: 1,
  aggregateVersion: 1,
  bookId: 'book',
  batchId: 'batch',
  normalizerVersion: 'synthetic-movement-v1',
  payload: {
    bookId: 'book',
    batchId: 'batch',
    normalizerVersion: 'synthetic-movement-v1',
  },
};
test('registry rejects unknown handler/event/payload versions before execution', () => {
  assert.deepEqual(normalizationPayload(claim), {
    batchId: 'batch',
    version: 'synthetic-movement-v1',
  });
  for (const patch of [
    { handler: 'arbitrary' },
    { handlerVersion: 2 },
    { eventType: 'unknown' },
    { schemaVersion: 2 },
    { aggregateVersion: 2 },
  ])
    assert.throws(
      () => normalizationPayload({ ...claim, ...patch }),
      WorkFailure,
    );
  for (const payload of [
    null,
    [],
    {},
    'json',
    { ...(claim.payload as object), extra: 'field' },
  ])
    assert.throws(
      () => normalizationPayload({ ...claim, payload }),
      WorkFailure,
    );
});
test('transient/unknown errors remain retryable; explicit poison and domain errors are terminal classifications', () => {
  for (const code of ['40001', '40P01', '08006', '57014', '55P03'])
    assert.equal(classifyFailure({ code }).classification, 'TRANSIENT');
  for (const code of ['P2001', '23514', '22023'])
    assert.equal(classifyFailure({ code }).classification, 'DOMAIN_REJECTION');
  assert.deepEqual(classifyFailure(new Error('sensitive raw input')), {
    classification: 'TRANSIENT',
    code: 'UNKNOWN_FAILURE',
  });
  assert.equal(
    classifyFailure(new WorkFailure('POISON', 'INVALID_PAYLOAD'))
      .classification,
    'POISON',
  );
});
test('1,000 generated incompatible contracts never dispatch; payload identity remains untouched', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 2, max: 100000 }),
      fc.constantFrom('schemaVersion', 'aggregateVersion', 'handlerVersion'),
      (version, field) => {
        const input = { ...claim, [field]: version };
        const before = JSON.stringify(input);
        assert.throws(() => normalizationPayload(input), WorkFailure);
        assert.equal(JSON.stringify(input), before);
      },
    ),
    { numRuns: 1000, seed: 71001 },
  );
});
test('1,000 arbitrary exception messages and unsafe codes never enter operational logs', () => {
  fc.assert(
    fc.property(fc.string(), (message) => {
      assert.deepEqual(classifyFailure(new Error(message)), {
        classification: 'TRANSIENT',
        code: 'UNKNOWN_FAILURE',
      });
      const f = classifyFailure({ code: 'unsafe ' + message });
      assert.equal(f.code, 'UNKNOWN_FAILURE');
    }),
    { numRuns: 1000, seed: 71002 },
  );
});
