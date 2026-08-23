/**
 * The fee history, printed under a finished answer.
 *
 * What a person actually asks looking at this is one question in three parts:
 * *which tool got paid, how much, and can I check it?* So every row carries the
 * tool's own label, the amount in ALGO, the address it went to, and a link to a
 * public explorer that has nothing to do with us. The last of those is the
 * point — a receipt you can only verify by trusting the thing that issued it is
 * not a receipt.
 *
 * Built with the DOM and never with innerHTML. A tool label comes from a
 * developer's registration and an address comes off the wire; both are content
 * we do not control, and this is the one surface in the panel where getting
 * that wrong would put attacker-controlled markup next to a wallet address.
 *
 * It renders only when there is something to render. A chat where nothing was
 * charged shows nothing at all — an empty "fees: none" block under every answer
 * is noise, and it trains people to stop reading the place the real numbers
 * appear.
 */

import { receiptsFor, totalsOf, toAlgo } from '../payments/ledger.js';
import { ellipseAddress } from './wallet.js';

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

/**
 * One payment leg: what it was for, where it went, and its transaction.
 *
 * Every leg is drawn separately rather than as a total with a percentage beside
 * it. A percentage is a claim about a calculation; a list of amounts that
 * visibly adds up to the total IS the calculation, and this is the block whose
 * whole job is being checkable.
 */
function legRow(label, { address, microAlgo, txid, explorer }) {
  const item = el('li', 'receipt-leg');
  item.append(el('span', 'receipt-leg-label', label));

  const to = el('span', 'receipt-address', ellipseAddress(address, 6, 4));
  to.title = address;
  item.append(to);

  item.append(el('span', 'receipt-leg-amount', `${toAlgo(microAlgo)} ALGO`));

  if (explorer) {
    const link = el('a', 'receipt-txid', 'view');
    link.href = explorer;
    link.target = '_blank';
    link.rel = 'noreferrer';
    // The full transaction id, for anyone who wants to paste it elsewhere.
    link.title = txid || '';
    item.append(link);
  }

  return item;
}

function receiptRow(receipt) {
  const row = el('li', 'receipt');

  const head = el('div', 'receipt-head');
  head.append(el('span', 'receipt-tool', receipt.toolLabel || receipt.agentId));
  head.append(el('span', 'receipt-total', `${toAlgo(receipt.total?.microAlgo)} ALGO`));
  row.append(head);

  /**
   * Who paid. Shown on a run receipt and not on a skill one, because a run
   * settles a batch minutes after the wallet was last visible and "which
   * account did that leave from" stops being obvious.
   */
  if (receipt.from) {
    const from = el('div', 'receipt-from');
    from.append(el('span', 'receipt-leg-label', 'From'));
    const address = el('span', 'receipt-address', ellipseAddress(receipt.from, 6, 4));
    address.title = receipt.from;
    from.append(address);
    row.append(from);
  }

  const legs = el('ul', 'receipt-legs');

  if (receipt.lines?.length) {
    /**
     * A run: one line per action, each with its own transaction.
     *
     * This is the whole reason a run pays with a leg per action rather than one
     * lump sum — every line here is independently checkable, and the step index
     * ties it back to the step in the timeline the user watched happen.
     */
    for (const line of receipt.lines) {
      const label = line.step == null ? line.label : `${line.step}. ${line.label}`;
      legs.append(legRow(label, { address: line.to, microAlgo: line.microAlgo, txid: line.txid, explorer: line.explorer }));
    }
  } else {
    // A skill purchase: two legs, the developer and the marketplace.
    if (receipt.developer) legs.append(legRow('Developer', receipt.developer));
    if (receipt.company) {
      legs.append(
        legRow(`Marketplace ${(receipt.company.bps / 100).toFixed(0)}%`, receipt.company)
      );
    }
  }

  row.append(legs);

  // The network fee is the protocol's, not either party's, so it is stated
  // apart from the split rather than folded into a total that would then not
  // match the two lines above it.
  if (receipt.networkFee?.microAlgo) {
    row.append(
      el('div', 'receipt-fee', `network fee ${toAlgo(receipt.networkFee.microAlgo)} ALGO`)
    );
  }

  return row;
}

/**
 * Build the block for one conversation, or null when nothing was charged.
 *
 * Returning null rather than an empty node is what lets the caller decide
 * placement without having to know whether there is anything to place.
 */
export async function buildReceiptBlock(sessionId) {
  const receipts = await receiptsFor(sessionId);
  if (!receipts.length) return null;

  const totals = totalsOf(receipts);

  const block = el('section', 'receipts');
  block.setAttribute('aria-label', 'Fees paid in this conversation');

  const header = el('div', 'receipts-head');
  header.append(
    el('span', 'receipts-title', `Fees · ${totals.actions} ${totals.actions === 1 ? 'action' : 'actions'}`)
  );
  header.append(el('span', 'receipts-total', `${toAlgo(totals.spentMicroAlgo)} ALGO`));
  block.append(header);

  const list = el('ul', 'receipt-list');
  for (const receipt of receipts) list.append(receiptRow(receipt));
  block.append(list);

  const footer = el('div', 'receipts-foot');
  footer.append(
    el(
      'span',
      'receipts-split',
      `${toAlgo(totals.developerMicroAlgo)} to developers · ` +
        `${toAlgo(totals.companyMicroAlgo)} to the marketplace · ` +
        `${toAlgo(totals.networkFeeMicroAlgo)} network`
    )
  );
  block.append(footer);

  return block;
}

/**
 * Put the block at the end of the thread, replacing any earlier copy.
 *
 * Replacing rather than appending matters because the thread re-renders on
 * every streamed delta and on every provider switch: appending would stack a
 * new copy of the fee history under the last one several times a second.
 */
export async function renderReceipts(container, sessionId) {
  if (!container) return;

  container.querySelector(':scope > .receipts')?.remove();

  const block = await buildReceiptBlock(sessionId);
  if (block) container.append(block);
}
