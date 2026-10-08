import assert from 'node:assert/strict';
import { test } from 'node:test';
import fc from 'fast-check';
import { health, type IntegritySummary, type Status } from '../src/index';

test('1,000 health-summary trials cannot hide FAIL/UNKNOWN behind successful work', () => {
  fc.assert(
    fc.property(
      fc.array(fc.constantFrom<Status>('PASS', 'FAIL', 'UNKNOWN'), {
        minLength: 1,
        maxLength: 30,
      }),
      fc.integer({ min: 0, max: 10000 }),
      (statuses, succeeded) => {
        const summary: IntegritySummary = {
          version: 'system-integrity-v1',
          bookId: 'synthetic',
          asOf: '2026-01-01',
          integrity: 'PASS',
          financialAssurance: 'UNKNOWN',
          violations: [],
          controls: statuses.map((status, i) => ({
            key: String(i),
            type: 'SOURCE',
            status,
            scope: {},
            expected: null,
            observed: null,
            discrepancy: null,
          })),
          work: {
            pending: 0,
            processing: 0,
            retryable: 0,
            terminal: 0,
            succeeded,
            expiredRecoverable: 0,
          },
          open: { exceptions: 0, unknownControls: 0 },
        };
        const result = health(summary)['sourceCompleteness'];
        if (statuses.includes('FAIL')) assert.equal(result, 'FAIL');
        else if (statuses.includes('UNKNOWN')) assert.equal(result, 'UNKNOWN');
        else assert.equal(result, 'PASS');
        assert.equal(
          health({ ...summary, controls: [] })['sourceCompleteness'],
          'UNKNOWN',
        );
        assert.equal(
          health({ ...summary, work: { ...summary.work, terminal: 1 } })[
            'workerRecoverability'
          ],
          'FAIL',
        );
      },
    ),
    { numRuns: 1000, seed: 71112 },
  );
});
