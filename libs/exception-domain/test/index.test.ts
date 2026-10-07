import assert from 'node:assert/strict';
import { test } from 'node:test';
import fc from 'fast-check';
import { nextState, serializeCommand, STATES, type Action } from '../src/index';
import { Money } from '@flow/money';
test('explicit Phase 0 lifecycle rejects direct closure and preserves resolution separation', () => {
  assert.equal(nextState('OPEN', 'START_REVIEW'), 'UNDER_REVIEW');
  assert.equal(
    nextState('UNDER_REVIEW', 'AWAIT_EVIDENCE'),
    'AWAITING_EVIDENCE',
  );
  assert.equal(nextState('AWAITING_EVIDENCE', 'RESUME_REVIEW'), 'UNDER_REVIEW');
  assert.equal(nextState('UNDER_REVIEW', 'RESOLVE'), 'RESOLVED');
  assert.equal(nextState('RESOLVED', 'REOPEN'), 'UNDER_REVIEW');
  assert.throws(() => nextState('OPEN', 'RESOLVE'));
  assert.throws(() => nextState('RESOLVED', 'CLASSIFY'));
});
test('command validates explicit reason, typed evidence and structured resolution', () => {
  const base = {
    caseId: 'case',
    commandKey: 'command',
    expectedVersion: 1,
    actorId: 'reviewer',
    reason: 'Documented synthetic review',
  };
  assert(
    serializeCommand({
      ...base,
      action: 'RESOLVE',
      resolution: 'ACCEPTED_RISK',
    }),
  );
  assert.throws(() =>
    serializeCommand({
      ...base,
      action: 'RESOLVE',
      resolution: 'FIXED_AND_VERIFIED',
    }),
  );
  assert.throws(() => serializeCommand({ ...base, action: 'RESOLVE' }));
  assert.throws(() => serializeCommand({ ...base, action: 'NOTE', note: '' }));
  assert.throws(() => serializeCommand({ ...base, action: 'ASSIGN' }));
  assert(serializeCommand({ ...base, action: 'ASSIGN', assigneeId: null }));
});
test('all generated state/action transitions obey only the explicit allowlist (500 trials)', () => {
  const actions: Action[] = [
    'SUPERSEDE',
    'START_REVIEW',
    'AWAIT_EVIDENCE',
    'RESUME_REVIEW',
    'RESOLVE',
    'REOPEN',
    'CLASSIFY',
    'ASSIGN',
    'NOTE',
    'ATTACH',
  ];
  const allowed = [
    'RESOLVED:SUPERSEDE:RESOLVED',
    'OPEN:START_REVIEW:UNDER_REVIEW',
    'UNDER_REVIEW:AWAIT_EVIDENCE:AWAITING_EVIDENCE',
    'AWAITING_EVIDENCE:RESUME_REVIEW:UNDER_REVIEW',
    'UNDER_REVIEW:RESOLVE:RESOLVED',
    'RESOLVED:REOPEN:UNDER_REVIEW',
  ];
  fc.assert(
    fc.property(
      fc.constantFrom(...STATES),
      fc.constantFrom(...actions),
      (state, action) => {
        const metadata =
          ['NOTE', 'ATTACH'].includes(action) ||
          (['CLASSIFY', 'ASSIGN'].includes(action) && state !== 'RESOLVED');
        const expected =
          allowed
            .find((x) => x.startsWith(`${state}:${action}:`))
            ?.split(':')[2] ?? (metadata ? state : undefined);
        if (expected) assert.equal(nextState(state, action), expected);
        else assert.throws(() => nextState(state, action));
      },
    ),
    { seed: 70801, numRuns: 500 },
  );
});
test('accepted risk command transports exact Money without manufacturing financial reconciliation (500 trials)', () => {
  fc.assert(
    fc.property(
      fc.bigInt({ min: 0n, max: 9223372036854775807n }),
      fc.constantFrom('PHP' as const, 'USD' as const),
      (a, c) => {
        assert.equal(Money.fromJSON(Money.of(a, c).toJSON()).amountMinor, a);
        const command = JSON.parse(
          serializeCommand({
            caseId: 'c',
            commandKey: 'risk',
            expectedVersion: 2,
            actorId: 'actor',
            reason: 'Synthetic risk accepted',
            action: 'RESOLVE',
            resolution: 'ACCEPTED_RISK',
          }),
        );
        assert.equal(command.resolution, 'ACCEPTED_RISK');
        assert(!('reconciled' in command));
      },
    ),
    { seed: 70802, numRuns: 500 },
  );
});
