/**
 * The money math. Every assertion here is about not losing a microALGO.
 *
 * Run: node tests/split.test.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  splitFee,
  priceProblem,
  toAlgoString,
  parseAlgo,
  MICRO_ALGO,
  MIN_PRICE_MICRO_ALGO,
  ALGORAND_MIN_FEE
} from '../api/_lib/split.js';

test('a round price splits 80/20', () => {
  const s = splitFee(MICRO_ALGO, 2000);
  assert.equal(s.developer, 800_000);
  assert.equal(s.company, 200_000);
});

test('the two shares always add back to the total', () => {
  // Odd numbers are where an integer split loses money if it is done wrong.
  for (const price of [1_001, 20_001, 33_333, 999_999, 7, 123_457]) {
    if (price < MIN_PRICE_MICRO_ALGO) continue;
    const s = splitFee(price, 2000);
    assert.equal(s.developer + s.company, price, `lost a microALGO at ${price}`);
  }
});

test('the odd microALGO goes to the developer, not the house', () => {
  // 20% of 33,333 is 6,666.6 — the .6 has to land somewhere.
  const s = splitFee(33_333, 2000);
  assert.equal(s.company, 6_666);
  assert.equal(s.developer, 26_667);
});

test('a 0% cut pays the developer everything and needs only one transaction', () => {
  const s = splitFee(500_000, 0);
  assert.equal(s.developer, 500_000);
  assert.equal(s.company, 0);
  assert.equal(s.networkFee, ALGORAND_MIN_FEE, 'no second txn when the company share is zero');
});

test('a split costs two network fees, and they are not part of the price', () => {
  const s = splitFee(MICRO_ALGO, 2000);
  assert.equal(s.networkFee, ALGORAND_MIN_FEE * 2);
  assert.equal(s.total, MICRO_ALGO, 'the fee is not folded into the price');
  assert.equal(s.buyerPays, MICRO_ALGO + ALGORAND_MIN_FEE * 2);
});

test('a float price is refused rather than rounded', () => {
  assert.throws(() => splitFee(1000.5, 2000));
  assert.throws(() => splitFee(0, 2000));
  assert.throws(() => splitFee(-1, 2000));
});

test('an out-of-range cut is refused', () => {
  assert.throws(() => splitFee(MICRO_ALGO, 10_001));
  assert.throws(() => splitFee(MICRO_ALGO, -1));
});

test('a price too small to be worth its own network fee is refused', () => {
  assert.equal(priceProblem(MICRO_ALGO), null);
  assert.equal(priceProblem(100), 'price_below_floor');
  assert.equal(priceProblem(0), 'price_invalid');
  assert.equal(priceProblem(1.5), 'price_invalid');
});

test('microALGO renders as ALGO with six decimals and no float drift', () => {
  assert.equal(toAlgoString(MICRO_ALGO), '1.000000');
  assert.equal(toAlgoString(1), '0.000001');
  assert.equal(toAlgoString(0), '0.000000');
  assert.equal(toAlgoString(26_667), '0.026667');
  assert.equal(toAlgoString(123_456_789), '123.456789');
});

test('a developer price string parses to whole microALGO', () => {
  assert.equal(parseAlgo('1'), MICRO_ALGO);
  assert.equal(parseAlgo('0.02'), 20_000);
  assert.equal(parseAlgo('0.000001'), 1);
  assert.equal(parseAlgo(' 2.5 '), 2_500_000);
});

test('a price string that cannot be exact is rejected, not rounded', () => {
  assert.equal(parseAlgo('0.0000001'), null, 'seven decimals is finer than ALGO goes');
  assert.equal(parseAlgo('abc'), null);
  assert.equal(parseAlgo('-1'), null);
  assert.equal(parseAlgo(''), null);
  assert.equal(parseAlgo('1e6'), null, 'exponent notation is not a price');
});

test('parse and render round-trip', () => {
  for (const text of ['0.020000', '1.000000', '12.345678'.slice(0, 9)]) {
    const micro = parseAlgo(text);
    if (micro === null) continue;
    assert.equal(toAlgoString(micro), text.padEnd(text.indexOf('.') + 7, '0'));
  }
});
