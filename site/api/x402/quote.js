/**
 * The 402 challenge, and the group the buyer is asked to sign.
 *
 * POST /api/x402/quote  { agentId, buyer, sessionId? }
 *
 * This is x402's first leg — "payment is required, here is exactly what would
 * satisfy it" — carrying an `accepts` array of PaymentRequirements as the spec
 * describes. Two deliberate departures from the reference implementation, both
 * because that implementation is EVM and Solana only and this settles on
 * Algorand:
 *
 *   - `network` is "algorand-testnet" / "algorand-mainnet". The spec's network
 *     identifiers are an open string set; there is no registered Algorand
 *     scheme, so this names its own rather than pretending to be one of theirs.
 *   - the payload is a signed transaction GROUP rather than an EIP-3009
 *     authorisation. Algorand has atomic groups natively, which is a better fit
 *     for a split payment than two authorisations that can half-land.
 *
 * The unsigned transactions ride along in `extra`, so the buyer needs one round
 * trip rather than two. They are not a promise: `settle` re-decodes whatever
 * comes back and checks it against these numbers before submitting.
 */
import { handler, body, fail, json, ALGORAND_ADDRESS } from '../_lib/http.js';
import { liveAgent, feeConfig, activeNetwork } from '../_lib/db.js';
import { splitFee, priceProblem, toAlgoString } from '../_lib/split.js';
import { buildPaymentGroup } from '../_lib/algorand.js';

export default handler('POST', async (req, res) => {
  const { agentId, buyer, sessionId } = body(req);

  if (!ALGORAND_ADDRESS.test(String(buyer || '').trim())) {
    return fail(res, 400, 'invalid_buyer', 'buyer must be a valid Algorand address.');
  }

  const agent = await liveAgent(String(agentId || '').trim());
  if (!agent) {
    // Not an error the buyer can fix, and not a 500 either: this agent simply
    // has no price, which is how an unregistered skill stays free.
    return fail(
      res,
      404,
      'agent_not_listed',
      `No live agent is registered as "${agentId}". Nothing is owed for it.`
    );
  }

  const price = Number(agent.price_micro_algo);
  const problem = priceProblem(price);
  if (problem) {
    return fail(res, 409, problem, 'This agent is listed at a price that cannot be settled.');
  }

  const company = feeConfig();
  const network = activeNetwork();
  const split = splitFee(price, company.bps);

  const group = await buildPaymentGroup({
    network,
    buyer,
    developerAddress: agent.payout_address,
    companyAddress: company.address,
    split,
    agentId: agent.id,
    sessionId
  });

  return json(res, 402, {
    x402Version: 1,
    error: 'payment_required',
    accepts: [
      {
        scheme: 'exact',
        network: `algorand-${network}`,
        // Atomic units, as a string — the spec's convention, and it keeps a
        // large amount out of a JS number on the way through a client.
        maxAmountRequired: String(split.total),
        resource: `agent:${agent.id}`,
        description: agent.description || agent.name,
        mimeType: 'application/json',
        payTo: agent.payout_address,
        maxTimeoutSeconds: 120,
        // Native ALGO rather than an ASA. Stated explicitly because "0" is also
        // how an asset id is written and the two must not be confused.
        asset: 'ALGO',
        outputSchema: null,
        extra: {
          agentId: agent.id,
          agentName: agent.name,
          // Every number the receipt will later claim, quoted up front so the
          // buyer sees the split BEFORE signing rather than after paying.
          split: {
            totalMicroAlgo: split.total,
            developerMicroAlgo: split.developer,
            companyMicroAlgo: split.company,
            companyBps: split.companyBps,
            networkFeeMicroAlgo: split.networkFee,
            buyerPaysMicroAlgo: split.buyerPays,
            totalAlgo: toAlgoString(split.total),
            developerAlgo: toAlgoString(split.developer),
            companyAlgo: toAlgoString(split.company),
            networkFeeAlgo: toAlgoString(split.networkFee)
          },
          developerAddress: agent.payout_address,
          companyAddress: company.address,
          groupId: group.groupId,
          // ARC-0001 base64 msgpack, in the order they must be signed and
          // submitted. Reordering a group invalidates its group id.
          transactions: group.transactions
        }
      }
    ]
  });
});
