/**
 * The API handlers, against the real Neon database.
 *
 * Vercel functions are just `(req, res) => …`, so they can be driven directly
 * without a server in front of them. Everything below therefore exercises the
 * real SQL, the real constraints and the real algosdk — only the HTTP transport
 * is faked, and the transport is the one part Vercel is responsible for.
 *
 * It cleans up after itself: every row it writes is removed at the end, so it
 * is safe to run repeatedly against a live database.
 *
 *   DATABASE_URL="postgres://…" node tests/api-live.test.mjs
 */
import algosdk from 'algosdk';

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`); }
};
const section = (n) => console.log(`\n${n}`);

// Set before the modules load: db.js reads the environment at import time.
process.env.COMPANY_PAYOUT_ADDRESS ||= algosdk.generateAccount().addr.toString();
process.env.COMPANY_FEE_BPS ||= '2000';
process.env.X402_NETWORK ||= 'testnet';

const { sql } = await import('../api/_lib/db.js');
const register = (await import('../api/agents/register.js')).default;
const listAgents = (await import('../api/agents/index.js')).default;
const quote = (await import('../api/x402/quote.js')).default;
const receipts = (await import('../api/receipts/index.js')).default;

/** A minimal res that records what a handler did. */
function mockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    payload: null,
    status(code) { this.statusCode = code; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
    end(text) { try { this.payload = JSON.parse(text); } catch { this.payload = text; } return this; }
  };
  return res;
}

const call = async (fn, { method = 'POST', url = '/', body } = {}) => {
  const res = mockRes();
  await fn({ method, url, body }, res);
  return res;
};

const devA = algosdk.generateAccount().addr.toString();
const devB = algosdk.generateAccount().addr.toString();
const AGENT_ID = `test-agent-${Date.now().toString(36)}`;

section('registering an agent');

const created = await call(register, {
  body: { id: AGENT_ID, name: 'Test Summariser', description: 'A test agent.',
          priceAlgo: '0.05', payoutAddress: devA, email: 'dev@example.com' }
});

ok('registration succeeds', created.statusCode === 200, JSON.stringify(created.payload));

// The exact question site-21 asked: do these field names match what /publish
// destructures? Asserted by name, one at a time, so a rename fails loudly.
section('the register response field names (what /publish destructures)');
const r = created.payload || {};
for (const [field, expected] of [
  ['id', AGENT_ID],
  ['name', 'Test Summariser'],
  ['priceAlgo', '0.050000'],
  ['priceMicroAlgo', 50_000],
  ['network', 'testnet'],
  ['status', 'live'],
  ['payoutAddress', devA]
]) {
  ok(`${field} === ${JSON.stringify(expected)}`, r[field] === expected, JSON.stringify(r[field]));
}

section('re-registering your OWN agent updates it');

const updated = await call(register, {
  body: { id: AGENT_ID, name: 'Renamed', priceAlgo: '0.10', payoutAddress: devA }
});
ok('the update succeeds', updated.statusCode === 200);
ok('the name changed', updated.payload?.name === 'Renamed');
ok('the price changed', updated.payload?.priceAlgo === '0.100000');

section('re-registering SOMEONE ELSE\'S id is refused');

const stolen = await call(register, {
  body: { id: AGENT_ID, name: 'Hijack', priceAlgo: '0.05', payoutAddress: devB }
});
ok('it is refused', stolen.statusCode === 409, `status ${stolen.statusCode}`);
// The second thing site-21 asked: this code is what routes the message to the
// id field rather than to a form-level alert.
ok('with error code "id_taken"', stolen.payload?.error === 'id_taken', JSON.stringify(stolen.payload));

const stillMine = await sql`SELECT d.payout_address FROM agents a JOIN developers d ON d.id=a.developer_id WHERE a.id=${AGENT_ID}`;
ok('and the payout address did NOT move', stillMine[0]?.payout_address === devA);

section('validation refusals carry the codes the form maps');

for (const [label, body, code] of [
  ['a bad id', { id: 'A B', name: 'x', priceAlgo: '1', payoutAddress: devA }, 'invalid_id'],
  ['a missing name', { id: 'ok-id', name: '', priceAlgo: '1', payoutAddress: devA }, 'invalid_name'],
  ['a mistyped address', { id: 'ok-id', name: 'x', priceAlgo: '1', payoutAddress: 'A'.repeat(58) }, 'invalid_address'],
  ['a float price', { id: 'ok-id', name: 'x', priceAlgo: '1e6', payoutAddress: devA }, 'invalid_price'],
  ['a price under the floor', { id: 'ok-id', name: 'x', priceAlgo: '0.000001', payoutAddress: devA }, 'price_below_floor']
]) {
  const res = await call(register, { body });
  ok(`${label} → ${code}`, res.payload?.error === code, JSON.stringify(res.payload));
}

section('the registry listing');

const listed = await call(listAgents, { method: 'GET', url: `/api/agents?ids=${AGENT_ID}` });
ok('it answers 200', listed.statusCode === 200);
ok('the agent is listed', listed.payload?.agents?.[0]?.id === AGENT_ID);
ok('with its payout address', listed.payload?.agents?.[0]?.payoutAddress === devA);
ok('and the split is quoted', listed.payload?.agents?.[0]?.developerMicroAlgo === 80_000);
ok('companyBps is exposed for the UI', listed.payload?.companyBps === 2000);

section('the 402 challenge');

const buyer = algosdk.generateAccount().addr.toString();
const q = await call(quote, { body: { agentId: AGENT_ID, buyer, sessionId: 'test-session' } });

ok('the challenge IS a 402', q.statusCode === 402, `status ${q.statusCode}`);
const terms = q.payload?.accepts?.[0];
ok('x402Version is 1', q.payload?.x402Version === 1);
ok('scheme is "exact"', terms?.scheme === 'exact');
ok('network names Algorand', terms?.network === 'algorand-testnet');
ok('payTo is the developer', terms?.payTo === devA);
ok('maxAmountRequired is atomic units as a string', terms?.maxAmountRequired === '100000');
ok('the split is quoted before signing', terms?.extra?.split?.developerMicroAlgo === 80_000);
ok('and the company share too', terms?.extra?.split?.companyMicroAlgo === 20_000);
ok('two unsigned transactions ride along', terms?.extra?.transactions?.length === 2);
ok('they carry a group id', Boolean(terms?.extra?.groupId));

section('an unlisted agent owes nothing');

const none = await call(quote, { body: { agentId: 'does-not-exist-anywhere', buyer } });
ok('it is a 404, not a 500', none.statusCode === 404);
ok('with a code the client can branch on', none.payload?.error === 'agent_not_listed');

section('receipts for a session with no payments');

const empty = await call(receipts, { method: 'GET', url: '/api/receipts?session=nothing-here' });
ok('answers 200 with an empty list', empty.statusCode === 200 && empty.payload?.count === 0);
ok('and zero totals', empty.payload?.totals?.spentMicroAlgo === 0);

section('cleanup');

await sql`DELETE FROM agents WHERE id = ${AGENT_ID}`;
await sql`DELETE FROM developers WHERE payout_address IN (${devA}, ${devB})`;
const left = await sql`SELECT id FROM agents WHERE id = ${AGENT_ID}`;
ok('the test rows are gone', left.length === 0);

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
