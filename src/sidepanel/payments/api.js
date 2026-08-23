/**
 * Where the marketplace is, and how a refusal is worded. Nothing else.
 *
 * This exists to break a ring rather than to hold an idea, and the ring is
 * real: `x402.js` needs the wallet (it signs), `ui/wallet.js` needs to know
 * whether the marketplace pays for itself (it draws the switch), and
 * `auto-pay.js` sits between them. Three files, one circle, and the symptom of
 * closing it is not an error — it is a module whose exports are `undefined` at
 * the moment the other one reads them, which surfaces as the panel silently
 * failing to boot.
 *
 * So the two things every payment road shares and neither needs a wallet for —
 * the base URL and the shape of a decline — live here, and `x402.js` re-exports
 * them so no existing caller has to know.
 */

/** Where the marketplace lives. Overridable for a local API during development. */
const DEFAULT_API = 'https://algogent.vercel.app';

let base = DEFAULT_API;

/** Read at call time, so a stored override applies to calls already written. */
export const apiBase = () => base;

export async function initPayments() {
  try {
    const stored = await chrome.storage.local.get('marketplaceApi');
    if (stored?.marketplaceApi) base = String(stored.marketplaceApi).replace(/\/+$/, '');
  } catch {
    // Storage is unavailable in some contexts; the default is fine.
  }
}

/**
 * The reasons a call is not charged.
 *
 * Returned rather than thrown, and worded for a person, because every one of
 * them is a thing the user might want to fix — and none of them is a failure of
 * the question they just asked.
 */
export const declined = (reason) => ({ paid: false, reason });

/**
 * The one decline that is not worth telling anybody about: no priced items,
 * with a price list that loaded fine. That is a free tool working correctly,
 * and reporting it would put "not charged" under every unbilled answer — which
 * trains people to stop reading the place the real numbers appear.
 */
export const NOTHING_TO_BILL = 'nothing billable here';
