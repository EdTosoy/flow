import assert from 'node:assert/strict';
import { test } from 'node:test';
import { identifier, parameters, InvalidRead } from '../src/index';
const id = 'f264ba54-0070-4931-8492-d97d5f610435';
test('identifiers, filters, limits and cursors reject untrusted input before SQL', () => {
  assert.equal(identifier(id.toUpperCase()), id);
  for (const value of ['', "';DROP TABLE ledger.book", 'not-a-uuid'])
    assert.throws(() => identifier(value), InvalidRead);
  for (const input of [
    { limit: '0' },
    { limit: '101' },
    { limit: '1.5' },
    { status: 'GREEN' },
    { currency: 'BTC' },
    { cursor: 'garbage' },
    { category: 'invented' },
    { anything: 'sql' },
  ])
    assert.throws(() => parameters('controls', input), InvalidRead);
  const cursor = Buffer.from(JSON.stringify({ key: 'safe-key' })).toString(
    'base64url',
  );
  assert.deepEqual(
    parameters('controls', { status: 'UNKNOWN', currency: 'PHP', cursor }),
    {
      limit: 50,
      status: 'UNKNOWN',
      currency: 'PHP',
      cursor: { key: 'safe-key' },
    },
  );
  assert.throws(
    () =>
      parameters('controls', {
        cursor: Buffer.from(
          JSON.stringify({ key: 'x', injected: 'sql' }),
        ).toString('base64url'),
      }),
    InvalidRead,
  );
});
