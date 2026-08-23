/**
 * Verify what was signed, submit it, and write the receipt.
 *
 * POST /api/x402/settle
 *   { agentId, buyer, sessionId?, toolLabel?, signed: [base64, …] }
 *
 * The order here is the whole of the correctness and it is not the obvious one.
 *
 *   1. RE-QUOTE from the database. The client's idea of the price is never
 *      trusted — it is not even read. If the developer changed their price
 *      between the quote and the signature, the signature will not match and
 *      the payment is refused rather than settled at a stale number.
 *   2. VERIFY every signed leg against that quote. A client can sign anything;
 *      without this the server would happily submit a transfer to the client's
 *      own address and then write a receipt saying the developer was paid.
 *   3. SUBMIT and wait for a confirmed round.
 *   4. ONLY THEN write the receipt. A row in `receipts` means the money moved.
 *      There is no pending state that later turns real, because a receipt that
 *      might not be true is worse than no receipt.
 */
import { handler, body, fail, json, ALGORAND_ADDRESS } from '../_lib/http.js';
import { sql, liveAgent, feeConfig, activeNetwork } from '../_lib/db.js';
import { splitFee, toAlgoString } from '../_lib/split.js';
import { assertMatches, submitAndConfirm, explorerFor } from '../_lib/algorand.js';

export default handler('POST', async (req, res) => {
  const { agentId, buyer, sessionId, toolLabel, signed } = body(req);

  if (!ALGORAND_ADDRESS.test(String(buyer || '').trim())) {
    return fail(res, 400, 'invalid_buyer', 'buyer must be a valid Algorand address.');
  }
  if (!Array.isArray(signed) || !signed.length || !signed.every((s) => typeof s === 'string')) {
    return fail(res, 400, 'invalid_payload', 'signed must be a non-empty array of base64 strings.');
  }

  const agent = await liveAgent(String(agentId || '').trim());
  if (!agent) {
    return fail(res, 404, 'agent_not_listed', `No live agent is registered as "${agentId}".`);
  }

  const company = feeConfig();
  const network = activeNetwork();
  const split = splitFee(Number(agent.price_micro_algo), company.bps);

  // What the legs MUST be, derived here and now — never taken from the request.
  const expected = [
    {
      role: 'developer',
      receiver: agent.payout_address,
      amount: split.developer,
      buyer
    }
  ];
  if (split.company > 0) {
    expected.push({
      role: 'company',
      receiver: company.address,
      amount: split.company,
      buyer
    });
  }

  if (signed.length !== expected.length) {
    return fail(
      res,
      400,
      'group_size_mismatch',
      `This payment needs ${expected.length} transaction(s); ${signed.length} were sent.`
    );
  }

  let verified;
  try {
    verified = expected.map((leg, i) => ({ ...leg, ...assertMatches(signed[i], leg) }));
  } catch (error) {
    // A structured refusal, because each of these means something different to
    // whoever has to fix it — and none of them should be retried blindly.
    return fail(
      res,
      400,
      error.code || 'signature_mismatch',
      error.message || 'The signed transactions do not match what was quoted.'
    );
  }

  let confirmation;
  try {
    confirmation = await submitAndConfirm(network, signed);
  } catch (error) {
    const message = String(error?.message || error);
    // The chain refusing a transfer is the buyer's problem to act on, and
    // "overspend" is by far the commonest — say so instead of "500".
    const code = /overspend|underflow|insufficient/i.test(message)
      ? 'insufficient_funds'
      : /already in ledger|duplicate/i.test(message)
        ? 'already_settled'
        : 'submit_failed';

    return fail(res, 402, code, message);
  }

  const developerLeg = verified.find((l) => l.role === 'developer');
  const companyLeg = verified.find((l) => l.role === 'company');

  // ON CONFLICT DO NOTHING, then read back: the chain will not include the same
  // transaction twice, so a retry after a dropped response must return the
  // ORIGINAL receipt rather than failing or writing a second one.
  await sql`
    INSERT INTO receipts (
      agent_id, buyer_address, developer_address, company_address,
      total_micro_algo, developer_micro_algo, company_micro_algo, company_bps,
      network_fee_micro_algo, group_id, developer_txid, company_txid,
      confirmed_round, network, tool_label, session_id
    ) VALUES (
      ${agent.id}, ${buyer}, ${agent.payout_address}, ${companyLeg ? company.address : null},
      ${split.total}, ${split.developer}, ${split.company}, ${split.companyBps},
      ${split.networkFee}, ${null}, ${developerLeg.txid}, ${companyLeg?.txid || null},
      ${confirmation.confirmedRound}, ${network}, ${toolLabel || agent.name},
      ${sessionId || null}
    )
    ON CONFLICT (developer_txid) DO NOTHING`;

  const [receipt] = await sql`
    SELECT id, created_at FROM receipts WHERE developer_txid = ${developerLeg.txid}`;

  return json(res, 200, {
    settled: true,
    receiptId: Number(receipt.id),
    agentId: agent.id,
    toolLabel: toolLabel || agent.name,
    network,
    confirmedRound: confirmation.confirmedRound,
    paidAt: receipt.created_at,
    // The three numbers the panel prints back to the user, pre-rendered so
    // every surface shows the same string rather than each doing its own maths.
    total: { microAlgo: split.total, algo: toAlgoString(split.total) },
    developer: {
      address: agent.payout_address,
      microAlgo: split.developer,
      algo: toAlgoString(split.developer),
      txid: developerLeg.txid,
      explorer: explorerFor(network, developerLeg.txid)
    },
    company: companyLeg
      ? {
          address: company.address,
          microAlgo: split.company,
          algo: toAlgoString(split.company),
          bps: split.companyBps,
          txid: companyLeg.txid,
          explorer: explorerFor(network, companyLeg.txid)
        }
      : null,
    networkFee: { microAlgo: split.networkFee, algo: toAlgoString(split.networkFee) }
  });
});
