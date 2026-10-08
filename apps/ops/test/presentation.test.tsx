import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import fc from 'fast-check';
import { money, percentage, timestamp } from '../components/format';
import { Status } from '../components/common';
import {
  Overview,
  Exceptions,
  Case,
  Run,
  Controls,
  Workers,
  Integrity,
} from '../components/views';
import type { Model } from '../components/model';
const book = 'f264ba54-0070-4931-8492-d97d5f610435';
const base: Model = {
  version: 'operations-read-v1',
  asOf: '2026-01-01T00:00:00Z',
  data: {},
  items: [],
  nextCursor: null,
};
test('exact financial formatting preserves signs, large aggregate values and currency', () => {
  assert.equal(money('9007199254740993', 'PHP'), 'PHP 90,071,992,547,409.93');
  assert.equal(money('-1', 'USD'), 'USD -0.01');
  assert.equal(money(null, 'PHP'), 'UNKNOWN');
  assert.equal(money(100, 'PHP'), 'UNKNOWN');
  fc.assert(
    fc.property(fc.bigInt({ min: -(10n ** 24n), max: 10n ** 24n }), (n) => {
      const formatted = money(n.toString(), 'USD');
      assert.equal(
        formatted.replace('USD ', '').replaceAll(',', '').replace('.', ''),
        n < 0n
          ? '-' + (-n).toString().padStart(3, '0')
          : n.toString().padStart(3, '0'),
      );
    }),
    { seed: 71212, numRuns: 1000 },
  );
  assert.equal(percentage('0', '0'), 'Not evaluated');
  assert.equal(percentage('2', '3'), '66.6%');
  assert.equal(percentage('9007199254740993', '9007199254740993'), '100.0%');
  assert(timestamp('2026-01-01T08:00:00+08:00').endsWith('00:00:00.000 UTC'));
});
test('UNKNOWN, FAIL and empty views never render as green or zero exposure', () => {
  const unknown = renderToStaticMarkup(<Status value="UNKNOWN" />);
  assert(unknown.includes('unknown'));
  assert(!unknown.includes('pass'));
  for (const View of [
    Overview,
    Exceptions,
    Run,
    Controls,
    Workers,
    Integrity,
  ]) {
    const html = renderToStaticMarkup(<View model={base} book={book} />);
    assert(html.length > 100);
  }
  const html = renderToStaticMarkup(<Overview model={base} book={book} />);
  assert(html.includes('Assurance: UNKNOWN'));
  assert(!html.includes('PHP 0.00'));
  const fail = renderToStaticMarkup(
    <Controls
      model={{
        ...base,
        items: [
          {
            key: 'bank-closing',
            type: 'BANK_TOTAL',
            status: 'FAIL',
            expected: '100',
            observed: '99',
            discrepancy: '-1',
            unit: 'MINOR_UNITS',
            currency: 'USD',
          },
        ],
      }}
      book={book}
      evaluation={book}
    />,
  );
  assert(fail.includes('USD -0.01'));
  assert(fail.includes('FAIL'));
});
test('case closure, accepted risk and current allocation remain independent in detail', () => {
  const html = renderToStaticMarkup(
    <Case
      model={{
        ...base,
        data: {
          id: book,
          state: 'RESOLVED',
          resolution: 'ACCEPTED_RISK',
          currentlyReconciled: false,
          exposure: { amountMinor: '125004325' },
          currency: 'PHP',
          evidenceRunId: book,
        },
        items: [
          {
            id: book,
            version: 1,
            action: 'NOTE',
            note: '<script>unsafe</script>',
            createdAt: base.asOf,
          },
        ],
      }}
      book={book}
    />,
  );
  assert(html.includes('UNRECONCILED'));
  assert(html.includes('PHP 1,250,043.25'));
  assert(html.includes('Accepted risk'));
  assert(html.includes('&lt;script&gt;'));
  assert(!html.includes('<script>unsafe'));
});
