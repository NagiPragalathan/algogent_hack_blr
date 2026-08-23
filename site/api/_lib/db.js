import { neon } from '@neondatabase/serverless';
import { required, ALGORAND_ADDRESS } from './http.js';
import { companyPayoutAddress, companyFeeBps, activeNetworkName } from './config.js';

/**
 * One connection per invocation, over HTTP rather than a socket — which is what
 * `@neondatabase/serverless` is for. A pooled TCP client in a serverless
 * function leaks connections across cold starts and eventually exhausts the
 * database's limit for reasons that look nothing like the cause.
 */
export const sql = neon(required('DATABASE_URL'));

/**
 * The marketplace's cut, and where it goes.
 *
 * Both come from the environment and neither has a default. A missing company
 * address has to stop the request: defaulting it would either burn the
 * company's share by sending it nowhere, or silently hand it to the developer —
 * and both are the kind of wrong that is only discovered at the end of a month.
 *
 * COMPANY_FEE_BPS is basis points, so 2000 is 20% and the developer keeps 80%.
 * It is read per request rather than captured at module load so changing it in
 * the dashboard takes effect without a redeploy — and every receipt stores the
 * bps it was charged at, so changing it never restates what someone was already
 * paid.
 */
export function feeConfig() {
  const address = companyPayoutAddress();
  if (!ALGORAND_ADDRESS.test(address)) {
    throw new Error('COMPANY_PAYOUT_ADDRESS is not a valid Algorand address');
  }

  const bps = companyFeeBps();
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
    throw new Error(`COMPANY_FEE_BPS must be an integer 0..10000, got ${bps}`);
  }

  return { address, bps };
}

/** The network the marketplace settles on. TestNet unless told otherwise. */
export function activeNetwork() {
  const network = activeNetworkName();
  if (!['testnet', 'mainnet', 'localnet'].includes(network)) {
    throw new Error(`X402_NETWORK must be testnet, mainnet or localnet, got ${network}`);
  }
  return network;
}

/**
 * An agent joined to the address its earnings go to.
 *
 * Returns null rather than throwing for an unknown or paused id: "this agent is
 * not for sale" is an ordinary answer to a quote, not an error, and the caller
 * turns it into the right 4xx.
 */
export async function liveAgent(id) {
  const rows = await sql`
    SELECT a.id,
           a.name,
           a.description,
           a.price_micro_algo,
           a.network,
           a.status,
           d.payout_address,
           d.id AS developer_id
      FROM agents a
      JOIN developers d ON d.id = a.developer_id
     WHERE a.id = ${id}
       AND a.status = 'live'
     LIMIT 1`;

  return rows[0] || null;
}
