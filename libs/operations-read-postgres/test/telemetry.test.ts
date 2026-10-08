import assert from 'node:assert/strict';
import { test } from 'node:test';
import fc from 'fast-check';
import { Telemetry, classify, type ReadObservation } from '../src/telemetry';
test('bounded metrics, exact worker count strings, explicit UNKNOWN and redaction', () => {
  const t = new Telemetry(100);
  fc.assert(
    fc.property(fc.string(), fc.nat({ max: 30000 }), (secret, durationMs) => {
      const o: ReadObservation = {
        operation: 'exceptions',
        durationMs,
        databaseMs: durationMs,
        queryCount: 5,
        rows: 50,
        outcome: 'SUCCESS',
        classification: 'NONE',
      };
      t.record(o);
      const before = t.text();
      t.record({
        ...o,
        operation: ('unsafe-' + secret) as ReadObservation['operation'],
      });
      t.request('unsafe-' + secret, durationMs, false);
      t.observedModel(('unsafe-' + secret) as 'books', {
        version: 'operations-read-v1',
        asOf: '2026-01-01T00:00:00Z',
        items: null,
        nextCursor: null,
        data: null,
      });
      assert.equal(t.text(), before);
    }),
    { seed: 71313, numRuns: 1000 },
  );
  t.observedModel('workers', {
    version: 'operations-read-v1',
    asOf: '2026-01-01T00:00:00Z',
    items: null,
    nextCursor: null,
    data: { counts: { PENDING: '9007199254740993' } },
  });
  assert(t.text().includes('state="PENDING"} 9007199254740993'));
  t.observedModel('workers', {
    version: 'operations-read-v1',
    asOf: '2026-01-01T00:00:01Z',
    items: null,
    nextCursor: null,
    data: { counts: null },
  });
  assert(t.text().includes('state="PENDING"} 0'));
  t.observedModel('integrity', {
    version: 'operations-read-v1',
    asOf: '2026-01-01T00:00:01Z',
    items: null,
    nextCursor: null,
    data: {
      integrity: {
        integrity: 'PASS',
        financialAssurance: 'UNKNOWN',
        controls: [{ status: 'UNKNOWN' }],
      },
    },
  });
  assert(t.text().includes('kind="financialAssurance",status="UNKNOWN"} 1'));
  assert(
    t.text().includes('flow_last_observed_control_total{status="UNKNOWN"} 1'),
  );
  assert(t.text().includes('operation="exceptions"} 5000'));
  assert(t.text().length < 10000);
});
test('stable error classifications omit arbitrary messages and SQL', () => {
  for (const [code, expected] of [
    ['57014', 'TIMEOUT'],
    ['42501', 'PERMISSION_DENIED'],
    ['08006', 'DATABASE_UNAVAILABLE'],
    ['ECONNRESET', 'DATABASE_UNAVAILABLE'],
    ['P9002', 'UNSUPPORTED_STATE'],
    ['P6004', 'INVARIANT_FAILURE'],
    ['invented secret', 'UNEXPECTED'],
  ])
    assert.equal(classify({ code, message: 'private payload' }), expected);
  assert.throws(() => new Telemetry(0));
  assert.throws(() => new Telemetry(0.5));
  assert.equal(classify(new Error('Query read timeout')), 'TIMEOUT');
});
