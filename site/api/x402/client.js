/**
 * Who pays, when nobody is asked to.
 *
 * GET /api/x402/client → { autoSign, address, network, balance, funded, reason }
 *
 * The extension asks this once at boot and it decides which of two roads the
 * whole payments layer takes: an address here means every action settles by
 * itself and no wallet is ever prompted, nothing here means the panel falls
 * back to asking the user's own wallet exactly as it always did.
 *
 * WHY THE PANEL DOES NOT JUST TRY AND SEE. A failed attempt costs a round trip
 * per action and, worse, is indistinguishable from every other decline — "not
 * charged" with no way to tell an unconfigured deploy from a wallet on the
 * wrong chain. Asking once means the panel can SAY which road it is on, which
 * is the same reason `probe()` exists next to `session()` in the direct
 * transport: a diagnostic that infers its answer from a failure eventually
 * disagrees with reality.
 *
 * WHAT IT DELIBERATELY DOES NOT RETURN: the mnemonic, or anything derived from
 * it beyond the public address. The address is public the moment the account
 * pays anybody; the seed is total control of it and is never sent anywhere.
 * There is no endpoint here that hands it out, and adding one would make every
 * copy of the extension a copy of the key.
 *
 * The balance rides along because it is the thing that actually goes wrong.
 * An unfunded client account fails at submission with "overspend", which
 * arrives per action, says nothing about which account, and reads exactly like
 * a bug in the billing code.
 */
import { handler, json } from '../_lib/http.js';
import { activeNetwork } from '../_lib/db.js';
import { clientAccount, autoSignProblem } from '../_lib/client-wallet.js';
import { algodFor, MIN_BALANCE } from '../_lib/algorand.js';
import { toAlgoString } from '../_lib/split.js';

export default handler('GET', async (req, res) => {
  const network = activeNetwork();
  const reason = autoSignProblem(network);

  if (reason) {
    // Not an error. "Nobody signs automatically here" is a valid configuration
    // and the panel's fallback is the wallet, which works.
    return json(res, 200, { autoSign: false, address: null, network, reason });
  }

  const account = clientAccount();

  /**
   * A courtesy read, and its failure is not the request's failure. An algod
   * hiccup must not make a working client account report as unavailable — the
   * payment would have gone through, and reporting otherwise sends someone to
   * fix a wallet that is fine.
   */
  let balance = null;
  try {
    const info = await algodFor(network).accountInformation(account.address).do();
    balance = Number(info.amount);
  } catch {
    balance = null;
  }

  return json(res, 200, {
    autoSign: true,
    address: account.address,
    network,
    reason: '',
    balance:
      balance === null
        ? null
        : { microAlgo: balance, algo: toAlgoString(balance) },
    // Below the minimum balance nothing can be sent at all, so it is worth
    // naming here rather than letting every action fail with "overspend".
    funded: balance === null ? null : balance > MIN_BALANCE
  });
});
