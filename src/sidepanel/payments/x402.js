/**
 * Paying a skill's author, from the panel.
 *
 * A skill is an agent: someone wrote the prompt, published it, and gets paid
 * when it is used. This module is the buyer's side of that — the x402 flow of
 * "ask what is owed, sign it, settle it", against the marketplace API.
 *
 * WHY IT LIVES IN THE PANEL AND NOT THE WORKER. The wallet does. Lute, Pera,
 * Defly and Exodus all sign through an injected object on a window, and a
 * service worker has no window — so the signature has to happen here. The
 * worker never sees a key and never holds one.
 *
 * WHY IT BUILDS NO TRANSACTIONS. It cannot: this extension has no bundler and
 * no dependencies (see AGENTS.md), so it cannot carry algosdk, and hand-rolling
 * msgpack, base32 and SHA-512/256 in a panel script to move real money is not a
 * trade worth making. The server builds the group; this signs it. That is also
 * what makes the split trustworthy — the percentage and the company address are
 * the two numbers a client would have every reason to rewrite, and this client
 * never supplies either. It signs what it is given, and the server re-checks
 * the signed bytes against its own quote before submitting.
 *
 * THE RULE THAT MATTERS MOST: a payment problem NEVER blocks an answer. An
 * unregistered skill is free, an unreachable API is free, a wallet that is not
 * connected is free. Every one of those returns a reason and the question goes
 * out anyway. Charging is a feature of the marketplace; answering is the
 * product, and a panel that refuses to think because a payments endpoint is
 * down is worse than one that forgets to bill.
 */

import { walletState, getWalletSigner, NETWORKS } from '../ui/wallet.js';
import { emit, EVENTS } from '../core/bus.js';
import { recordReceipt } from './ledger.js';

/** Where the marketplace lives. Overridable for a local API during development. */
const DEFAULT_API = 'https://algogent.vercel.app';

let base = DEFAULT_API;

/** Where the marketplace lives, read at call time so a stored override applies. */
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
 * What is payable, and what it costs.
 *
 * Everything the marketplace lists: published skills, one entry per agent
 * ACTION, and `act-answer` for a plain question. Deliberately not filtered by
 * the caller — a filtered listing is indistinguishable from a catalogue where
 * the missing entries are free, so narrowing it here silently switches off
 * whole categories of billing. It did exactly that: see the note at the call
 * site in sidepanel.js.
 *
 * Cached for the life of the panel rather than re-fetched per question: prices
 * change when a developer edits them, not between two messages, and a network
 * round trip in front of every send is exactly the latency this whole codebase
 * spends its time removing.
 */
let listing = null;

/**
 * Why the listing is not here, if it is not.
 *
 * Kept even though the run path no longer consults it. That path stopped
 * asking the client whether something is priced at all — the server decides,
 * because a cached listing that failed to load once is a kill switch nothing
 * can see (the note in `run-billing.js`). `payForSkill` still gates on the
 * listing, so the reason is still worth having there, and the Options page
 * wants it too.
 */
let listingProblem = '';

export const listingMissing = () => (listing ? '' : listingProblem || 'the price list has not loaded yet');

export async function loadListing() {
  if (listing) return listing;

  try {
    const res = await fetch(`${base}/api/agents`, {
      headers: { accept: 'application/json' }
    });
    if (!res.ok) {
      listingProblem = `the marketplace answered ${res.status}`;
      return null;
    }

    const data = await res.json();
    listing = {
      network: data.network,
      companyBps: data.companyBps,
      byId: new Map(data.agents.map((a) => [a.id, a]))
    };
    listingProblem = '';
    return listing;
  } catch {
    // No listing means nothing is payable, which is the safe direction.
    listingProblem = 'the marketplace could not be reached';
    return null;
  }
}

/** What something costs, or null if it is free. */
export function priceOf(agentId) {
  return listing?.byId.get(agentId) || null;
}

/** Which chain the listing settles on, for the wallet-agreement check. */
export const listedNetwork = () => listing?.network || null;

/**
 * The reasons a call is not charged.
 *
 * Returned rather than thrown, and worded for a person, because every one of
 * them is a thing the user might want to fix — and none of them is a failure of
 * the question they just asked.
 */
export const declined = (reason) => ({ paid: false, reason });
const free = declined;

/**
 * Pay for one use of one skill.
 *
 * Returns `{paid:true, receipt}` or `{paid:false, reason}`. It never throws and
 * it never blocks: every failure path here ends in the question being asked
 * anyway.
 */
export async function payForSkill(skill, { sessionId } = {}) {
  const agent = priceOf(skill.id);
  if (!agent) return free('not listed on the marketplace');

  if (!walletState.connected || !walletState.address) {
    return free('no wallet connected');
  }

  // The listing and the wallet must agree about which chain this is. Signing a
  // TestNet group with a MainNet wallet produces a signature the chain will
  // never accept, and the error it gives back says nothing about why.
  if (listing.network !== walletState.network) {
    return free(
      `wallet is on ${NETWORKS[walletState.network]?.name || walletState.network}, ` +
        `the marketplace settles on ${listing.network}`
    );
  }

  const signer = getWalletSigner();
  if (!signer) return free('the connected wallet cannot sign here');

  let quote;
  try {
    const res = await fetch(`${base}/api/x402/quote`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: skill.id, buyer: walletState.address, sessionId })
    });

    // 402 is the SUCCESS case here — it is the challenge, not a failure.
    if (res.status !== 402) {
      const body = await res.json().catch(() => null);
      return free(body?.message || `the marketplace answered ${res.status}`);
    }
    quote = await res.json();
  } catch {
    return free('the marketplace could not be reached');
  }

  const terms = quote?.accepts?.[0];
  const extra = terms?.extra;
  if (!extra?.transactions?.length) return free('the quote carried no transactions');

  let signed;
  try {
    // ARC-0001: base64 msgpack in, base64 msgpack out, in the same order — a
    // reordered group has a different group id and will not validate.
    signed = await signer.signTransactions(extra.transactions.map((t) => t.txn));
  } catch (error) {
    // A user declining in their wallet is not an error to report loudly. It is
    // the most ordinary thing that can happen here.
    const message = String(error?.message || error);
    return free(/reject|denied|cancel|closed/i.test(message) ? 'payment declined' : message);
  }

  if (!Array.isArray(signed) || signed.length !== extra.transactions.length) {
    return free('the wallet did not return a signature for every transaction');
  }

  try {
    const res = await fetch(`${base}/api/x402/settle`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agentId: skill.id,
        buyer: walletState.address,
        sessionId,
        toolLabel: skill.title || skill.slug || skill.id,
        // Some wallets answer with byte arrays rather than base64 strings.
        signed: signed.map(toBase64)
      })
    });

    const body = await res.json().catch(() => null);
    if (!res.ok) return free(body?.message || `settlement answered ${res.status}`);

    await recordReceipt(sessionId, body);
    return { paid: true, receipt: body };
  } catch {
    return free('settlement could not be reached');
  }
}

/**
 * Charge for a skill without making the question wait for it.
 *
 * This is the entry point the composer uses, and the shape is the whole of the
 * design: it is NEVER awaited. Signing means a wallet popup and a chain round
 * trip, and putting either in front of the send would mean a question that
 * cannot be asked until a payment clears — for a panel whose entire product is
 * answering quickly. The question goes now; the receipt catches up.
 *
 * That ordering also decides what happens when payment fails: nothing. The
 * answer was already on its way. A failure here is a receipt that never
 * appears, not an answer that never arrives.
 *
 * The bus rather than a direct repaint, because `ui/thread.js` already reaches
 * `ui/receipts.js`, and importing the thread from here would close the ring
 * `core/bus.js` exists to prevent.
 */
export function chargeForSkill(skill, sessionId) {
  if (!skill || !sessionId) return;

  void payForSkill(skill, { sessionId }).then((result) => {
    if (result?.paid) emit(EVENTS.RENDER_THREAD);
  });
}

/**
 * Wallets disagree about what `signTxns` returns: a base64 string, a Uint8Array
 * or a plain array of bytes. Normalising here rather than at four call sites is
 * the difference between one conversion and four that drift.
 */
export function toBase64(value) {
  if (typeof value === 'string') return value;

  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
