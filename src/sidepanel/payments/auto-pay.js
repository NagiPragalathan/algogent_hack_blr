/**
 * Paying without asking — one payment per action, no wallet, no popup.
 *
 * Everything next door assumes a person is holding the wallet: the 402 goes
 * out, a popup opens, they read the split and approve. That is right for a
 * purchase somebody chose to make and wrong for an agent run, which is thirty
 * actions — so `run-billing.js` accumulates them and takes ONE signature at the
 * end, which is the least bad thing you can do with a human in the loop.
 *
 * There is no human in this loop. The marketplace holds a client account of its
 * own (`CLIENT_MNEMONIC` in the site environment) and signs for the actions
 * itself, so a run can settle each action AS IT HAPPENS: the panel posts what
 * the agent just did and a confirmed receipt comes back. Nothing is asked, and
 * the run never stops to wait for an approval that is not coming.
 *
 * THE KEY IS NOT HERE AND MUST NEVER BE. The extension has no bundler and no
 * dependencies, so it cannot carry algosdk — and even if it could, a seed
 * phrase copied into `chrome.storage` is a seed phrase in every profile the
 * extension is installed in. The site signs; this asks it to. What the panel
 * holds is the ADDRESS, which is public the moment the account pays anybody.
 *
 * THE RULE THIS SHARES WITH EVERY OTHER FILE IN THIS FOLDER: a payment problem
 * never blocks an answer. Nothing here is awaited by anything the user is
 * waiting on, every failure returns a reason rather than throwing, and a
 * marketplace that is not configured to pay for itself simply falls back to the
 * wallet road exactly as before.
 */

// `api.js`, never `x402.js` — that one imports the wallet, and the wallet
// imports this file to draw the switch. See the note at the top of api.js.
import { apiBase, declined, NOTHING_TO_BILL } from './api.js';
import { recordRunReceipt } from './ledger.js';
import { emit, EVENTS } from '../core/bus.js';

/**
 * Who pays, once the probe has answered. Null means the wallet road.
 *
 * Asked once rather than inferred from a failure, for the same reason `probe()`
 * sits beside `session()` in the direct transport: a diagnostic that works out
 * its answer by watching something else fail eventually disagrees with reality,
 * and here the two roads are indistinguishable from a decline — "not charged"
 * with no way to tell an unconfigured deploy from a wallet on the wrong chain.
 */
let client = null;
let problem = 'the marketplace has not been asked yet';
let probe = null;

/**
 * The switch: pay for every agent step, or pay for nothing.
 *
 * ON, a transaction is signed and confirmed for each action the run takes. OFF,
 * no action charges anything — the run behaves exactly as it did before this
 * file existed. It is remembered, unlike agent mode itself, because it is a
 * billing preference rather than a capability that could start acting on its
 * own: the worst a remembered `false` does is not charge.
 *
 * Read synchronously by `run-billing.js` on the step path, so it is hydrated
 * once at boot rather than awaited per action. A cold read defaults to ON,
 * which matches the default and is the direction that produces a receipt.
 */
const ENABLED_KEY = 'x402AutoPayPerStep';
let enabled = true;

export const autoPayEnabled = () => enabled;
export const autoPayReady = () => enabled && Boolean(client);

/**
 * Whether the marketplace CAN pay, ignoring the switch.
 *
 * Two different questions and they are asked by different callers. The step
 * path wants "should I charge for this", which the switch answers. The wallet
 * panel wants "is there an account behind this at all", so it can draw a switch
 * that means something and a Test payment button that uses the same road a run
 * would — pressing that button is an explicit instruction and is not bound by a
 * default about unattended charging.
 */
export const autoPayConfigured = () => Boolean(client);
export const autoPayAddress = () => client?.address || null;
export const autoPayNetwork = () => client?.network || null;

/**
 * Why nothing would be charged automatically. The switch is named FIRST,
 * because "you turned it off" and "the deploy cannot pay" need opposite
 * responses and only one of them is a fault.
 */
export const autoPayProblem = () =>
  enabled ? problem : 'per-step payment is switched off in the wallet panel';

/**
 * The user's own seed phrase, if they have given one — and everything about
 * handling it is a compromise somebody has to have agreed to knowingly.
 *
 * WHY IT EXISTS. The marketplace has an account of its own and pays from it,
 * which is the fallback. Somebody who wants their OWN account to pay has two
 * ways to say so: connect a wallet, which means approving every payment, or
 * hand over the phrase, which means not being asked. This is the second.
 *
 * WHAT IT COSTS, and this is not hedging. A seed phrase is total control of an
 * account with no recovery and no revocation. This one sits in
 * `chrome.storage.local` — readable by anything with access to the profile —
 * and travels to the marketplace with every settlement, where it is used and
 * dropped. The honest summary is: use a throwaway account funded with what you
 * are willing to lose, and treat "I typed my seed into an extension" as a
 * decision, not a setting.
 *
 * WHAT IS GUARDED ANYWAY, because "the user agreed" is not a licence to be
 * careless with it:
 *
 *   - it goes to HTTPS or localhost and nowhere else (`safeDestination`), so a
 *     `marketplaceApi` override cannot quietly redirect it;
 *   - it is never rendered back into the panel — the wallet sheet shows the
 *     derived ADDRESS, which the server returns and which is public anyway;
 *   - it is never put on the chain: the note is built server-side from a fixed
 *     set of fields;
 *   - clearing it here clears it everywhere the panel keeps it, and payment
 *     returns to the marketplace's own account.
 */
const SEED_KEY = 'x402UserSeed';
let seed = '';
let seedAddress = '';

export const userSeedSet = () => Boolean(seed);
export const userSeedAddress = () => seedAddress;

/**
 * A seed may only be sent somewhere that cannot be eavesdropped, and
 * `marketplaceApi` is an override anyone with storage access can set. Without
 * this a redirected base URL turns a convenience into an exfiltration route,
 * and nothing on screen would say so.
 */
function safeDestination() {
  try {
    const url = new URL(apiBase());
    return url.protocol === 'https:' || url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

/**
 * Save a phrase, after asking the marketplace whose account it is.
 *
 * Validated remotely rather than locally because the panel cannot derive an
 * Algorand address — no bundler, no algosdk. That is not only a limitation: a
 * phrase that parses is not the same as an account that can pay, and the round
 * trip answers both at once. Nothing is stored until it comes back valid, so a
 * typo cannot silently replace a working payer.
 */
export async function setUserSeed(phrase) {
  const cleaned = String(phrase || '').trim().replace(/\s+/g, ' ');
  if (!cleaned) return { ok: false, reason: 'Enter your 25-word recovery phrase.' };

  const words = cleaned.split(' ');
  if (words.length !== 25) {
    // Checked here so an obvious mistake costs no round trip and, more to the
    // point, so a phrase that is plainly not one is never sent anywhere.
    return { ok: false, reason: `An Algorand phrase is 25 words; that is ${words.length}.` };
  }

  if (!safeDestination()) {
    return { ok: false, reason: `${apiBase()} is not https — a seed phrase will not be sent there.` };
  }

  let data;
  try {
    const res = await fetch(`${apiBase()}/api/x402/client`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mnemonic: cleaned })
    });
    data = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, reason: data?.message || `the marketplace answered ${res.status}` };
  } catch {
    return { ok: false, reason: 'the marketplace could not be reached' };
  }

  if (!data?.address) {
    return { ok: false, reason: data?.reason || 'the marketplace would not accept that phrase' };
  }

  seed = cleaned;
  seedAddress = data.address;
  client = { address: data.address, network: data.network, funded: data.funded, own: true };
  problem = data.funded === false ? `${data.address} is not funded` : '';

  try {
    await chrome.storage.local.set({ [SEED_KEY]: cleaned });
  } catch {
    // In memory it still works for this session; say nothing, because the
    // payment it is about to make will succeed either way.
  }

  return { ok: true, address: data.address, balance: data.balance, funded: data.funded };
}

/** Forget it. Payment goes back to the marketplace's own account. */
export async function clearUserSeed() {
  seed = '';
  seedAddress = '';
  try {
    await chrome.storage.local.remove(SEED_KEY);
  } catch {
    // Nothing to do about it, and the in-memory copy is already gone.
  }

  // Re-ask, so the sheet immediately shows the fallback account rather than
  // the address of a phrase that is no longer being used.
  probe = null;
  client = null;
  await initAutoPay();
}

/** Flip it, and remember. Returns the new state so a caller can repaint. */
export async function setAutoPayEnabled(on) {
  enabled = Boolean(on);
  try {
    await chrome.storage.local.set({ [ENABLED_KEY]: enabled });
  } catch {
    // A storage failure must not make the switch appear not to work; the
    // in-memory value has already changed and this session honours it.
  }
  return enabled;
}

/**
 * Ask the marketplace whether it pays for itself.
 *
 * Never awaited by `boot()`. Until it answers, `autoPayReady()` is false and
 * actions accumulate for the wallet road — which is the safe direction and,
 * for the handful of actions that can happen in that window, exactly the
 * behaviour that shipped before this file existed. `settleRun` re-checks at the
 * end, so anything banked during the probe is still paid the automatic way.
 */
export async function initAutoPay() {
  if (probe) return probe;

  probe = (async () => {
    try {
      const stored = await chrome.storage.local.get(ENABLED_KEY);
      if (stored && ENABLED_KEY in stored) enabled = stored[ENABLED_KEY] !== false;
    } catch {
      // Unreadable storage means the default, which is on.
    }

    try {
      const res = await fetch(`${apiBase()}/api/x402/client`, {
        headers: { accept: 'application/json' }
      });

      if (!res.ok) {
        problem = `the marketplace answered ${res.status}`;
        return null;
      }

      const data = await res.json();
      if (!data?.autoSign || !data?.address) {
        problem = data?.reason || 'the marketplace has no client account configured';
        return null;
      }

      client = { address: data.address, network: data.network, funded: data.funded };
      problem = '';

      /**
       * Said out loud, because "cannot pay" and "will not be able to pay" look
       * identical until the first action fails. An unfunded client account
       * fails at submission with "overspend", once per action, naming nothing.
       */
      if (data.funded === false) {
        problem = `the marketplace wallet ${data.address} is not funded`;
      }

      return client;
    } catch {
      problem = 'the marketplace could not be reached';
      return null;
    }
  })();

  return probe;
}

/**
 * A payment's ordinal, and it is not decoration.
 *
 * Settling per action builds each payment on its own, so two actions with the
 * same verb, price, label and session inside one block window are the SAME
 * transaction — identical sender, receiver, amount, note and validity window
 * means an identical id, and the chain refuses the second as already in the
 * ledger. Two `act-answer` lines in one conversation are exactly that shape.
 * The counter rides along in the on-chain note and makes each one distinct.
 *
 * Monotonic for the life of the panel rather than per run: a run is not the
 * unit that collides, a session is.
 */
let seq = 0;

/**
 * One settlement at a time.
 *
 * Not for correctness — Algorand has no nonce and accepts concurrent payments
 * from one account perfectly well — but for two things that bite anyway. A
 * batch of actions completing together would fire a handful of submissions in
 * the same millisecond, all built from the same suggested params, which is the
 * collision above at its most likely; and the receipts would land in whatever
 * order the network confirmed them, so the fee block would list a run's actions
 * out of the order the user watched them happen.
 *
 * A failure must not stop the queue, hence the swallow: the next action's
 * payment is unrelated to this one's and has its own reason to succeed.
 */
let queue = Promise.resolve();

function enqueue(work) {
  const next = queue.then(work, work);
  queue = next.then(
    () => {},
    () => {}
  );
  return next;
}

/**
 * Pay for these items, now, on the marketplace's own account.
 *
 * Returns `{paid:true, receipt}` or `{paid:false, reason}` and never throws.
 * One call, not three: there is no 402 to answer and no signature to carry
 * back, because the side that holds the key is the side doing the work.
 */
export function payAuto(items, sessionId, { force = false } = {}) {
  if (!items?.length) return Promise.resolve(declined(NOTHING_TO_BILL));

  /**
   * The switch is checked HERE as well as at the call site, and that is not
   * belt and braces — it is the only check that covers the bag `settleRun`
   * flushes at the end of a run, which may have been filled before anyone
   * looked at a switch. Off means no transaction, on any road.
   *
   * `force` is the Test payment button and nothing else: somebody pressed it,
   * on purpose, to find out whether paying works. A default about unattended
   * charging has no business refusing a direct instruction.
   */
  if (!enabled && !force) return Promise.resolve(declined(autoPayProblem()));
  if (!client) return Promise.resolve(declined(problem || 'automatic payment is not available'));

  // Stamped here rather than at the call sites, so nothing can file an item
  // without one and every ordinal comes from a single counter.
  const stamped = items.map((item) => ({ ...item, seq: (seq += 1) }));

  return enqueue(() => settle(stamped, sessionId));
}

async function settle(items, sessionId) {
  let settled;

  try {
    const res = await fetch(`${apiBase()}/api/x402/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ autoSign: true, sessionId, items })
    });

    settled = await res.json().catch(() => null);

    if (!res.ok) {
      /**
       * The server priced everything and found nothing chargeable — a free
       * action, working correctly. Reported as free rather than as a fault,
       * and never filed as a decline.
       */
      if (settled?.error === 'nothing_billable') return declined(NOTHING_TO_BILL);

      /**
       * The deploy has no client account, or refuses to use one on this chain.
       * Remembered, so the rest of the run stops asking: thirty actions each
       * discovering the same 503 is thirty round trips for one fact.
       */
      if (settled?.error === 'autosign_unavailable') {
        client = null;
        problem = settled.message || 'the marketplace no longer signs automatically';
      }

      return declined(settled?.message || `the marketplace answered ${res.status}`);
    }
  } catch {
    return declined('the marketplace could not be reached');
  }

  await recordRunReceipt(sessionId, settled);
  emit(EVENTS.RENDER_THREAD);
  return { paid: true, receipt: settled };
}
