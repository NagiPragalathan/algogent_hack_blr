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
  clearDecline(sessionId);
}

/**
 * File a whole run's settlement.
 *
 * A run settles once but pays many times, so what comes back is a list of LINES
 * — one per action, each with its own transaction id — rather than the single
 * developer/company pair a skill purchase produces. It is normalised into the
 * same envelope so the renderer has one shape to draw and not two.
 *
 * Keyed on the first receipt id for the same reason a skill receipt is keyed on
 * its own: settling twice after a dropped response must not show the run's cost
 * doubled.
 */
export async function recordRunReceipt(sessionId, settled) {
  if (!sessionId || !settled?.receiptIds?.length) return;

  const receiptId = Number(settled.receiptIds[0]);
  const totals = settled.totals || {};

  await recordReceipt(sessionId, {
    receiptId,
    kind: 'run',
    agentId: null,
    /**
     * "1 agent actions" is what a per-step settlement produced, and it is both
     * ungrammatical and less informative than the thing it is describing. When
     * a receipt covers exactly one action, the action's own label IS the label
     * — which is the whole point of charging per step: the row in the fee block
     * and the step in the timeline say the same thing.
     */
    toolLabel: (() => {
      // `lines` includes the marketplace leg, so "exactly one action" is a
      // question about the ACTION lines — testing the array's length made this
      // branch unreachable for every receipt that had a company cut, which is
      // all of them.
      const actions = (settled.lines || []).filter((l) => l.agentId);
      if (actions.length === 1) return actions[0].label;
      const n = totals.actions ?? actions.length ?? 0;
      return `${n} agent ${n === 1 ? 'action' : 'actions'}`;
    })(),
    network: settled.network,
    from: settled.from,
    paidAt: new Date().toISOString(),
    total: { microAlgo: totals.totalMicroAlgo, algo: totals.totalAlgo },
    // Kept flat rather than nested under developer/company: for a run these are
    // sums across many payees, and pretending they are one payee's line would
    // make the receipt claim something the chain does not say.
    developerTotal: { microAlgo: totals.developerMicroAlgo, algo: totals.developerAlgo },
    companyTotal: { microAlgo: totals.companyMicroAlgo, algo: totals.companyAlgo },
    networkFee: { microAlgo: totals.networkFeeMicroAlgo, algo: totals.networkFeeAlgo },
    confirmedRound: settled.groups?.[0]?.confirmedRound ?? null,
    /** One per action, each independently checkable. */
    lines: settled.lines || []
  });
}

/**
 * Why the last charge in this conversation did not happen.
 *
 * The rule next door — a chat where nothing was charged shows NOTHING, because
 * an empty "fees: none" under every answer trains people to stop reading the
 * place the real numbers appear — is right and is not what this is. "Nothing
 * was charged" and "something should have been charged and could not be" are
 * different facts, and only the second one is a thing the user can fix: a
 * wallet that is not connected, one on the wrong chain, a declined signature,
 * a marketplace that is down.
 *
 * Reported because the alternative was measured and is worse: a two-step run
 * finished with no receipt, no error and no explanation, and from the screen
 * that is indistinguishable from billing simply not being built. A free action
 * still says nothing at all — `settleRun` never records that case.
 *
 * In memory rather than storage, deliberately. It describes an attempt, not a
 * payment: there is nothing here anyone needs back after a reload, and writing
 * failures to disk beside the receipts would make the ledger look like a record
 * of money that moved.
 */
const declines = new Map();

export function recordDecline(sessionId, reason) {
  if (!sessionId || !reason) return;
  declines.set(sessionId, { reason: String(reason), at: Date.now() });
}

/** Cleared by a payment that DOES land, so a stale reason cannot outlive it. */
export function clearDecline(sessionId) {
  declines.delete(sessionId);
}

export const declineFor = (sessionId) => (sessionId ? declines.get(sessionId) || null : null);

/** Every receipt for one conversation, oldest first — the order they ran in. */
export async function receiptsFor(sessionId) {
  if (!sessionId) return [];
  const all = await readAll();
  return all[sessionId] || [];
}

/**
 * The action lines in a receipt — the marketplace's cut is NOT one.
 *
 * `lines` carries a leg per action AND the marketplace leg, because both are
 * transactions and both need a row anyone can check. Counting the length of
 * that array as "how many actions" therefore reports one too many on every
 * receipt: a run that navigated once said "Fees · 2 actions" over a single
 * step, which is the block claiming work that did not happen. The company leg
 * is the one with no `agentId`, which is also how the server writes it.
 */
export const actionLines = (receipt) => (receipt?.lines || []).filter((l) => l.agentId);

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
    /**
     * Actions billed across the whole conversation, runs included — and the
     * marketplace's cut is not one of them. See `actionLines`.
     */
    actions: receipts.reduce((acc, r) => acc + (r.lines ? actionLines(r).length : 1), 0),
    totalMicroAlgo: total,
    // A skill receipt names one developer; a run receipt sums many. Both are
    // read here so a conversation mixing the two still adds up.
    developerMicroAlgo: sum((r) => r.developer?.microAlgo ?? r.developerTotal?.microAlgo),
    companyMicroAlgo: sum((r) => r.company?.microAlgo ?? r.companyTotal?.microAlgo),
    networkFeeMicroAlgo: fee,
    spentMicroAlgo: total + fee
  };
}

/**
 * Everyone who was paid in this conversation, and how much in total.
 *
 * The per-leg rows answer "what did THIS action cost"; they do not answer
 * "how much has this address received", which is the question anyone
 * reconciling against a block explorer is actually asking — an explorer shows
 * an account's balance, not our list of steps. Twenty legs to two addresses
 * means twenty rows the reader has to add up by hand to check one number.
 *
 * Summed from the same lines the rows are drawn from, for the reason `totalsOf`
 * is: a summary that disagrees with the list above it is the one bug a receipt
 * cannot survive.
 */
export function payeesOf(receipts) {
  const by = new Map();

  const add = (address, microAlgo, role, network) => {
    if (!address || !microAlgo) return;
    const at = by.get(address) || { address, microAlgo: 0, calls: 0, role, network };
    at.microAlgo += microAlgo;
    at.calls += 1;
    // A developer address that also happens to be the marketplace's stays
    // labelled by whichever role it filled first; the amount is what matters.
    by.set(address, at);
  };

  for (const receipt of receipts) {
    if (receipt.lines?.length) {
      for (const line of receipt.lines) {
        add(line.to, line.microAlgo, line.agentId ? 'developer' : 'marketplace', receipt.network);
      }
    } else {
      add(receipt.developer?.address, receipt.developer?.microAlgo, 'developer', receipt.network);
      add(receipt.company?.address, receipt.company?.microAlgo, 'marketplace', receipt.network);
    }
  }

  return [...by.values()].sort((a, b) => b.microAlgo - a.microAlgo);
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
