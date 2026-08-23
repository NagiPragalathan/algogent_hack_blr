/**
 * Billing an agent run: one transaction per action, signed as it happens or
 * once at the end depending on who is holding the key.
 *
 * THERE ARE TWO ROADS AND ONE SWITCH, and `charge()` below is where they part.
 * When the marketplace signs for itself (`auto-pay.js`) an action is paid the
 * moment it happens — there is no popup to batch away from, so batching would
 * only delay the receipt and lose the ones a Stop throws away. When it does
 * not, the actions accumulate and take ONE wallet signature at the end, which
 * is the original design and everything below still describes it. The switch —
 * `autoPayEnabled` — is checked before anything is even recorded: off means no
 * transaction, not a transaction deferred to a different door.
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
import { state } from '../core/state.js';
import { sessionOf } from '../core/runs.js';
import { apiBase, toBase64, declined, listedNetwork, NOTHING_TO_BILL } from './x402.js';
import { payAuto, autoPayReady, autoPayEnabled, autoPayConfigured } from './auto-pay.js';
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
 * Which conversation a request belongs to, resolved the way every other call
 * site resolves it — and the `.id` is the whole of why this is a helper.
 *
 * `sessionOf` returns the session OBJECT, and passing that where an id belongs
 * serialised an entire conversation into an on-chain note once already: the
 * user's question, the provider's answer and the conversation URL, public and
 * permanent. Charging per step multiplies the number of places that mistake
 * could be made by thirty, so it is made in one place instead.
 *
 * `state.session` is the fallback rather than the answer, because the panel
 * follows tabs and a run routinely finishes for a conversation that is no
 * longer on screen.
 */
const sessionFor = (id) => sessionOf(id)?.id ?? state.session?.id ?? null;

/**
 * File the outcome of a charge, whichever road it took.
 *
 * "Nothing was charged" and "something should have been charged and could not
 * be" are different facts and only the second is actionable — a wallet on the
 * wrong chain, an unfunded marketplace account, a marketplace that is down.
 * Dropping those on the floor is what made the last billing bug invisible.
 */
function report(result, sessionId) {
  if (!result.paid && result.reason !== NOTHING_TO_BILL) {
    recordDecline(sessionId, result.reason);
    emit(EVENTS.RENDER_THREAD);
  }
  return result;
}

/**
 * Charge for one item the instant it happened, or bank it for the wallet.
 *
 * This is the fork the whole per-step feature turns on, and it is deliberately
 * the only place that decides. A run's action is charged NOW when the
 * marketplace signs for itself — there is no popup to batch away from, so
 * batching would only delay the receipt and lose the ones a Stop discards. When
 * it does not sign for itself the item is banked exactly as before, because
 * thirty wallet prompts is not a thing anybody approves.
 *
 * Never awaited. The run is mid-flight and a payment may not hold it up.
 */
function charge(id, item) {
  if (!autoPayReady()) {
    const list = pending.get(id) || [];
    list.push(item);
    pending.set(id, list);
    return;
  }

  const sessionId = sessionFor(id);
  void payAuto([item], sessionId).then((result) => report(result, sessionId));
}

/**
 * Record one executed action against its run.
 *
 * Called for every AGENT_STEP. Steps that are not actions — a screenshot note,
 * a halted batch, a dead-link notice — carry a `kind` that is not a verb, so
 * they map to an id no agent has and the SERVER drops them, rather than needing
 * a second list here that would drift from the first.
 */
export function noteAction(runId, step) {
  if (!runId || !step?.kind || UNBILLED.has(step.kind)) return;

  /**
   * The switch, and it is checked before anything is recorded rather than
   * before anything is charged.
   *
   * Off has to mean no transaction, not a transaction deferred: recording the
   * action and skipping the charge would leave the bag to be settled at the end
   * of the run, which is a payment the user switched off arriving a minute
   * later through a different door. Nothing is filed, so nothing is owed.
   */
  if (!autoPayEnabled()) return;

  /**
   * NOT gated on `priceOf`, and that was the bug that switched billing off.
   *
   * The obvious version asks the cached listing whether this verb has a
   * price and drops it if not — which reads as an optimisation and is a
   * silent kill switch, because the listing is fetched ONCE at boot and
   * cached for the life of the panel. A panel opened while the marketplace
   * was down has `listing === null` forever, so every action of every run is
   * dropped here, `settleRun` finds an empty list, and the whole thing is
   * indistinguishable from a run that was free. Measured: a three-step Gmail
   * run, no wallet prompt, no receipt, no error.
   *
   * The SERVER is the authority on price and always was — `priceItems` in
   * api/x402/run.js looks every id up and reports what it skipped. So the
   * verb is recorded unconditionally and priced once, at settlement, by the
   * thing that actually knows. The cost of a verb nobody sells is one round
   * trip per RUN, which the server answers with a clean "nothing priced".
   */
  charge(runId, {
    agentId: agentIdFor(step.kind),
    // The label the user actually read in the timeline, so the receipt line and
    // the step it paid for say the same thing.
    label: String(step.description || step.kind).slice(0, 120),
    step: Number.isInteger(step.step) ? step.step : null
  });
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
  // The same switch, for the same reason — see `noteAction`.
  if (!autoPayEnabled()) return;

  // Unpriced until the server says otherwise — see `noteAction` above.
  charge(reqId, {
    agentId: ANSWER_AGENT_ID,
    label: providerId ? `Answer from ${providerId}` : 'Answer',
    step: null
  });
}

/** Forget a run without charging for it — Stop, or a run that never billed. */
export function dropRun(runId) {
  pending.delete(runId);
}

/**
 * One real x402 payment, on demand, so signing can be checked without a run.
 *
 * Everything else here settles at the END of something — a run finishing, a
 * question answered — which makes "is the wallet actually wired up?" a
 * question you can only answer by doing a minute of unrelated work first.
 * Every failure in this layer has been diagnosed that way and it is a bad
 * loop: an agent run, a wait, and an outcome with four possible causes.
 *
 * Deliberately NOT a mock and not a separate road. It is the same
 * quote → sign → settle → receipt the panel uses, with one item and no agent
 * in front of it — a test button that exercises a different path only tells
 * you about the path you do not use.
 *
 * It costs one action, really, on whatever network the wallet is on. That is
 * the point, and the button says so.
 */
export function testPayment(sessionId) {
  const item = {
    agentId: ANSWER_AGENT_ID,
    label: 'Test payment from the wallet panel',
    step: null
  };

  /**
   * Whichever road a run would take — and `force`, because the per-step switch
   * is a default about UNATTENDED charging and this is somebody pressing a
   * button to find out whether paying works at all. Refusing it because the
   * switch is off would answer a question nobody asked.
   */
  if (autoPayConfigured()) {
    return payAuto([item], sessionId, { force: true }).then((result) =>
      report(result, sessionId)
    );
  }

  const runId = `test-${Date.now().toString(36)}`;
  pending.set(runId, [item]);
  return settleRun(runId, sessionId);
}

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
  return report(await attemptSettle(runId, sessionId), sessionId);
}

async function attemptSettle(runId, sessionId) {
  const items = pending.get(runId);
  pending.delete(runId);

  /**
   * Genuinely nothing to bill: no action ran, every one of them was
   * `ask`/`finish`, or each was already paid for as it happened. Not a fault,
   * and the only decline never reported.
   */
  if (!items?.length) return declined(NOTHING_TO_BILL);

  /**
   * Anything banked before the probe answered still goes the automatic way.
   *
   * The probe is a network round trip started at boot, so the first few actions
   * of a run that begins immediately are filed for the wallet road by a panel
   * that did not yet know there was another one. Settling them here rather than
   * prompting is what makes the switch mean one thing: on, the marketplace
   * pays; off, nothing does.
   */
  if (autoPayReady()) return payAuto(items, sessionId);

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

      /**
       * The server priced everything and found nothing chargeable. That is
       * the free case arriving one layer later than it used to, and it is
       * reported as free rather than as a fault — the panel's own copy of
       * the price list is no longer what decides it.
       */
      if (problem?.error === 'nothing_billable') return declined(NOTHING_TO_BILL);

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

    if (/reject|denied|cancel|closed/i.test(message)) return declined('payment declined');

    const shortBuyer = `${buyer.slice(0, 6)}…${buyer.slice(-4)}`;

    /**
     * "Account Not Found" is the panel and the wallet disagreeing about WHO.
     *
     * The panel remembers the address it was connected with; the wallet holds
     * whatever accounts it currently holds. Those drift apart in the most
     * ordinary ways — a different account selected in the wallet, a web
     * session cleared, a second wallet — and nothing tells the panel, because
     * a connection is a one-time handshake that returns an address and then
     * nothing else ever again.
     *
     * Measured: the panel signing as B55UYG…5KXU while the wallet on screen
     * held ZYQRMSLG…333YM. Two different accounts, one honest error, and no
     * hint anywhere that reconnecting was the whole fix. The wallet's own
     * wording cannot say this — only we know which address we asked for.
     */
    if (/account not found|no account|unknown account/i.test(message)) {
      return declined(
        `Your wallet does not have ${shortBuyer}, which is the account this panel ` +
          `is connected as. Open the wallet panel, Disconnect, and reconnect with ` +
          `the account you want to pay from.`
      );
    }

    /**
     * Everything else: the wallet's own words, plus the two facts it never
     * includes — which account we asked it to sign as, and on which network.
     */
    return declined(
      `${message} — signing as ${shortBuyer} on ${network || walletState.network}.`
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
