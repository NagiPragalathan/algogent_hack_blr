/**
 * Node 24 strips types natively, so this runs with no build step:
 *   node tests/pricing.test.ts
 *
 * It imports from src/lib/pricing.ts rather than src/data/agents.ts because
 * the catalogue imports SVG assets, which only a bundler can resolve.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { quote, SAMPLE_CALL, type Pricing } from "../src/lib/pricing.ts";

const RATES: Pricing = {
  baseUsd: 0.02,
  perMillionInputUsd: 3,
  perMillionOutputUsd: 15,
};

test("a call with no tokens costs exactly the base", () => {
  assert.equal(quote(RATES, 0, 0), 0.02);
});

test("input and output are metered at their own rates", () => {
  // 2,400 in at $3/Mtok = $0.0072; 800 out at $15/Mtok = $0.0120.
  const total = quote(RATES, SAMPLE_CALL.inputTokens, SAMPLE_CALL.outputTokens);
  assert.equal(Number(total.toFixed(4)), 0.0392);
});

test("output tokens cost more than the same count of input tokens", () => {
  assert.ok(quote(RATES, 0, 1000) > quote(RATES, 1000, 0));
});

test("cost is linear in token count", () => {
  const one = quote(RATES, 1000, 1000) - RATES.baseUsd;
  const two = quote(RATES, 2000, 2000) - RATES.baseUsd;
  assert.ok(Math.abs(two - one * 2) < 1e-12);
});

test("a base-free agent still charges for the tokens it burned", () => {
  const free: Pricing = { ...RATES, baseUsd: 0 };
  assert.ok(quote(free, 1000, 1000) > 0);
});
