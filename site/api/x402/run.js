/**
 * Quote a whole run, and settle it.
 *
 * POST /api/x402/run          { buyer, sessionId, items:[{agentId,label,step}] }  → 402 + groups
 * POST /api/x402/run?settle=1 { buyer, sessionId, groups:[{signed:[…]}] }         → receipt
 * POST /api/x402/run          { autoSign:true, sessionId, items:[…] }             → receipt
 *
 * THE THIRD SHAPE IS THE UNATTENDED ONE, and it collapses the other two into a
 * single call. There is no 402 and no signature comes back over the wire,
 * because the account that pays is the marketplace's own and its key is here —
 * see `_lib/client-wallet.js` for what that costs and why it is bounded to a
 * throwaway TestNet account by default.
 *
 * It is not a second road. It joins the settle path at exactly the point a
 * wallet's signatures would have arrived, and everything past that — the
 * re-derived plan, `assertMatches` on every leg, submit, confirm, and only then
 * the receipt — is the same code. A branch that skipped the verification
 * because the server produced the bytes would be a branch nothing tests, and
 * the first thing to go wrong in it is a payout to the wrong address.
 *
 * Both halves live in one file because they are one contract: `settle` re-plans
 * the run from the SAME database rows the quote read, and the two must not be
 * able to drift. Splitting them across files is how the settle path ends up
 * pricing yesterday's rate.
 *
 * The quote is not remembered between calls. Nothing is stored, no nonce is
 * issued, and settle trusts none of the numbers the client sends: it re-reads
 * the agents, re-derives every leg, and checks the signed bytes against that.
 * A client can therefore send back anything it likes and the worst it achieves
 * is a refusal.
 */
import { handler, body, fail, json, ALGORAND_ADDRESS, safeSessionId } from '../_lib/http.js';
import { sql, feeConfig, activeNetwork } from '../_lib/db.js';
import { toAlgoString } from '../_lib/split.js';
import { planGroups, buildRunGroups } from '../_lib/run-group.js';
import {
  assertMatches,
  submitAndConfirm,
  explorerFor,
  unfundedReceivers
} from '../_lib/algorand.js';
import {
  clientAccount,
  accountFrom,
  autoSignProblem,
  signGroups
} from '../_lib/client-wallet.js';
import { autoSignMainnetAllowed } from '../_lib/config.js';

/** A run longer than this is refused rather than silently truncated. */
const MAX_ITEMS = 120;

/**
 * Price the run from the database.
 *
 * Unknown or paused agent ids are DROPPED, not rejected. A run that used one
 * action nobody registered is not a broken run — that action is simply free,
 * which is the same default the extension applies. Refusing the whole
 * settlement because one verb is unlisted would lose the payment for every
 * other action in it.
 */
async function priceItems(items) {
  const ids = [...new Set(items.map((i) => String(i.agentId || '')))].filter(Boolean);
  if (!ids.length) return { priced: [], skipped: items.length };

  const rows = await sql`
    SELECT a.id, a.name, a.price_micro_algo, d.payout_address
      FROM agents a JOIN developers d ON d.id = a.developer_id
     WHERE a.status = 'live' AND a.id = ANY(${ids})`;

  const byId = new Map(rows.map((r) => [r.id, r]));
  const priced = [];
  let skipped = 0;

  for (const item of items) {
    const row = byId.get(String(item.agentId));
    if (!row) {
      skipped += 1;
      continue;
    }
    priced.push({
      agentId: row.id,
      label: String(item.label || row.name).slice(0, 120),
      step: Number.isInteger(item.step) ? item.step : null,
      /**
       * The caller's ordinal for this payment, and it is what stops two
       * identical actions colliding on chain.
       *
       * It never mattered while a run signed once: every leg was in one group,
       * so every leg had a different group id. Settling per action means each
       * one is built on its own, and two payments with the same sender,
       * receiver, amount, note and validity window are the SAME transaction —
       * same id — so the second is refused as already in the ledger. Two
       * `act-answer` lines in one session are exactly that shape.
       */
      seq: Number.isInteger(item.seq) ? item.seq : null,
      priceMicroAlgo: Number(row.price_micro_algo),
      payoutAddress: row.payout_address
    });
  }

  return { priced, skipped };
}

export default handler('POST', async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const settling = url.searchParams.get('settle') === '1';
  const input = body(req);
  const sessionId = safeSessionId(input.sessionId);
  const network = activeNetwork();

  /**
   * Unattended, or a wallet.
   *
   * When it is unattended the `buyer` field is IGNORED rather than trusted.
   * Honouring it would have the server build a group from someone else's
   * address and then try to sign it with a key that does not own it — which
   * fails deep inside submission with a message about a signature, several
   * layers away from the caller who named the wrong account.
   */
  const auto = input.autoSign === true || url.searchParams.get('auto') === '1';
  let buyer;

  /**
   * Whose account pays. The caller's own if they sent a phrase, ours if not —
   * which is the whole of what "the site account is a fallback" means.
   *
   * A phrase that does not parse is REFUSED rather than falling back to the
   * house account. Somebody who has said "pay from this account" and mistyped
   * it must not silently have the marketplace's account charged instead: that
   * is money moving from a place they did not choose, reported as success.
   *
   * Never logged, never stored, never returned. See `accountFrom`.
   */
  let signer = null;

  if (auto) {
    if (input.signer) {
      signer = accountFrom(input.signer);
      if (!signer) {
        return fail(
          res,
          400,
          'invalid_signer',
          'That is not a valid 25-word Algorand mnemonic. Nothing was charged.'
        );
      }
      if (network === 'mainnet' && !autoSignMainnetAllowed()) {
        return fail(res, 503, 'autosign_unavailable', autoSignProblem(network));
      }
      buyer = signer.address;
    } else {
      const problem = autoSignProblem(network);
      if (problem) {
        // 503 rather than 400: nothing about the request is wrong, the deploy
        // is simply not set up to pay for itself. The panel reports it as a
        // decline and the answer it belongs to is already on screen.
        return fail(res, 503, 'autosign_unavailable', problem);
      }
      buyer = clientAccount().address;
    }
  } else {
    buyer = String(input.buyer || '').trim();
    if (!ALGORAND_ADDRESS.test(buyer)) {
      return fail(res, 400, 'invalid_buyer', 'buyer must be a valid Algorand address.');
    }
  }

  const items = Array.isArray(input.items) ? input.items : [];
  if (!items.length) return fail(res, 400, 'no_items', 'items must be a non-empty array.');
  if (items.length > MAX_ITEMS) {
    return fail(res, 400, 'too_many_items', `A run may bill at most ${MAX_ITEMS} actions.`);
  }

  const { priced, skipped } = await priceItems(items);
  if (!priced.length) {
    return fail(res, 404, 'nothing_billable', 'None of those actions is a registered agent.');
  }

  const company = feeConfig();
  const plan = planGroups(priced, company.bps);

  const groups = await buildRunGroups({
    network,
    buyer,
    groups: plan,
    companyAddress: company.address,
    sessionId
  });

  const total = plan.reduce((n, g) => n + g.total, 0);
  const developerTotal = plan.reduce((n, g) => n + g.developerTotal, 0);
  const companyTotal = plan.reduce((n, g) => n + g.companyTotal, 0);
  // One network fee per transaction, and the buyer pays every one of them.
  const networkFee = groups.reduce((n, g) => n + g.transactions.length * 1000, 0);

  /**
   * Checked before anything is signed, not after — and now on both roads.
   *
   * The chain's own refusal for this arrives once the payment has already been
   * approved, says "below min balance", names no address, and is
   * indistinguishable from the buyer being broke. Reporting it here names the
   * account and the amount it needs. Unattended it matters MORE, not less: with
   * nobody reading a wallet prompt the only visible symptom is a run that
   * quietly produces no receipts.
   */
  async function unfundedProblem() {
    const incoming = {};
    for (const g of groups) {
      for (const tx of g.transactions) {
        incoming[tx.receiver] = (incoming[tx.receiver] || 0) + tx.amount;
      }
    }
    const unfunded = await unfundedReceivers(network, Object.keys(incoming), incoming);
    if (!unfunded.length) return '';

    return unfunded
      .map(
        (u) =>
          `${u.address} has never been funded, and Algorand will not let it ` +
          `receive ${toAlgoString(u.arriving)} ALGO — an account must hold at ` +
          `least ${toAlgoString(u.needs)} ALGO. Send it 0.1 ALGO once, then this works.`
      )
      .join(' ');
  }

  if (!settling && !auto) {
    const problem = await unfundedProblem();
    if (problem) return fail(res, 409, 'receiver_unfunded', problem);

    return json(res, 402, {
      x402Version: 1,
      error: 'payment_required',
      accepts: [
        {
          scheme: 'exact',
          network: `algorand-${network}`,
          maxAmountRequired: String(total),
          resource: `run:${sessionId || 'anonymous'}`,
          description: `${priced.length} agent actions`,
          mimeType: 'application/json',
          payTo: priced[0].payoutAddress,
          maxTimeoutSeconds: 300,
          asset: 'ALGO',
          outputSchema: null,
          extra: {
            from: buyer,
            actions: priced.length,
            unpricedActions: skipped,
            totals: {
              totalMicroAlgo: total,
              totalAlgo: toAlgoString(total),
              developerMicroAlgo: developerTotal,
              developerAlgo: toAlgoString(developerTotal),
              companyMicroAlgo: companyTotal,
              companyAlgo: toAlgoString(companyTotal),
              companyBps: company.bps,
              networkFeeMicroAlgo: networkFee,
              networkFeeAlgo: toAlgoString(networkFee),
              buyerPaysMicroAlgo: total + networkFee,
              buyerPaysAlgo: toAlgoString(total + networkFee)
            },
            companyAddress: company.address,
            groups
          }
        }
      ]
    });
  }

  /* ── settle ────────────────────────────────────────────────────────────── */

  /**
   * The signatures, from whichever side holds the key.
   *
   * Unattended they are produced here, a line above the verification that then
   * checks them — which is the point. There is no path into submission that
   * skips `assertMatches`, so a signer that signed the wrong bytes is caught by
   * the same guard that catches a client trying to pay itself.
   */
  let returned;

  if (auto) {
    const problem = await unfundedProblem();
    if (problem) return fail(res, 409, 'receiver_unfunded', problem);

    try {
      returned = signGroups(groups, signer || clientAccount());
    } catch (error) {
      return fail(res, 503, 'autosign_failed', String(error?.message || error));
    }
  } else {
    returned = Array.isArray(input.groups) ? input.groups : [];
    if (returned.length !== groups.length) {
      return fail(
        res,
        400,
        'group_count_mismatch',
        `This run needs ${groups.length} signed group(s); ${returned.length} were sent.`
      );
    }
  }

  const settled = [];

  for (const [gi, group] of groups.entries()) {
    const signed = returned[gi]?.signed;
    if (!Array.isArray(signed) || signed.length !== group.transactions.length) {
      return fail(
        res,
        400,
        'group_size_mismatch',
        `Group ${gi + 1} needs ${group.transactions.length} transactions.`
      );
    }

    // Every leg re-checked against the plan this request just derived. Without
    // it a client could sign a transfer to itself and have the server record a
    // payout that never happened.
    try {
      group.transactions.forEach((leg, i) =>
        assertMatches(signed[i], { role: leg.role, receiver: leg.receiver, amount: leg.amount, buyer })
      );
    } catch (error) {
      return fail(res, 400, error.code || 'signature_mismatch', error.message);
    }

    try {
      const confirmation = await submitAndConfirm(network, signed);
      settled.push({ group, confirmation });
    } catch (error) {
      const message = String(error?.message || error);
      const code = /overspend|underflow|insufficient/i.test(message)
        ? 'insufficient_funds'
        : /already in ledger|duplicate/i.test(message)
          ? 'already_settled'
          : 'submit_failed';
      // Groups already submitted stay submitted — they are on chain and cannot
      // be recalled. Reporting how far it got is the honest answer.
      return fail(
        res,
        402,
        code,
        `${message} (${settled.length} of ${groups.length} group(s) had already settled)`
      );
    }
  }

  // One receipt per group, with a line item per action inside it.
  const receiptIds = [];
  const lines = [];

  for (const { group, confirmation } of settled) {
    const actions = group.transactions.filter((t) => t.role === 'action');
    const companyLeg = group.transactions.find((t) => t.role === 'company');

    const [receipt] = await sql`
      INSERT INTO receipts (
        agent_id, buyer_address, developer_address, company_address,
        total_micro_algo, developer_micro_algo, company_micro_algo, company_bps,
        network_fee_micro_algo, group_id, developer_txid, company_txid,
        confirmed_round, network, tool_label, session_id
      ) VALUES (
        ${actions[0].agentId}, ${buyer}, ${actions[0].receiver},
        ${companyLeg ? company.address : null},
        ${group.total}, ${group.developerTotal}, ${group.companyTotal}, ${company.bps},
        ${group.transactions.length * 1000}, ${group.groupId}, ${actions[0].txid},
        ${companyLeg?.txid || null}, ${confirmation.confirmedRound}, ${network},
        ${`${actions.length} agent actions`}, ${sessionId || null}
      )
      ON CONFLICT (developer_txid) DO NOTHING
      RETURNING id`;

    const [row] = receipt
      ? [receipt]
      : await sql`SELECT id FROM receipts WHERE developer_txid = ${actions[0].txid}`;

    receiptIds.push(Number(row.id));

    for (const action of actions) {
      await sql`
        INSERT INTO receipt_items (receipt_id, agent_id, action_label, step_index, micro_algo, txid)
        VALUES (${row.id}, ${action.agentId}, ${action.label}, ${action.step},
                ${action.amount}, ${action.txid})
        ON CONFLICT (txid) DO NOTHING`;

      lines.push({
        agentId: action.agentId,
        label: action.label,
        step: action.step,
        to: action.receiver,
        microAlgo: action.amount,
        algo: toAlgoString(action.amount),
        txid: action.txid,
        explorer: explorerFor(network, action.txid)
      });
    }

    if (companyLeg) {
      lines.push({
        agentId: null,
        label: `Marketplace ${(company.bps / 100).toFixed(0)}%`,
        step: null,
        to: companyLeg.receiver,
        microAlgo: companyLeg.amount,
        algo: toAlgoString(companyLeg.amount),
        txid: companyLeg.txid,
        explorer: explorerFor(network, companyLeg.txid)
      });
    }
  }

  return json(res, 200, {
    settled: true,
    from: buyer,
    network,
    receiptIds,
    groups: settled.map(({ group, confirmation }) => ({
      groupId: group.groupId,
      confirmedRound: confirmation.confirmedRound,
      transactions: group.transactions.length
    })),
    totals: {
      actions: priced.length,
      unpricedActions: skipped,
      totalMicroAlgo: total,
      totalAlgo: toAlgoString(total),
      developerMicroAlgo: developerTotal,
      developerAlgo: toAlgoString(developerTotal),
      companyMicroAlgo: companyTotal,
      companyAlgo: toAlgoString(companyTotal),
      networkFeeMicroAlgo: networkFee,
      networkFeeAlgo: toAlgoString(networkFee),
      spentMicroAlgo: total + networkFee,
      spentAlgo: toAlgoString(total + networkFee)
    },
    // The per-action list, which is the whole reason a run has one leg each.
    lines
  });
});
