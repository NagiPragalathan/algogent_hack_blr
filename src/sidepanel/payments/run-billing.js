/**
 * Billing an agent run: one signature at the end, one transaction per action.
 *
 * Every step the run takes — navigate, read_url, click, type, screenshot — is a
 * registered agent with an owner and a price, so a run's receipt has a line per
 * step the user watched happen rather than one lump sum for "the agent". None
 * of that is hardcoded here: the prices and the payout addresses come from the
 * marketplace registry, so publishing an agent or changing its price needs no
 * extension release.
 *
 * WHY IT SETTLES AT THE END. A run is thirty actions and a wallet prompt per
 * action is unusable — nobody approves thirty popups, and the eleventh refusal
 * would strand the run halfway paid. So the actions accumulate while the run
 * works and are signed ONCE when it finishes.
 *
 * WHY THAT IS NOT JUST "ONE PAYMENT". The signature is one; the payments are
 * not. The group carries a leg per action, so every line on the receipt has its
 * own transaction id that anyone can check on a public explorer without
 * trusting us. A single lump sum with a percentage table beside it is exactly
 * the claim this is meant to replace.
 *
 * WHY A FAILURE HERE IS SILENT. The run has already finished and the answer is
 * already on screen. A payment that cannot be made costs a receipt, never an
 * answer — see the reasons in x402.js, which are all returned rather than
 * thrown.
 */

import { walletState, getWalletSigner, NETWORKS } from '../ui/wallet.js';
import { emit, EVENTS } from '../core/bus.js';
import { apiBase, priceOf, toBase64, declined, listingMissing, listedNetwork } from './x402.js';
import { recordRunReceipt, recordDecline } from './ledger.js';

/**
 * Action verbs that are not work anybody sells.
 *
 * `ask` is the run stopping to ask the USER something, and `finish` is it
 * writing the answer — charging for either means charging someone for being
 * interrupted and for being told the result. They are registered as agents so
 * the vocabulary is complete and a price could be set later; they are skipped
 * here because charging for them now would be indefensible.
 */
const UNBILLED = new Set(['ask', 'finish']);

/** `read_url` → `act-read-url`. The registry ids mirror the verbs. */
const agentIdFor = (verb) => `act-${String(verb).replace(/_/g, '-')}`;

/** runId → the actions it has taken, in order. */
const pending = new Map();

/**
 * Record one executed action against its run.
 *
 * Called for every AGENT_STEP. Steps that are not actions — a screenshot note,
 * a halted batch, a dead-link notice — carry a `kind` that is not a verb, so
 * they find no registered agent and are dropped by `priceOf` rather than needing
 * a second list here that would drift from the first.
 */
export function noteAction(runId, step) {
  if (!runId || !step?.kind || UNBILLED.has(step.kind)) return;

  const agentId = agentIdFor(step.kind);
  if (!priceOf(agentId)) return;

  const list = pending.get(runId) || [];
  list.push({
    agentId,
    // The label the user actually read in the timeline, so the receipt line and
    // the step it paid for say the same thing.
    label: String(step.description || step.kind).slice(0, 120),
    step: Number.isInteger(step.step) ? step.step : null
  });
  pending.set(runId, list);
}

/**
 * The registry id for one answer from one provider.
 *
 * An answer is work: a question was sent to a provider through the user's own
 * session, streamed back and rendered. Charging for it is the same claim the
 * per-action lines make about a run, one size smaller — and without it the
 * only chats that ever produce a receipt are the ones that happened to run an
 * agent or arm a paid skill, which reads as billing that works sometimes.
 */
export const ANSWER_AGENT_ID = 'act-answer';

/**
 * Record one answered question against its request.
 *
 * Per PROVIDER, not per question: compare mode fans one question out to four
 * providers and gets four answers back, which is four times the work and four
 * lines on the receipt. Charging once for four would be the lump sum this
 * whole layer exists to replace.
 *
 * Keyed on the request id, which `settleRun` treats as opaque — a chat turn
 * and an agent run are the same thing to it: a bag of billable items that
 * settles once at the end.
 */
export function noteAnswer(reqId, providerId) {
  if (!reqId) return;
  if (!priceOf(ANSWER_AGENT_ID)) return;

  const list = pending.get(reqId) || [];
  list.push({
    agentId: ANSWER_AGENT_ID,
    label: providerId ? `Answer from ${providerId}` : 'Answer',
    step: null
  });
  pending.set(reqId, list);
}

/** Forget a run without charging for it — Stop, or a run that never billed. */
export function dropRun(runId) {
  pending.delete(runId);
}

/** The one decline that is not worth telling anybody about. See below. */
const NOTHING_TO_BILL = 'nothing billable here';

/**
 * Settle everything one request did — a run's actions, or a chat turn's
 * answers. Both are the same thing here: a bag of items that pays once.
 *
 * Returns `{paid:true, …}` or `{paid:false, reason}`. Never throws: this is
 * called from a message handler on the way out of a finished run, and an
 * exception here would take the request's own completion handling with it.
 *
 * The wrapper exists to FILE the failure. Every reason in `attemptSettle` is
 * something the user might want to fix, and until now every one of them was
 * dropped on the floor by a `void` at the call site — so a run that should
 * have been billed and was not looked exactly like a run that was free.
 * Everything is recorded except the one case that is genuinely nothing to
 * report: no priced items, with a price list that loaded fine.
 */
export async function settleRun(runId, sessionId) {
  const result = await attemptSettle(runId, sessionId);

  if (!result.paid && result.reason !== NOTHING_TO_BILL) {
    recordDecline(sessionId, result.reason);
    emit(EVENTS.RENDER_THREAD);
  }

  return result;
}

async function attemptSettle(runId, sessionId) {
  const items = pending.get(runId);
  pending.delete(runId);

  /**
   * Nothing billable is USUALLY correct and occasionally a fault.
   *
   * A run of free actions bills nothing and says nothing, which is right. A
   * panel whose price list never loaded also bills nothing — and that is
   * billing switched off for every conversation, reported identically. The
   * two are told apart here so the second can reach the user.
   */
  if (!items?.length) {
    const missing = listingMissing();
    return declined(missing || NOTHING_TO_BILL);
  }

  if (!walletState.connected || !walletState.address) return declined('no wallet connected');

  /**
   * The listing and the wallet must agree about which chain this is.
   *
   * `payForSkill` has checked this since it was written; this path never did,
   * so a TestNet quote signed by a MainNet wallet failed at submission with an
   * error that says nothing about why. Same check, same wording.
   */
  const network = listedNetwork();
  if (network && network !== walletState.network) {
    return declined(
      `wallet is on ${NETWORKS[walletState.network]?.name || walletState.network}, ` +
        `the marketplace settles on ${network}`
    );
  }

  const signer = getWalletSigner();
  if (!signer) return declined('the connected wallet cannot sign here');

  const buyer = walletState.address;

  let quote;
  try {
    const res = await fetch(`${apiBase()}/api/x402/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ buyer, sessionId, items })
    });

    // 402 is the success case — it is the challenge, not a failure.
    if (res.status !== 402) {
      const problem = await res.json().catch(() => null);
      return declined(problem?.message || `the marketplace answered ${res.status}`);
    }
    quote = await res.json();
  } catch {
    return declined('the marketplace could not be reached');
  }

  const groups = quote?.accepts?.[0]?.extra?.groups;
  if (!groups?.length) return declined('the quote carried no transactions');

  /**
   * Every group in ONE signing call.
   *
   * ARC-0001 takes a flat array, so a run long enough to need two groups still
   * costs the user a single approval. They are flattened here and cut back into
   * groups below, because a group is the unit the CHAIN accepts even though it
   * is not the unit the WALLET signs.
   */
  const flat = groups.flatMap((g) => g.transactions.map((t) => t.txn));

  let signed;
  try {
    signed = await signer.signTransactions(flat);
  } catch (error) {
    const message = String(error?.message || error);
    return declined(
      /reject|denied|cancel|closed/i.test(message) ? 'payment declined' : message
    );
  }

  if (!Array.isArray(signed) || signed.length !== flat.length) {
    return declined('the wallet did not sign every transaction');
  }

  let cursor = 0;
  const byGroup = groups.map((g) => ({
    signed: signed.slice(cursor, (cursor += g.transactions.length)).map(toBase64)
  }));

  try {
    const res = await fetch(`${apiBase()}/api/x402/run?settle=1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ buyer, sessionId, items, groups: byGroup })
    });

    const settled = await res.json().catch(() => null);
    if (!res.ok) return declined(settled?.message || `settlement answered ${res.status}`);

    await recordRunReceipt(sessionId, settled);
    emit(EVENTS.RENDER_THREAD);
    return { paid: true, receipt: settled };
  } catch {
    return declined('settlement could not be reached');
  }
}
