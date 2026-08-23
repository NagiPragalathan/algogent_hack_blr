/**
 * A developer publishes an agent and says where to pay them.
 *
 * POST /api/agents/register
 *   { id, name, description?, body?, priceAlgo, payoutAddress, email?, displayName? }
 *
 * The payout address is the entire point of this endpoint, so it is checked
 * twice — here in the shape the user typed it, and again by a CHECK constraint
 * in the table. An Algorand address carries its own 4-byte checksum, so a
 * single mistyped character fails `isValidAddress` rather than becoming a
 * live-looking address that swallows every payout forever.
 */
import algosdk from 'algosdk';
import { handler, body, fail, json, ALGORAND_ADDRESS } from '../_lib/http.js';
import { sql, activeNetwork } from '../_lib/db.js';
import { parseAlgo, priceProblem, toAlgoString } from '../_lib/split.js';

const ID = /^[a-z0-9][a-z0-9-]{1,63}$/;

export default handler('POST', async (req, res) => {
  const input = body(req);

  const id = String(input.id || '').trim().toLowerCase();
  if (!ID.test(id)) {
    return fail(
      res,
      400,
      'invalid_id',
      'id must be 2-64 characters of lowercase letters, numbers and hyphens.'
    );
  }

  const name = String(input.name || '').trim();
  if (!name) return fail(res, 400, 'invalid_name', 'name is required.');

  const payoutAddress = String(input.payoutAddress || '').trim();
  if (!ALGORAND_ADDRESS.test(payoutAddress) || !algosdk.isValidAddress(payoutAddress)) {
    return fail(
      res,
      400,
      'invalid_address',
      'payoutAddress is not a valid Algorand address. Check it character by character — ' +
        'the checksum did not match, which means at least one is wrong.'
    );
  }

  const priceMicroAlgo = parseAlgo(input.priceAlgo);
  if (priceMicroAlgo === null) {
    return fail(
      res,
      400,
      'invalid_price',
      'priceAlgo must be a plain decimal in ALGO with at most 6 decimal places, e.g. "0.02".'
    );
  }

  const problem = priceProblem(priceMicroAlgo);
  if (problem === 'price_below_floor') {
    return fail(
      res,
      400,
      'price_below_floor',
      'That price is smaller than the network fees needed to pay it out. ' +
        'The floor is 0.020000 ALGO.'
    );
  }
  if (problem) return fail(res, 400, problem, 'priceAlgo is not a usable price.');

  const network = activeNetwork();

  // The address IS the developer's identity — no accounts, no passwords. Two
  // agents registered from the same address are the same developer, which is
  // what makes `developer_earnings` add up across everything they publish.
  const [developer] = await sql`
    INSERT INTO developers (payout_address, email, display_name)
    VALUES (${payoutAddress}, ${input.email || null}, ${input.displayName || null})
    ON CONFLICT (payout_address) DO UPDATE
       SET email        = COALESCE(EXCLUDED.email, developers.email),
           display_name = COALESCE(EXCLUDED.display_name, developers.display_name)
    RETURNING id, payout_address`;

  // Re-registering the same id updates it — but only from the SAME developer.
  // Without that WHERE clause, anyone could point an existing agent's payouts
  // at their own address by re-registering its id.
  const [agent] = await sql`
    INSERT INTO agents (id, developer_id, name, description, body, price_micro_algo, network)
    VALUES (${id}, ${developer.id}, ${name}, ${input.description || ''},
            ${input.body || ''}, ${priceMicroAlgo}, ${network})
    ON CONFLICT (id) DO UPDATE
       SET name             = EXCLUDED.name,
           description      = EXCLUDED.description,
           body             = EXCLUDED.body,
           price_micro_algo = EXCLUDED.price_micro_algo,
           network          = EXCLUDED.network,
           updated_at       = now()
     WHERE agents.developer_id = ${developer.id}
    RETURNING id, name, price_micro_algo, network, status`;

  if (!agent) {
    return fail(
      res,
      409,
      'id_taken',
      `An agent called "${id}" is already registered to a different payout address.`
    );
  }

  return json(res, 200, {
    id: agent.id,
    name: agent.name,
    priceAlgo: toAlgoString(Number(agent.price_micro_algo)),
    priceMicroAlgo: Number(agent.price_micro_algo),
    network: agent.network,
    status: agent.status,
    payoutAddress: developer.payout_address
  });
});
