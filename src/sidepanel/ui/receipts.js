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
 * One payment.
 *
 * The developer's share and the marketplace's are shown as separate lines
 * rather than as one total with a percentage beside it. A percentage is a claim
 * about a calculation; two amounts that visibly add up to the total are the
 * calculation itself, and this is the block whose whole job is being checkable.
 */
function receiptRow(receipt) {
  const row = el('li', 'receipt');

  const head = el('div', 'receipt-head');
  head.append(el('span', 'receipt-tool', receipt.toolLabel || receipt.agentId));
  head.append(el('span', 'receipt-total', `${toAlgo(receipt.total?.microAlgo)} ALGO`));
  row.append(head);

  const legs = el('ul', 'receipt-legs');

  const leg = (label, share) => {
    if (!share) return;
    const item = el('li', 'receipt-leg');
    item.append(el('span', 'receipt-leg-label', label));

    const address = el('span', 'receipt-address', ellipseAddress(share.address, 6, 4));
    address.title = share.address;
    item.append(address);

    item.append(el('span', 'receipt-leg-amount', `${toAlgo(share.microAlgo)} ALGO`));

    if (share.explorer) {
      const link = el('a', 'receipt-txid', 'view');
      link.href = share.explorer;
      link.target = '_blank';
      link.rel = 'noreferrer';
      // The full transaction id, for anyone who wants to paste it elsewhere.
      link.title = share.txid || '';
      item.append(link);
    }

    legs.append(item);
  };

  leg('Developer', receipt.developer);
  leg(
    receipt.company ? `Marketplace ${(receipt.company.bps / 100).toFixed(0)}%` : 'Marketplace',
    receipt.company
  );

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
    el('span', 'receipts-title', `Fees · ${totals.calls} ${totals.calls === 1 ? 'call' : 'calls'}`)
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
