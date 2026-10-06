import assert from 'node:assert/strict';
import { test } from 'node:test';
import fc from 'fast-check';
import { MAX_MINOR_UNITS, MIN_MINOR_UNITS, Money } from '../src';

test('exact equality, zero, negatives and immutable values', () => {
  assert(Money.of(0n, 'PHP').equals(Money.parse('0', 'PHP')));
  assert(
    Money.of(-25n, 'PHP').equals(
      Money.of(0n, 'PHP').subtract(Money.of(25n, 'PHP')),
    ),
  );
  assert(!Money.of(1n, 'PHP').equals(Money.of(1n, 'USD')));
  assert(!Money.of(1n, 'PHP').equals(Money.of(2n, 'PHP')));
  assert(Object.isFrozen(Money.of(1n, 'PHP')));
});
test('arithmetic is exact above Number.MAX_SAFE_INTEGER', () => {
  assert.equal(
    Money.parse('9007199254740993', 'PHP').add(Money.of(1n, 'PHP')).amountMinor,
    9007199254740994n,
  );
  assert.throws(
    () => Money.of(1n, 'PHP').add(Money.of(1n, 'USD')),
    /Currencies/,
  );
  assert.throws(
    () => Money.of(1n, 'PHP').subtract(Money.of(1n, 'USD')),
    /Currencies/,
  );
});
test('entire signed BIGINT domain is supported; overflow is explicit', () => {
  assert.equal(Money.of(MIN_MINOR_UNITS, 'PHP').amountMinor, MIN_MINOR_UNITS);
  assert.equal(Money.of(MAX_MINOR_UNITS, 'PHP').amountMinor, MAX_MINOR_UNITS);
  assert.throws(
    () => Money.of(MAX_MINOR_UNITS, 'PHP').add(Money.of(1n, 'PHP')),
    RangeError,
  );
  assert.throws(
    () => Money.of(MIN_MINOR_UNITS, 'PHP').subtract(Money.of(1n, 'PHP')),
    RangeError,
  );
  assert.throws(() => Money.parse('9223372036854775808', 'PHP'), RangeError);
});
test('creation and serialized boundaries reject unsafe or ambiguous input', () => {
  for (const input of [
    '1.0',
    '01',
    '-0',
    '+1',
    ' 1',
    '1e2',
    'NaN',
    'Infinity',
    '',
    '9'.repeat(100),
  ]) {
    assert.throws(() => Money.parse(input, 'PHP'));
  }
  for (const value of [
    null,
    {},
    { amountMinor: 9007199254740993, currency: 'PHP' },
    { amountMinor: '1', currency: 'php' },
    { amountMinor: '1', currency: 'PHP', extra: 1 },
  ]) {
    assert.throws(() => Money.fromJSON(value));
  }
  // Adversarial caller bypassing static types is still rejected at runtime.
  assert.throws(() => Money.of(1 as unknown as bigint, 'PHP'), TypeError);
});
test('deterministic integer-string JSON serialization', () => {
  const money = Money.of(MAX_MINOR_UNITS, 'PHP');
  assert.equal(
    JSON.stringify(money),
    '\u007b"amountMinor":"9223372036854775807","currency":"PHP"\u007d',
  );
  assert(Money.fromJSON(JSON.parse(JSON.stringify(money))).equals(money));
});
test('property: exact arithmetic round trips within supported bounds', () => {
  fc.assert(
    fc.property(
      fc.bigInt({ min: MIN_MINOR_UNITS / 2n, max: MAX_MINOR_UNITS / 2n }),
      fc.bigInt({ min: MIN_MINOR_UNITS / 2n, max: MAX_MINOR_UNITS / 2n }),
      (a, b) => {
        assert(
          Money.of(a, 'PHP')
            .add(Money.of(b, 'PHP'))
            .subtract(Money.of(b, 'PHP'))
            .equals(Money.of(a, 'PHP')),
        );
      },
    ),
    { numRuns: 1000, seed: 70101 },
  );
});
test('property: all signed BIGINT values serialize and parse exactly', () => {
  fc.assert(
    fc.property(
      fc.bigInt({ min: MIN_MINOR_UNITS, max: MAX_MINOR_UNITS }),
      (a) => {
        assert(
          Money.fromJSON(JSON.parse(JSON.stringify(Money.of(a, 'PHP')))).equals(
            Money.of(a, 'PHP'),
          ),
        );
      },
    ),
    { numRuns: 1000, seed: 70102 },
  );
});
