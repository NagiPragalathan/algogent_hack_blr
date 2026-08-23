/**
 * Every knob the payments layer has, with working defaults baked in.
 *
 * The defaults here are DELIBERATE and they are all public information: an
 * Algorand payout address is on the chain the moment anyone is paid, a revenue
 * split is on the pricing page, and the network and per-action price are
 * product decisions. Hardcoding those means a fresh deploy works with no
 * dashboard step, which is the whole point — a demo that 500s until someone
 * remembers four environment variables is a demo that fails in front of people.
 *
 * DATABASE_URL is the exception and it has NO default on purpose. It is a live
 * write credential for a database this repo does not own the security of, and
 * this repository is on GitHub. Committing it would hand anyone who reads the
 * repo full write access, and rotating it afterwards does not un-publish it.
 * It is set on the deployment instead — see `npm run vercel:env`.
 *
 * Everything is still overridable from the environment, so production can point
 * at a different company address or a different chain without a code change.
 */

/**
 * These are FUNCTIONS, not constants, and that is load-bearing.
 *
 * A `const` captures `process.env` at import, and a serverless module is
 * imported once and reused across many invocations — so a value changed in the
 * dashboard would not take effect until something happened to evict the module.
 * Reading per call means a redeploy is never needed to change the split or the
 * payout address, and it is also what lets a test point them somewhere else.
 */

/** Where the marketplace's 20% goes. */
export const companyPayoutAddress = () =>
  process.env.COMPANY_PAYOUT_ADDRESS ||
  '2RYXGHHZSCM4LDY7GAPVAOGGFRPJBY3TVHECI3O5ULT3VLSJYQJRSR4BVU';

/** The marketplace's cut in basis points. 2000 = 20%, developer keeps 80%. */
export const companyFeeBps = () => Number(process.env.COMPANY_FEE_BPS ?? 2000);

/** Which chain settles. */
export const activeNetworkName = () => process.env.X402_NETWORK || 'testnet';

/**
 * What one agent action costs.
 *
 * Deliberately tiny. The demo wallet holds 10 TestNet ALGO and has to survive a
 * few hundred runs, and at this price a twenty-action run costs 0.042 ALGO all
 * in — about 238 runs. Raise it when this stops being a demo.
 */
export const actionPriceMicroAlgo = () => Number(process.env.ACTION_PRICE_MICRO_ALGO ?? 1_000);

/**
 * Algorand will not let an account hold less than this, and a payment that
 * would leave the RECEIVER below it is rejected — so a brand new address cannot
 * be paid 0.0008 ALGO. It has to be funded past this line once, by anyone,
 * before it can receive anything smaller.
 */
export const ALGORAND_MIN_BALANCE = 100_000;

/** The public algod endpoints. AlgoNode needs no token. */
export const ALGOD_URLS = {
  testnet: 'https://testnet-api.algonode.cloud',
  mainnet: 'https://mainnet-api.algonode.cloud',
  localnet: 'http://localhost:4001'
};

export const algodUrl = () => process.env.ALGOD_URL || ALGOD_URLS[activeNetworkName()];
export const algodToken = () => process.env.ALGOD_TOKEN || '';

/** The one value with no default. See the note at the top of this file. */
export const databaseUrl = () => process.env.DATABASE_URL;

/**
 * The account the marketplace signs with when nobody is there to approve.
 *
 * THE SECOND VALUE WITH NO DEFAULT, and for a harder reason than the first.
 * Everything above is public information — an address, a percentage, a chain, a
 * price — and hardcoding it makes a fresh deploy work. A mnemonic is the
 * opposite of all of it: it is total control of an account, this repository is
 * public, and a phrase that has been published once cannot be unpublished.
 * Unset means unattended payment is simply off, which is the safe direction and
 * the one the whole payments layer already defaults to.
 *
 * `TEST_MNEMONIC` is read as a fallback because it is the throwaway account the
 * end-to-end test already uses and already funds, so a demo machine needs no
 * second variable. That is a convenience, not a recommendation.
 */
export const clientMnemonic = () =>
  (process.env.CLIENT_MNEMONIC || process.env.TEST_MNEMONIC || '').trim();

/**
 * The off switch. Default ON, because a mnemonic that has been configured is
 * somebody having already decided — a key present and ignored reads as a broken
 * deploy, which is the failure this whole layer keeps writing notes about.
 */
export const autoSignEnabled = () => String(process.env.X402_AUTOSIGN ?? '1') !== '0';

/**
 * MainNet has to be said out loud.
 *
 * On TestNet an unattended key spends worthless ALGO and the worst case is a
 * demo wallet drained. The identical code on MainNet spends real money with no
 * confirmation anywhere in front of it, and inheriting that by changing one
 * unrelated variable is exactly how it would happen.
 */
export const autoSignMainnetAllowed = () => process.env.X402_AUTOSIGN_MAINNET === '1';
