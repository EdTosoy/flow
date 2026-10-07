import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import fc from 'fast-check';
import { MIN_MINOR_UNITS, MAX_MINOR_UNITS } from '@flow/money';
import {
  normalize,
  canonicalJson,
  sha256,
  batchPayload,
  type BatchCommand,
} from '../src/index';
const valid = {
  id: 'movement-1',
  kind: 'capture',
  amount: { amountMinor: '970000', currency: 'PHP' },
  occurredAt: '2026-01-01T00:00:00.000Z',
  paymentReference: 'pay-1',
  parentCaptureId: null,
};
function raw(value: unknown): Buffer {
  return Buffer.from(canonicalJson(value));
}
test('strict malformed evidence, identity, money, timestamps and structure failures are safe codes', () => {
  for (const [value, code] of [
    ['{', 'INVALID_JSON'],
    [
      JSON.stringify({
        ...valid,
        amount: { amountMinor: 970000, currency: 'PHP' },
      }),
      'INVALID_MONEY',
    ],
    [
      JSON.stringify({
        ...valid,
        amount: { amountMinor: '970000', currency: 'EUR' },
      }),
      'INVALID_MONEY',
    ],
    [
      JSON.stringify({ ...valid, occurredAt: '2026-02-30T00:00:00.000Z' }),
      'INVALID_TIMESTAMP',
    ],
    [
      JSON.stringify({ ...valid, occurredAt: '2026-01-01T00:00:00+08:00' }),
      'INVALID_TIMESTAMP',
    ],
    [JSON.stringify({ ...valid, id: '' }), 'MISSING_IDENTITY'],
    [JSON.stringify({ ...valid, kind: 'invented' }), 'UNSUPPORTED_KIND'],
    [
      JSON.stringify({ ...valid, occurredAt: '0000-01-01T00:00:00.000Z' }),
      'INVALID_TIMESTAMP',
    ],
    [
      JSON.stringify({ ...valid, paymentReference: '\ud800' }),
      'INVALID_STRUCTURE',
    ],
    ['[]', 'INVALID_STRUCTURE'],
  ] as const)
    assert.deepEqual(
      normalize(Buffer.from(value), 'movement-1', 'synthetic-movement-v1'),
      { state: 'FAILED', code },
    );
  assert.deepEqual(
    normalize(Uint8Array.from([255]), 'movement-1', 'synthetic-movement-v1'),
    { state: 'FAILED', code: 'INVALID_ENCODING' },
  );
  assert.deepEqual(normalize(raw(valid), null, 'synthetic-movement-v1'), {
    state: 'FAILED',
    code: 'MISSING_IDENTITY',
  });
  assert.deepEqual(normalize(raw(valid), 'other', 'synthetic-movement-v1'), {
    state: 'FAILED',
    code: 'IDENTITY_MISMATCH',
  });
});
test('explicit v2 interpretation preserves v1 behavior and UTC rules', () => {
  const bytes = raw({ ...valid, occurredAt: '2026-01-01T00:00:00Z' });
  assert.deepEqual(normalize(bytes, valid.id, 'synthetic-movement-v1'), {
    state: 'FAILED',
    code: 'INVALID_TIMESTAMP',
  });
  const result = normalize(bytes, valid.id, 'synthetic-movement-v2');
  assert.equal(result.state, 'NORMALIZED');
  if (result.state === 'NORMALIZED')
    assert.equal(result.observation.occurredAt, valid.occurredAt);
  assert.throws(() => normalize(bytes, valid.id, 'missing' as never));
});
test('normalization and exact monetary preservation: 500 trials seed 70301', () => {
  fc.assert(
    fc.property(
      fc.bigInt({ min: MIN_MINOR_UNITS, max: MAX_MINOR_UNITS }),
      fc.constantFrom('PHP', 'USD'),
      fc.string({ maxLength: 80 }),
      (amount, currency, reference) => {
        const input = {
          ...valid,
          paymentReference: 'ref:' + reference,
          amount: { amountMinor: amount.toString(), currency },
        };
        const bytes = raw(input);
        const a = normalize(bytes, input.id, 'synthetic-movement-v1');
        assert.deepEqual(
          a,
          normalize(bytes, input.id, 'synthetic-movement-v1'),
        );
        assert.equal(a.state, 'NORMALIZED');
        if (a.state === 'NORMALIZED')
          assert.equal(BigInt(a.observation.amount.amountMinor), amount);
      },
    ),
    { numRuns: 500, seed: 70301 },
  );
});
test('byte integrity and canonical key ordering: 500 trials seed 70302', () => {
  fc.assert(
    fc.property(fc.uint8Array({ maxLength: 500 }), (bytes) => {
      assert.equal(sha256(bytes), sha256(Uint8Array.from(bytes)));
      assert.deepEqual(
        normalize(bytes, null, 'synthetic-movement-v1'),
        normalize(bytes, null, 'synthetic-movement-v1'),
      );
      assert.equal(
        canonicalJson({ b: 'x', a: Array.from(bytes) }),
        canonicalJson({ a: Array.from(bytes), b: 'x' }),
      );
    }),
    { numRuns: 500, seed: 70302 },
  );
});
test('batch payload snapshots bytes and rejects conflicting locators/unsafe metadata', () => {
  const bytes = raw(valid);
  const command: BatchCommand = {
    sourceAccountId: 'account',
    batchKey: 'key',
    actorId: 'actor',
    provenance: {},
    records: [
      {
        locator: '0',
        objectKind: 'movement',
        externalId: 'movement-1',
        sourceRevision: null,
        sequence: null,
        sourceObservedAt: null,
        bytes,
      },
    ],
  };
  const payload = batchPayload(command);
  bytes.fill(0);
  assert.notEqual(payload, batchPayload(command));
  assert.throws(() =>
    batchPayload({
      ...command,
      records: [command.records[0]!, command.records[0]!],
    }),
  );
  assert.throws(() => batchPayload({ ...command, expectedCount: 1.5 }));
  assert.throws(() => canonicalJson({ money: 0.1 }));
});
test('independent process replay ignores timezone and reproduces both version results', () => {
  const code =
    "const {normalize}=require('./libs/ingestion-domain/dist'); console.log(JSON.stringify(normalize(Buffer.from(process.argv[1]),'movement-1','synthetic-movement-v1')))";
  const results = ['UTC', 'Asia/Manila', 'America/New_York'].map((TZ) =>
    execFileSync(process.execPath, ['-e', code, JSON.stringify(valid)], {
      env: { ...process.env, TZ },
    }).toString(),
  );
  assert.equal(results[0], results[1]);
  assert.equal(results[1], results[2]);
});
