/**
 * Turning a finished run into transaction groups.
 *
 * The shape is forced by two facts that pull in opposite directions.
 *
 *   A run is thirty actions, and a wallet prompt per action is unusable. So a
 *   run signs ONCE.
 *
 *   But "one signature" must not collapse into "one payment". The entire claim
 *   of this marketplace is that a charge reconciles against the work behind it,
 *   and a single lump sum with a percentage beside it is exactly the claim it
 *   is meant to replace. So every action gets its OWN payment leg and therefore
 *   its own transaction id, independently checkable on a public explorer.
 *
 * Algorand caps an atomic group at 16 transactions, which is what forces
 * chunking: 15 action legs plus one company leg per group. A wallet signs all
 * the groups in one call (ARC-0001 takes a flat array), and each group is
 * submitted separately because a group is the unit the chain accepts.
 *
 * The company share is ONE leg per group rather than one per action. It is the
 * same recipient every time, so a leg per action would spend a 1000 microALGO
 * network fee to split a payment that lands in one place anyway — and at these
 * prices that fee is the whole ticket.
 */
import algosdk from 'algosdk';
import { algodFor } from './algorand.js';
import { splitFee } from './split.js';

/** Algorand's own limit. 15 actions + 1 company leg. */
export const MAX_GROUP_SIZE = 16;
export const MAX_ACTIONS_PER_GROUP = MAX_GROUP_SIZE - 1;

/**
 * Split a run's items into groups, and price each one.
 *
 * Every item is priced independently and the shares are summed rather than the
 * total being split once. Those are the same number today, when every action
 * costs the same — and they stop being the same the moment two agents have
 * different prices or different owners, at which point summing per item is
 * still right and splitting the total is quietly wrong.
 */
/**
 * The on-chain note, and it STARTS with the protocol.
 *
 * It used to be bare JSON — `{"x402":1,"agent":"act-navigate",…}` — which
 * carries the same information and reads as nothing in particular. An
 * explorer shows the note as UTF-8 text, so what someone actually sees when
 * they open a transaction is its first few characters, and `{"x402":1` buried
 * behind a brace is not a label. Leading with `x402/1` makes every payment
 * this protocol produces identifiable at a glance, by anyone, without our
 * database — which is the whole claim the receipt makes.
 *
 * A prefix and then JSON, rather than a bespoke encoding, so it stays
 * machine-readable: split on the first space and parse the rest.
 *
 * Algorand caps a note at 1024 bytes. Nothing here approaches that — the
 * label is bounded by `MAX_LABEL` at the call site — but it is asserted
 * rather than assumed, because an over-long note is rejected by the network
 * and would take the whole atomic group down with it.
 */
const NOTE_PREFIX = 'x402/1 ';
const MAX_NOTE_BYTES = 1024;

function noteFor(payload) {
  const text = NOTE_PREFIX + JSON.stringify(payload);
  const bytes = new TextEncoder().encode(text);
  return bytes.length <= MAX_NOTE_BYTES
    ? bytes
    : new TextEncoder().encode(NOTE_PREFIX + JSON.stringify({ session: payload.session ?? null }));
}

export function planGroups(items, companyBps) {
  const chunks = [];
  for (let i = 0; i < items.length; i += MAX_ACTIONS_PER_GROUP) {
    chunks.push(items.slice(i, i + MAX_ACTIONS_PER_GROUP));
  }

  return chunks.map((chunk) => {
    const legs = chunk.map((item) => {
      const split = splitFee(item.priceMicroAlgo, companyBps);
      return { ...item, developerMicroAlgo: split.developer, companyMicroAlgo: split.company };
    });

    return {
      legs,
      developerTotal: legs.reduce((n, l) => n + l.developerMicroAlgo, 0),
      companyTotal: legs.reduce((n, l) => n + l.companyMicroAlgo, 0),
      total: legs.reduce((n, l) => n + l.priceMicroAlgo, 0)
    };
  });
}

/**
 * Build the unsigned groups.
 *
 * Each action leg carries a note naming the action and the step, so the payment
 * is self-describing ON CHAIN. Someone auditing a run later should be able to
 * read what a transfer bought without our database — that is the difference
 * between a receipt and a bank statement.
 */
export async function buildRunGroups({ network, buyer, groups, companyAddress, sessionId }) {
  const algod = algodFor(network);
  const params = await algod.getTransactionParams().do();

  return groups.map((group) => {
    const txns = [];
    const meta = [];

    for (const leg of group.legs) {
      const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
        sender: buyer,
        receiver: leg.payoutAddress,
        amount: leg.developerMicroAlgo,
        note: noteFor({
          agent: leg.agentId,
          label: leg.label,
          step: leg.step ?? null,
          session: sessionId || null
        }),
        suggestedParams: params
      });
      txns.push(txn);
      meta.push({
        role: 'action',
        agentId: leg.agentId,
        label: leg.label,
        step: leg.step ?? null,
        receiver: leg.payoutAddress,
        amount: leg.developerMicroAlgo,
        priceMicroAlgo: leg.priceMicroAlgo
      });
    }

    if (group.companyTotal > 0) {
      const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
        sender: buyer,
        receiver: companyAddress,
        amount: group.companyTotal,
        note: noteFor({ role: 'marketplace', session: sessionId || null }),
        suggestedParams: params
      });
      txns.push(txn);
      meta.push({
        role: 'company',
        receiver: companyAddress,
        amount: group.companyTotal
      });
    }

    // A single transaction must NOT carry a group id — it is legal but makes it
    // unsubmittable on its own.
    if (txns.length > 1) algosdk.assignGroupID(txns);

    return {
      groupId: txns.length > 1 ? Buffer.from(txns[0].group).toString('base64') : null,
      total: group.total,
      developerTotal: group.developerTotal,
      companyTotal: group.companyTotal,
      transactions: txns.map((txn, i) => ({
        ...meta[i],
        txid: txn.txID(),
        txn: Buffer.from(algosdk.encodeUnsignedTransaction(txn)).toString('base64')
      }))
    };
  });
}
