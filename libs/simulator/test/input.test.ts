import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captureCommand, stableJson, sha256 } from '../src';

test('runtime contract constructs validated exact capture commands without truth generation', () => {
  const command = captureCommand(
    {
      attemptId: 'attempt',
      commandKey: 'stable-key',
      expectation: {
        id: 'internal-action',
        paymentReference: 'merchant-reference',
        payerId: 'payer',
        kind: 'capture',
        amount: { amountMinor: '9007199254740993', currency: 'PHP' },
        occurredAt: '2026-01-01T00:00:00.000Z',
      },
    },
    {
      bookId: '00000000-0000-0000-0000-000000000001',
      receivableAccountId: '00000000-0000-0000-0000-000000000002',
      salesAccountId: '00000000-0000-0000-0000-000000000003',
    },
  );
  assert.equal(command.entries[0]!.money.amountMinor, 9007199254740993n);
  assert.equal(command.entries[1]!.money.amountMinor, 9007199254740993n);
  assert.equal(command.businessEffectKey, 'internal-action');
  assert.equal(command.commandKey, 'stable-key');
});
test('canonical JSON is stable across object key order and rejects lossy values', () => {
  assert.equal(
    stableJson({ z: 1, a: { c: 2, b: 3 } }),
    stableJson({ a: { b: 3, c: 2 }, z: 1 }),
  );
  assert.notEqual(stableJson([1, 2]), stableJson([2, 1]));
  for (const value of [
    1.5,
    NaN,
    Infinity,
    undefined,
    1n,
    Number.MAX_SAFE_INTEGER + 1,
  ])
    assert.throws(() => stableJson(value));
  assert.equal(
    sha256('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
});
