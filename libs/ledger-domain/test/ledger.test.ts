import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import fc from 'fast-check';
import { Money, MAX_MINOR_UNITS } from '@flow/money';
import { validatePost, type PostJournalCommand } from '../src';

function command(amount: bigint): PostJournalCommand {
  return {
    bookId: randomUUID(),
    commandKey: 'command',
    actorId: 'test',
    reason: 'synthetic accounting mechanics',
    effectNamespace: 'fixture',
    businessEffectKey: 'action',
    currency: 'PHP',
    effectiveAt: '2026-10-07T00:00:00.000Z',
    policyVersion: 'generic-v1',
    entries: [
      {
        accountId: randomUUID(),
        side: 'debit',
        money: Money.of(amount, 'PHP'),
      },
      {
        accountId: randomUUID(),
        side: 'credit',
        money: Money.of(amount, 'PHP'),
      },
    ],
  };
}
test('entry direction is separate from positive magnitude; at least two entries', () => {
  validatePost(command(1n));
  for (const amount of [0n, -1n])
    assert.throws(() => validatePost(command(amount)), /positive/);
  const c = command(1n);
  assert.throws(
    () => validatePost({ ...c, entries: c.entries.slice(0, 1) }),
    /2–1000/,
  );
  assert.throws(
    () =>
      validatePost({
        ...c,
        entries: [
          c.entries[0]!,
          { ...c.entries[1]!, money: Money.of(2n, 'PHP') },
        ],
      }),
    /balance/,
  );
  assert.throws(
    () =>
      validatePost({
        ...c,
        entries: [
          c.entries[0]!,
          { ...c.entries[1]!, money: Money.of(1n, 'USD') },
        ],
      }),
    /currency/,
  );
});
test('semantic inputs are explicit, bounded and generic', () => {
  const c = command(1n);
  assert.throws(
    () => validatePost({ ...c, effectNamespace: 'ledger.reversal' }),
    /Reserved/,
  );
  assert.throws(
    () => validatePost({ ...c, effectiveAt: '2026-10-07' }),
    /timestamp/,
  );
  assert.throws(() => validatePost({ ...c, reason: '' }), /text/);
});
test('property: balanced generation and entry order leave effect unchanged', () => {
  fc.assert(
    fc.property(fc.bigInt({ min: 1n, max: MAX_MINOR_UNITS }), (amount) => {
      const c = command(amount);
      validatePost(c);
      validatePost({ ...c, entries: [...c.entries].reverse() });
      const effect = c.entries.reduce(
        (sum, e) =>
          sum +
          (e.side === 'debit' ? e.money.amountMinor : -e.money.amountMinor),
        0n,
      );
      assert.equal(effect, 0n);
    }),
    { numRuns: 500, seed: 70103 },
  );
});
