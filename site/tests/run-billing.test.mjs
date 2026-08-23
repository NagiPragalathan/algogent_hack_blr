/**
 * Billing a whole run: one signature, one transaction per action.
 *
 * Drives /api/x402/run against the live registry with the exact step list from
 * a real Gmail run, and asserts the thing that makes the receipt worth having —
 * that every action gets its OWN leg and therefore its own transaction id,
 * while the buyer is asked to sign once.
 *
 *   DATABASE_URL="…" node tests/run-billing.test.mjs
 */
import algosdk from 'algosdk';

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`); }
};
const section = (n) => console.log(`\n${n}`);

/**
 * A FUNDED address stands in for the company here, and that is not incidental.
 *
 * The quote runs a live min-balance preflight, and an address that has never
 * been funded cannot receive 0.0008 ALGO — Algorand refuses it. So a randomly
 * generated company address makes every structural assertion below fail for a
 * reason that has nothing to do with structure. The developer address doubles
 * as the company one; both legs land in the same funded account, which changes
 * none of the shapes being checked.
 */
const FUNDED = 'ZYQRMSLGHOFS6ZKCOXND4VFHCT5ZNMMGMFBMF7QBU4ITADHYAVWDF333YM';

process.env.COMPANY_PAYOUT_ADDRESS = FUNDED;
process.env.COMPANY_FEE_BPS ||= '2000';
process.env.X402_NETWORK ||= 'testnet';

const run = (await import('../api/x402/run.js')).default;

const mockRes = () => ({
  statusCode: 200, payload: null,
  status(c) { this.statusCode = c; return this; },
  setHeader() { return this; },
  end(t) { try { this.payload = JSON.parse(t); } catch { this.payload = t; } return this; }
});

const call = async (body, url = '/api/x402/run') => {
  const res = mockRes();
  await run({ method: 'POST', url, body }, res);
  return res;
};

const BUYER = process.env.DEMO_BUYER || algosdk.generateAccount().addr.toString();

// The exact steps from a real run, as the timeline showed them.
const ITEMS = [
  { agentId: 'act-navigate', label: 'Opened a starting page', step: 0 },
  { agentId: 'act-navigate', label: 'Go to https://mail.google.com/', step: 1 },
  { agentId: 'act-observe', label: 'Read the inbox', step: 1 },
  { agentId: 'act-finish', label: 'Gmail is open in the Inbox.', step: 2 }
];

section('quoting a four-action run');

const q = await call({ buyer: BUYER, sessionId: 'test-run', items: ITEMS });
ok('the challenge is a 402', q.statusCode === 402, JSON.stringify(q.payload).slice(0, 200));

const extra = q.payload?.accepts?.[0]?.extra;
ok('it names the FROM address', extra?.from === BUYER);
ok('all four actions were priced', extra?.actions === 4, `got ${extra?.actions}`);
ok('none was dropped as unregistered', extra?.unpricedActions === 0);
ok('four actions fit in one group', extra?.groups?.length === 1);

const legs = extra.groups[0].transactions;
ok('the group has 4 action legs + 1 marketplace leg', legs.length === 5, `got ${legs.length}`);
ok('four legs are actions', legs.filter((l) => l.role === 'action').length === 4);
ok('one leg is the marketplace', legs.filter((l) => l.role === 'company').length === 1);

section('every action has its own transaction id');

const txids = legs.map((l) => l.txid);
ok('every leg has a txid', txids.every(Boolean));
ok('and they are all different', new Set(txids).size === txids.length);
ok('each action leg carries the label the user saw',
   legs[1].label === 'Go to https://mail.google.com/');
ok('and the step index it came from', legs[1].step === 1);

section('the arithmetic');

const t = extra.totals;
// 4 actions x 0.001 ALGO
ok('total is 0.004000 ALGO', t.totalAlgo === '0.004000', t.totalAlgo);
ok('developer gets 80%', t.developerAlgo === '0.003200', t.developerAlgo);
ok('marketplace gets 20%', t.companyAlgo === '0.000800', t.companyAlgo);
ok('the two shares add back to the total',
   t.developerMicroAlgo + t.companyMicroAlgo === t.totalMicroAlgo);
// 5 transactions x 1000 microALGO
ok('network fee is one per transaction', t.networkFeeAlgo === '0.005000', t.networkFeeAlgo);
ok('buyer pays price + fees', t.buyerPaysMicroAlgo === t.totalMicroAlgo + t.networkFeeMicroAlgo);

section('a long run chunks, because Algorand caps a group at 16');

const long = await call({
  buyer: BUYER, sessionId: 'test-long',
  items: Array.from({ length: 20 }, (_, i) => ({
    agentId: 'act-click', label: `Click [${i}]`, step: i
  }))
});
const longExtra = long.payload?.accepts?.[0]?.extra;
ok('20 actions split into 2 groups', longExtra?.groups?.length === 2);
ok('the first holds 15 actions + 1 marketplace leg',
   longExtra?.groups?.[0]?.transactions?.length === 16);
ok('the second holds the remaining 5 + 1',
   longExtra?.groups?.[1]?.transactions?.length === 6);
const allTx = longExtra.groups.flatMap((g) => g.transactions.map((t2) => t2.txid));
ok('every transaction across both groups is unique', new Set(allTx).size === allTx.length);

section('unregistered actions are free, not fatal');

const mixed = await call({
  buyer: BUYER, sessionId: 'test-mixed',
  items: [
    { agentId: 'act-navigate', label: 'Navigate', step: 0 },
    { agentId: 'act-does-not-exist', label: 'Made up', step: 1 }
  ]
});
ok('the run still quotes', mixed.statusCode === 402);
ok('one action priced', mixed.payload?.accepts?.[0]?.extra?.actions === 1);
ok('one reported as unpriced', mixed.payload?.accepts?.[0]?.extra?.unpricedActions === 1);

const none = await call({
  buyer: BUYER, sessionId: 'x', items: [{ agentId: 'nope', label: 'x' }]
});
ok('a run with nothing billable says so', none.payload?.error === 'nothing_billable');

section('an unfunded payee is caught BEFORE anyone signs');

/**
 * The single most likely thing to break a first demo. Algorand refuses a
 * transfer that would leave the receiver under 0.1 ALGO, and its own error
 * arrives after the user has approved the payment, names no address, and reads
 * exactly like being out of funds.
 */
const fresh = algosdk.generateAccount().addr.toString();
process.env.COMPANY_PAYOUT_ADDRESS = fresh;
const cold = await call({ buyer: BUYER, sessionId: 'test-cold', items: ITEMS });
process.env.COMPANY_PAYOUT_ADDRESS = FUNDED;

ok('it is refused at quote time', cold.statusCode === 409, `status ${cold.statusCode}`);
ok('with a code the client can branch on', cold.payload?.error === 'receiver_unfunded');
ok('and it names the account', (cold.payload?.message || '').includes(fresh));
ok(
  'and says what to do about it',
  /0\.100000 ALGO/.test(cold.payload?.message || ''),
  cold.payload?.message
);

section('what a demo run actually costs you');

console.log(`       4-action run   ${t.buyerPaysAlgo} ALGO`);
console.log(`       20-action run  ${longExtra.totals.buyerPaysAlgo} ALGO`);
const per20 = Number(longExtra.totals.buyerPaysMicroAlgo);
console.log(`       10 ALGO buys   ~${Math.floor(10_000_000 / per20)} runs of 20 actions`);

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
