/**
 * The metering arithmetic, kept separate from the catalogue.
 *
 * `data/agents.ts` imports SVG assets, which only a bundler can resolve — so a
 * test importing it would need the whole Vite pipeline to check one
 * multiplication. The rule the marketplace actually has to get right is in
 * here, where plain Node can drive it.
 */

export interface Pricing {
  /**
   * Flat component covering work that costs money but burns no tokens — a
   * Playwright session, an outbound API call, a page fetch.
   */
  baseUsd: number;
  /** Metered component, applied to tokens the request actually consumed. */
  perMillionInputUsd: number;
  perMillionOutputUsd: number;
}

/**
 * What a request costs, given the tokens it actually consumed.
 *
 * Rates are quoted per million tokens because that is how the upstream model
 * providers quote them — converting to a per-token float here would round a
 * rate like $3/Mtok to 0.000003 and lose the exactness the receipt is for.
 */
export function quote(
  pricing: Pricing,
  inputTokens: number,
  outputTokens: number,
): number {
  return (
    pricing.baseUsd +
    (inputTokens / 1_000_000) * pricing.perMillionInputUsd +
    (outputTokens / 1_000_000) * pricing.perMillionOutputUsd
  );
}

/** A representative call, used to show a worked price on each listing. */
export const SAMPLE_CALL = { inputTokens: 2_400, outputTokens: 800 } as const;
