/**
 * The registry the extension reads: which skills are payable, and how much.
 *
 * GET /api/agents            every live agent
 * GET /api/agents?ids=a,b,c  just these, for the extension's own skill list
 *
 * The payout address is included deliberately. It is public information — it is
 * on the chain the moment anyone is paid — and shipping it means the extension
 * can show the user who they are about to pay BEFORE they sign, rather than
 * asking them to trust a name.
 *
 * A skill that is not in this list is FREE. That is the default and it is the
 * right one: a missing registry entry must never mean "charge something", and a
 * registry that is unreachable must never block a chat.
 */
import { handler, json } from '../_lib/http.js';
import { sql, feeConfig, activeNetwork } from '../_lib/db.js';
import { splitFee, toAlgoString } from '../_lib/split.js';

export default handler('GET', async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const idsParam = url.searchParams.get('ids');
  const ids = idsParam
    ? idsParam.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean).slice(0, 200)
    : null;

  const rows = ids
    ? await sql`
        SELECT a.id, a.name, a.description, a.price_micro_algo, a.network,
               d.payout_address
          FROM agents a JOIN developers d ON d.id = a.developer_id
         WHERE a.status = 'live' AND a.id = ANY(${ids})
         ORDER BY a.name`
    : await sql`
        SELECT a.id, a.name, a.description, a.price_micro_algo, a.network,
               d.payout_address
          FROM agents a JOIN developers d ON d.id = a.developer_id
         WHERE a.status = 'live'
         ORDER BY a.name`;

  const company = feeConfig();

  return json(res, 200, {
    network: activeNetwork(),
    companyBps: company.bps,
    agents: rows.map((row) => {
      const price = Number(row.price_micro_algo);
      const split = splitFee(price, company.bps);
      return {
        id: row.id,
        name: row.name,
        description: row.description,
        payoutAddress: row.payout_address,
        priceMicroAlgo: price,
        priceAlgo: toAlgoString(price),
        // The split is quoted in the listing as well as in the 402, so the site
        // and the extension can both show the breakdown without a second call.
        developerMicroAlgo: split.developer,
        companyMicroAlgo: split.company
      };
    })
  });
});
