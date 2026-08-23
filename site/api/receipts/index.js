/**
 * The fee history: what was paid, to whom, for which tool.
 *
 * GET /api/receipts?session=<id>   one chat or run, in the order it happened
 * GET /api/receipts?buyer=<addr>   everything one wallet has spent
 *
 * This is what the panel prints under a finished answer, so the shape is driven
 * by the question a person actually asks looking at it: *which tool got how
 * much, and can I check it?* Hence a row per payment carrying the tool's label,
 * the developer's address, the amount in ALGO, and a link to the transaction on
 * a public explorer that has nothing to do with us.
 *
 * A session is ordered OLDEST FIRST, unlike the buyer history. The session list
 * is a narrative of one run — the order the tools ran in — while the buyer list
 * is a statement, where the most recent line is the one being looked for.
 */
import { handler, json, fail, ALGORAND_ADDRESS } from '../_lib/http.js';
import { sql } from '../_lib/db.js';
import { toAlgoString } from '../_lib/split.js';
import { explorerFor } from '../_lib/algorand.js';

const MAX_ROWS = 200;

export default handler('GET', async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const session = url.searchParams.get('session');
  const buyer = url.searchParams.get('buyer');

  if (!session && !buyer) {
    return fail(res, 400, 'missing_filter', 'Pass either ?session= or ?buyer=.');
  }
  if (buyer && !ALGORAND_ADDRESS.test(buyer)) {
    return fail(res, 400, 'invalid_buyer', 'buyer must be a valid Algorand address.');
  }

  const rows = session
    ? await sql`
        SELECT * FROM receipts
         WHERE session_id = ${session}
         ORDER BY created_at ASC
         LIMIT ${MAX_ROWS}`
    : await sql`
        SELECT * FROM receipts
         WHERE buyer_address = ${buyer}
         ORDER BY created_at DESC
         LIMIT ${MAX_ROWS}`;

  const entries = rows.map((r) => ({
    receiptId: Number(r.id),
    agentId: r.agent_id,
    toolLabel: r.tool_label,
    paidAt: r.created_at,
    network: r.network,
    confirmedRound: Number(r.confirmed_round),
    total: {
      microAlgo: Number(r.total_micro_algo),
      algo: toAlgoString(Number(r.total_micro_algo))
    },
    developer: {
      address: r.developer_address,
      microAlgo: Number(r.developer_micro_algo),
      algo: toAlgoString(Number(r.developer_micro_algo)),
      txid: r.developer_txid,
      explorer: explorerFor(r.network, r.developer_txid)
    },
    company: r.company_txid
      ? {
          address: r.company_address,
          microAlgo: Number(r.company_micro_algo),
          algo: toAlgoString(Number(r.company_micro_algo)),
          bps: r.company_bps,
          txid: r.company_txid,
          explorer: explorerFor(r.network, r.company_txid)
        }
      : null,
    networkFee: {
      microAlgo: Number(r.network_fee_micro_algo),
      algo: toAlgoString(Number(r.network_fee_micro_algo))
    }
  }));

  // Summed from the rows rather than with SQL SUM, so the total is provably the
  // sum of the lines shown — a footer that disagrees with its own list is the
  // one bug a receipt cannot survive.
  const sum = (pick) => entries.reduce((acc, e) => acc + pick(e), 0);
  const totalMicro = sum((e) => e.total.microAlgo);
  const feeMicro = sum((e) => e.networkFee.microAlgo);

  return json(res, 200, {
    count: entries.length,
    truncated: entries.length === MAX_ROWS,
    totals: {
      totalMicroAlgo: totalMicro,
      totalAlgo: toAlgoString(totalMicro),
      developerMicroAlgo: sum((e) => e.developer.microAlgo),
      companyMicroAlgo: sum((e) => e.company?.microAlgo || 0),
      networkFeeMicroAlgo: feeMicro,
      spentMicroAlgo: totalMicro + feeMicro,
      spentAlgo: toAlgoString(totalMicro + feeMicro)
    },
    receipts: entries
  });
});
