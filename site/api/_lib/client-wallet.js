/**
 * The account that signs when nobody is there to press approve.
 *
 * Every other road through this folder is built on the assumption that a person
 * is holding the wallet: the 402 goes out, a popup opens, they read the split
 * and approve it. That is the right shape for a purchase somebody chose to
 * make, and it is the wrong shape for an agent run — a run is thirty actions,
 * and the honest version of "charge per action" is thirty signatures, which
 * nobody approves and which would stop the run dead somewhere in the middle.
 *
 * So the marketplace can hold a client account of its own and sign for the
 * actions itself. The extension then asks for nothing, opens no popup and
 * carries no key: it posts what the run did, and a receipt comes back.
 *
 * WHAT THIS IS, PLAINLY: a hot key on a server. The mnemonic is total control
 * of the account and there is no confirmation step in front of it — anything
 * that can reach `/api/x402/run` with `autoSign` can spend from it, bounded
 * only by the price list and `MAX_ITEMS`. That is an acceptable trade for a
 * TestNet demo wallet holding worthless ALGO and a bad one for real money, so
 * MainNet needs `X402_AUTOSIGN_MAINNET=1` said out loud. Fund it with what you
 * are willing to lose and nothing else.
 *
 * It is also why the mnemonic is the one value in `config.js` with no default
 * and no fallback to anything committed. A payout address is public the moment
 * anyone is paid; a seed phrase never becomes public safely.
 */
import algosdk from 'algosdk';
import { clientMnemonic, autoSignEnabled, autoSignMainnetAllowed } from './config.js';

/**
 * Derived once and kept, because deriving a key from a mnemonic is Ed25519 key
 * expansion and this is on the path of every action of every run. Keyed on the
 * mnemonic it came from so a value changed in the dashboard re-derives rather
 * than signing with the old account until something evicts the module.
 */
let cached = null;
let cachedFrom = '';

/**
 * The account, or null. Never throws: every caller here answers "no automatic
 * payment, and here is why" rather than failing a request, because a payment
 * problem must never be the reason an answer does not arrive.
 */
export function clientAccount() {
  const mnemonic = clientMnemonic();
  if (!mnemonic) return null;

  if (cached && cachedFrom === mnemonic) return cached;

  try {
    const account = algosdk.mnemonicToSecretKey(mnemonic);
    cached = { address: account.addr.toString(), sk: account.sk };
    cachedFrom = mnemonic;
    return cached;
  } catch {
    // A malformed mnemonic is a configuration mistake, not a request failure.
    // `autoSignProblem` turns it into a sentence somebody can act on.
    cached = null;
    cachedFrom = '';
    return null;
  }
}

/**
 * An account from a mnemonic the CALLER supplied, rather than the environment.
 *
 * This is the "pay from my own account instead" road, and it is the reason the
 * env account is described everywhere as a fallback: a request carrying a
 * mnemonic pays from that one, a request without carries on paying from ours.
 *
 * WHAT THIS COSTS, PLAINLY, because it is the part nobody should discover
 * later. The phrase arrives over the wire. For the length of one request this
 * process can spend everything in that account, and anything able to read the
 * request — a proxy, a log line, a crash dump — can spend it forever. So:
 *
 *   - it is NEVER written to the database, and there is no column for it;
 *   - it is NEVER logged, which is why nothing here echoes the body and why
 *     `handler` logs the error rather than the request;
 *   - it is NEVER put in the on-chain note, which `noteFor` builds from a
 *     fixed set of fields;
 *   - it is NEVER returned, not even partially. The only thing that goes back
 *     is the derived public address, which is public the moment it pays.
 *   - it is NOT cached between requests. `cached` above is keyed on the
 *     environment's value and this road does not touch it, so one caller's
 *     phrase can never be reused for another caller's payment.
 *
 * Returns null for anything that is not a valid mnemonic, and the caller turns
 * that into a refusal rather than quietly falling back to the house account —
 * paying from the wrong account is not a reasonable recovery from a typo.
 */
export function accountFrom(mnemonic) {
  const phrase = String(mnemonic || '').trim().replace(/\s+/g, ' ');
  if (!phrase) return null;

  try {
    const account = algosdk.mnemonicToSecretKey(phrase);
    return { address: account.addr.toString(), sk: account.sk };
  } catch {
    return null;
  }
}

/**
 * Why automatic payment is not available, or '' when it is.
 *
 * A sentence rather than a code, and returned rather than thrown, because this
 * is read by a diagnostic endpoint and printed in the panel. "Not available" on
 * its own sends someone looking at their wallet, which is the one place the
 * answer is not.
 */
export function autoSignProblem(network) {
  if (!autoSignEnabled()) return 'automatic payment is switched off (X402_AUTOSIGN=0).';

  if (!clientMnemonic()) {
    return (
      'no client account is configured — set CLIENT_MNEMONIC in the site ' +
      'environment to the 25-word mnemonic of a throwaway funded account.'
    );
  }

  if (!clientAccount()) {
    return 'CLIENT_MNEMONIC is not a valid 25-word Algorand mnemonic.';
  }

  if (network === 'mainnet' && !autoSignMainnetAllowed()) {
    return (
      'automatic payment is refused on MainNet unless X402_AUTOSIGN_MAINNET=1. ' +
      'A key that signs with no confirmation is spending real ALGO, and that ' +
      'has to be said out loud rather than inherited from a TestNet setup.'
    );
  }

  return '';
}

/** Whether an unattended payment on this network will be signed. */
export const autoSignReady = (network) => autoSignProblem(network) === '';

/**
 * Sign every transaction of every group, in the shape the settle path already
 * takes from a wallet: `[{signed:[base64, …]}, …]`, groups and legs in the
 * order they were built.
 *
 * Order is not cosmetic. A group's id is computed over its members, so a
 * reordered group has a different id and the chain refuses the lot — which is
 * why this maps rather than doing anything cleverer with the arrays.
 *
 * What comes back still goes through `assertMatches` at the call site even
 * though we produced it. Verifying our own bytes looks redundant and is the
 * cheapest possible guard against a signer that silently signed the wrong
 * thing: one road into settlement, checked once, no branch where the check is
 * skipped because the source was trusted.
 */
export function signGroups(groups, account = clientAccount()) {
  if (!account) throw new Error('no client account is configured');

  return groups.map((group) => ({
    signed: group.transactions.map((leg) => {
      const txn = algosdk.decodeUnsignedTransaction(Buffer.from(leg.txn, 'base64'));
      return Buffer.from(algosdk.signTransaction(txn, account.sk).blob).toString('base64');
    })
  }));
}
