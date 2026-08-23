/**
 * What was paid, kept per conversation.
 *
 * The server has the authoritative copy — a row in `receipts` written only
 * after the chain confirmed — and this is a local mirror so the panel can print
 * the fee history under a finished answer without a round trip. It is a mirror
 * and never a source: nothing here is ever the only record of a payment, and if
 * it is lost the history is still on the chain and in the database.
 *
 * `chrome.storage.local` rather than `session`, deliberately. A receipt is not
 * session state — someone reopening a week-old chat should still see what that
 * run cost, the same way the conversation itself survives. The cap is what
 * keeps that honest about storage: local is shared across the extension.
 */

const KEY = 'x402_receipts_v1';

/** Enough for a long agent run several times over; past that, oldest go. */
const MAX_PER_SESSION = 200;
const MAX_SESSIONS = 50;

async function readAll() {
  try {
    const stored = await chrome.storage.local.get(KEY);
    return stored?.[KEY] || {};
  } catch {
    return {};
  }
}

async function writeAll(all) {
  try {
    await chrome.storage.local.set({ [KEY]: all });
  } catch {
    // A full quota must not take down the answer the receipt belongs to.
  }
}

/**
 * File a settled receipt against its conversation.
 *
 * Keyed on `receiptId` so a retry after a dropped response cannot enter the
 * same payment twice — the server is idempotent on the transaction id and this
 * has to match, or the panel would show one payment as two and the total the
 * user reads would be double what left their wallet.
 */
export async function recordReceipt(sessionId, receipt) {
  if (!sessionId || !receipt?.receiptId) return;

  const all = await readAll();
  const list = all[sessionId] || [];

  if (list.some((r) => r.receiptId === receipt.receiptId)) return;

  list.push(receipt);
  all[sessionId] = list.slice(-MAX_PER_SESSION);

  const sessions = Object.keys(all);
  if (sessions.length > MAX_SESSIONS) {
    for (const stale of sessions.slice(0, sessions.length - MAX_SESSIONS)) delete all[stale];
  }

  await writeAll(all);
}

/** Every receipt for one conversation, oldest first — the order they ran in. */
export async function receiptsFor(sessionId) {
  if (!sessionId) return [];
  const all = await readAll();
  return all[sessionId] || [];
}

/**
 * The run's totals, summed from the rows that are actually shown.
 *
 * Summed here rather than asked of the server on purpose: a footer that
 * disagrees with the list above it is the one bug a receipt cannot survive, and
 * the only way to guarantee it agrees is to add up the same array being
 * rendered.
 */
export function totalsOf(receipts) {
  const sum = (pick) => receipts.reduce((acc, r) => acc + (pick(r) || 0), 0);

  const total = sum((r) => r.total?.microAlgo);
  const fee = sum((r) => r.networkFee?.microAlgo);

  return {
    calls: receipts.length,
    totalMicroAlgo: total,
    developerMicroAlgo: sum((r) => r.developer?.microAlgo),
    companyMicroAlgo: sum((r) => r.company?.microAlgo),
    networkFeeMicroAlgo: fee,
    spentMicroAlgo: total + fee
  };
}

/** microALGO → an ALGO string. Integer maths only; never a float. */
export function toAlgo(microAlgo) {
  const n = Math.abs(Math.trunc(microAlgo || 0));
  return `${Math.floor(n / 1_000_000)}.${String(n % 1_000_000).padStart(6, '0')}`;
}

export async function clearReceipts(sessionId) {
  const all = await readAll();
  delete all[sessionId];
  await writeAll(all);
}
