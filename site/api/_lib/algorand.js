/**
 * Building and settling the payment itself.
 *
 * The buyer's fee reaches two addresses — the developer who published the agent
 * and the company that runs the marketplace — and it reaches them as ONE
 * ATOMIC GROUP. That is the whole reason this is on Algorand rather than being
 * two sequential transfers: a group either lands entirely or not at all, so
 * there is no state in which the developer has been paid and the company has
 * not, or the reverse. A receipt therefore describes one event, and `group_id`
 * is the id of that event.
 *
 * The extension cannot do any of this. It has no bundler and no dependencies —
 * `AGENTS.md` is explicit — so it cannot carry algosdk, and hand-rolling
 * msgpack, base32 and SHA-512/256 in a content script to move real money is not
 * a trade worth making. It signs what this file builds.
 *
 * That split is also what makes the fee honest: the percentage and the company
 * address are the two values a client would have every reason to rewrite, and
 * the client never supplies either. It receives a group and signs it, and
 * `assertMatches` re-checks the signed bytes against the quote before anything
 * is submitted.
 */
import algosdk from 'algosdk';
import { required } from './http.js';

/**
 * Public algod endpoints. AlgoNode needs no token, which is why it is the
 * default — an API key in the deploy is one more thing to rotate, and this
 * traffic is a handful of transactions a minute.
 */
const ALGOD = {
  testnet: 'https://testnet-api.algonode.cloud',
  mainnet: 'https://mainnet-api.algonode.cloud',
  localnet: 'http://localhost:4001'
};

const EXPLORER = {
  testnet: 'https://lora.algokit.io/testnet/transaction/',
  mainnet: 'https://lora.algokit.io/mainnet/transaction/',
  localnet: 'https://lora.algokit.io/localnet/transaction/'
};

export function algodFor(network) {
  const url = process.env.ALGOD_URL || ALGOD[network];
  if (!url) throw new Error(`no algod endpoint for network ${network}`);
  return new algosdk.Algodv2(process.env.ALGOD_TOKEN || '', url, '');
}

export const explorerFor = (network, txid) =>
  `${EXPLORER[network] || EXPLORER.testnet}${txid}`;

/**
 * Build the unsigned group the buyer is asked to sign.
 *
 * The note field carries the agent id and the session, so the payment is
 * self-describing ON CHAIN. Someone auditing this later should not need our
 * database to know what a transfer bought — that is the difference between a
 * receipt and a bank statement.
 *
 * A zero company share produces a ONE transaction group, not a two transaction
 * group with a zero leg: Algorand would accept the zero payment, but it would
 * cost a second 1000 microALGO fee to move nothing.
 */
export async function buildPaymentGroup({
  network,
  buyer,
  developerAddress,
  companyAddress,
  split,
  agentId,
  sessionId
}) {
  const algod = algodFor(network);
  const params = await algod.getTransactionParams().do();

  const note = new TextEncoder().encode(
    JSON.stringify({ x402: 1, agent: agentId, session: sessionId || null })
  );

  const legs = [
    {
      role: 'developer',
      txn: algosdk.makePaymentTxnWithSuggestedParamsFromObject({
        sender: buyer,
        receiver: developerAddress,
        amount: split.developer,
        note,
        suggestedParams: params
      })
    }
  ];

  if (split.company > 0) {
    legs.push({
      role: 'company',
      txn: algosdk.makePaymentTxnWithSuggestedParamsFromObject({
        sender: buyer,
        receiver: companyAddress,
        amount: split.company,
        note,
        suggestedParams: params
      })
    });
  }

  // Only a multi-transaction group needs a group id. Assigning one to a single
  // transaction is legal but makes it unsubmittable on its own.
  if (legs.length > 1) {
    algosdk.assignGroupID(legs.map((l) => l.txn));
  }

  return {
    groupId: legs.length > 1 ? Buffer.from(legs[0].txn.group).toString('base64') : null,
    // ARC-0001: wallets take base64 msgpack of the UNSIGNED transaction.
    transactions: legs.map((leg) => ({
      role: leg.role,
      txid: leg.txn.txID(),
      receiver: algosdk.encodeAddress(leg.txn.payment.receiver.publicKey),
      amount: Number(leg.txn.payment.amount),
      txn: Buffer.from(algosdk.encodeUnsignedTransaction(leg.txn)).toString('base64')
    }))
  };
}

/**
 * Re-derive what was signed and check it against what was quoted.
 *
 * This is the step that makes the whole flow trustworthy, and skipping it would
 * not show up in testing: a client can sign ANY transaction and post it here,
 * and without this the server would submit it, see it confirm, and write a
 * receipt claiming the developer was paid when the money went somewhere else
 * entirely. Every field that decides where value goes is checked — sender,
 * receiver, amount — and a mismatch is refused rather than corrected.
 */
export function assertMatches(signedBase64, expected) {
  const decoded = algosdk.decodeSignedTransaction(Buffer.from(signedBase64, 'base64'));
  const txn = decoded.txn;

  if (txn.type !== 'pay') {
    throw Object.assign(new Error('only payment transactions are settled here'), {
      code: 'not_a_payment'
    });
  }

  const sender = algosdk.encodeAddress(txn.sender.publicKey);
  const receiver = algosdk.encodeAddress(txn.payment.receiver.publicKey);
  const amount = Number(txn.payment.amount);

  if (sender !== expected.buyer) {
    throw Object.assign(new Error('the signed transaction is from a different account'), {
      code: 'sender_mismatch'
    });
  }
  if (receiver !== expected.receiver) {
    throw Object.assign(
      new Error(`the ${expected.role} leg pays ${receiver}, not ${expected.receiver}`),
      { code: 'receiver_mismatch' }
    );
  }
  if (amount !== expected.amount) {
    throw Object.assign(
      new Error(`the ${expected.role} leg pays ${amount}, not the quoted ${expected.amount}`),
      { code: 'amount_mismatch' }
    );
  }

  return { txid: txn.txID(), sender, receiver, amount };
}

/**
 * Submit and wait for the chain to confirm.
 *
 * Nothing is written to the database until this returns a round number: a
 * receipt means the money moved, and the round is the independently checkable
 * proof of it. Eight rounds is roughly 25 seconds on Algorand, comfortably past
 * the ~3s block time without hanging a serverless function.
 */
export async function submitAndConfirm(network, signedBase64List, waitRounds = 8) {
  const algod = algodFor(network);
  const blobs = signedBase64List.map((b64) => Buffer.from(b64, 'base64'));

  const { txid } = await algod.sendRawTransaction(blobs).do();
  const confirmed = await algosdk.waitForConfirmation(algod, txid, waitRounds);

  return {
    txid,
    confirmedRound: Number(confirmed.confirmedRound ?? confirmed['confirmed-round'])
  };
}

export { algosdk };
