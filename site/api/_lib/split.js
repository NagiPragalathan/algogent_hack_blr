/**
 * How one tool call's fee is divided.
 *
 * This lives on the server and NOT in the extension, and that is the whole
 * point: the split and the company address are the two numbers a client would
 * have every incentive to rewrite, so the client never sees them as inputs. It
 * signs a transaction group the server built. If it signs something else, the
 * server does not settle it.
 *
 * Everything here is integer microALGO. Never floats: 0.1 + 0.2 is not 0.3, and
 * a rounding error in a payment path is money that goes somewhere nobody
 * intended. ALGO has exactly 6 decimals, so microALGO is the atomic unit and
 * every amount on the wire is a whole number of them.
 */

/** 1 ALGO, in the atomic unit Algorand actually moves. */
export const MICRO_ALGO = 1_000_000;

/** Basis points, so a 20% cut is 2000 and fractions of a percent are sayable. */
export const BPS = 10_000;

/**
 * The flat per-transaction network fee on Algorand, in microALGO.
 *
 * It is charged to the SENDER, per transaction in the group — so a two-way
 * split costs 2000 microALGO in fees on top of the price. That is fine at
 * sensible prices and absurd below them, which is what MIN_PRICE guards.
 */
export const ALGORAND_MIN_FEE = 1_000;

/**
 * The floor a price has to clear before splitting it is honest.
 *
 * Below this the network fee is a larger share of the transfer than the
 * developer's cut, so the buyer pays mostly to move money rather than to buy
 * anything. Ten times the group fee is the line: at 0.02 ALGO the 0.002 in fees
 * is 10%, which is high but defensible for a per-call micropayment.
 */
export const MIN_PRICE_MICRO_ALGO = ALGORAND_MIN_FEE * 2 * 10;

/**
 * Split a price between the developer who published the agent and the company
 * that runs the marketplace.
 *
 * The remainder goes to the DEVELOPER, deliberately. An integer split of an odd
 * amount has to give the odd microALGO to someone, and every alternative is
 * worse: rounding the company's cut up takes from the person who did the work,
 * and dropping it leaves a microALGO unaccounted for, which makes the receipt
 * fail to reconcile — and a receipt that does not add up is the one thing this
 * whole path exists to avoid.
 *
 * @param {number} priceMicroAlgo whole microALGO, the buyer's total
 * @param {number} companyBps     the company's cut in basis points
 */
export function splitFee(priceMicroAlgo, companyBps) {
  if (!Number.isInteger(priceMicroAlgo) || priceMicroAlgo <= 0) {
    throw new Error(`price must be a positive whole number of microALGO, got ${priceMicroAlgo}`);
  }
  if (!Number.isInteger(companyBps) || companyBps < 0 || companyBps > BPS) {
    throw new Error(`companyBps must be an integer 0..${BPS}, got ${companyBps}`);
  }

  const company = Math.floor((priceMicroAlgo * companyBps) / BPS);
  const developer = priceMicroAlgo - company;

  return {
    total: priceMicroAlgo,
    developer,
    company,
    companyBps,
    /**
     * What the buyer actually spends: the price, plus one network fee per
     * transaction in the group. Stated separately from `total` because they are
     * different things and a receipt that conflates them is wrong — the fee
     * goes to the protocol, not to either party.
     */
    networkFee: ALGORAND_MIN_FEE * (company > 0 ? 2 : 1),
    get buyerPays() {
      return this.total + this.networkFee;
    }
  };
}

/**
 * Whether a price is worth charging at all.
 *
 * Returned as a reason rather than a boolean so the 402 can say WHY it refused
 * — "too small to settle" and "no address registered" are different problems
 * for whoever has to fix them.
 */
export function priceProblem(priceMicroAlgo) {
  if (!Number.isInteger(priceMicroAlgo) || priceMicroAlgo <= 0) {
    return 'price_invalid';
  }
  if (priceMicroAlgo < MIN_PRICE_MICRO_ALGO) {
    return 'price_below_floor';
  }
  return null;
}

/** microALGO → a human ALGO string. Exactly 6 decimals, never a float. */
export function toAlgoString(microAlgo) {
  const negative = microAlgo < 0;
  const n = Math.abs(Math.trunc(microAlgo));
  const whole = Math.floor(n / MICRO_ALGO);
  const fraction = String(n % MICRO_ALGO).padStart(6, '0');
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

/** An ALGO string from a developer's form → whole microALGO, or null. */
export function parseAlgo(input) {
  const text = String(input ?? '').trim();
  if (!/^\d+(\.\d{1,6})?$/.test(text)) return null;

  const [whole, fraction = ''] = text.split('.');
  return Number(whole) * MICRO_ALGO + Number(fraction.padEnd(6, '0'));
}
