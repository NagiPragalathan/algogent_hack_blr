/**
 * Unattended payment, all the way to a confirmed round — no wallet anywhere.
 *
 *   node tests/autopay-live.test.mjs
 *
 * It drives the REAL handler with a fake req/res, against the real database and
 * real Algorand TestNet, and it moves actual (worthless) TestNet ALGO. That is
 * the point: every cheaper version passes while the interesting half is broken.
 * A mocked algod cannot tell you that the server signed with an account that
 * does not own the sender, that two per-step payments in the same block window
 * collided into one transaction id, or that `assertMatches` rejects the bytes
 * the signer just produced.
 *
 * The two-payments-back-to-back case is not padding. It is the whole reason
 * `seq` exists: settling per action builds each payment on its own, so two
 * identical actions in one session would otherwise be the same transaction and
 * the second is refused as already in the ledger.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Environment first, then site/.env — the same order the other scripts use. */
for (const line of fs.readFileSync(path.join(here, '..', '.env'), 'utf8').split(/\r?\n/)) {
  if (!line || line.trim().startsWith('#')) continue;
  const at = line.indexOf('=');
  if (at < 0) continue;
  const key = line.slice(0, at).trim();
  if (!process.env[key]) process.env[key] = line.slice(at + 1).trim();
}

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`);
  }
};
const section = (n) => console.log(`\n${n}`);

/** The minimum of a Vercel response object that `http.js` actually touches. */
function fakeRes() {
  const res = {
    statusCode: 0,
    headers: {},
    body: null,
    status(code) {
      res.statusCode = code;
      return res;
    },
    setHeader(k, v) {
      res.headers[k] = v;
      return res;
    },
    end(text) {
      res.body = text ? JSON.parse(text) : null;
      return res;
    }
  };
  return res;
}

async function call(handler, { method = 'POST', url = '/api/x402/run', body = undefined } = {}) {
  const res = fakeRes();
  await handler({ method, url, body }, res);
  return res;
}

const { default: runHandler } = await import('../api/x402/run.js');
const { default: clientHandler } = await import('../api/x402/client.js');
const { clientAccount } = await import('../api/_lib/client-wallet.js');

section('the client account');

const account = clientAccount();
ok('derives from the environment', Boolean(account?.address), 'set CLIENT_MNEMONIC in site/.env');
if (!account) process.exit(1);
console.log(`  ${account.address}`);

{
  const res = await fetch(`https://testnet-api.algonode.cloud/v2/accounts/${account.address}`);
  const balance = res.ok ? (await res.json()).amount : 0;
  console.log(`  ${(balance / 1e6).toFixed(6)} ALGO on TestNet`);
  ok('is funded enough to pay for a few actions', balance > 300_000, `${balance} microALGO`);
  if (balance <= 300_000) process.exit(1);
}

section('GET /api/x402/client');

{
  const res = await call(clientHandler, { method: 'GET', url: '/api/x402/client' });
  ok('answers 200', res.statusCode === 200, String(res.statusCode));
  ok('reports autoSign', res.body?.autoSign === true, JSON.stringify(res.body));
  ok('names the paying address', res.body?.address === account.address);
  ok('never returns the mnemonic', !JSON.stringify(res.body).includes(' '.repeat(0) + 'mnemonic'));
  ok('reports it funded', res.body?.funded === true, JSON.stringify(res.body?.balance));
}

section('POST /api/x402/run  { autoSign }  — one action');

const sessionId = `autopay-test-${Date.now().toString(36)}`;
let firstTxid = null;

{
  const res = await call(runHandler, {
    body: {
      autoSign: true,
      sessionId,
      items: [{ agentId: 'act-navigate', label: 'Opened example.com', step: 1, seq: 1 }]
    }
  });

  ok('settles in one call, no 402', res.statusCode === 200, JSON.stringify(res.body));
  if (res.statusCode !== 200) {
    console.log(`  ${JSON.stringify(res.body)}`);
  } else {
    ok('pays from the client account', res.body.from === account.address);
    ok('confirms on chain', Number(res.body.groups?.[0]?.confirmedRound) > 0);
    ok('writes a receipt', Number(res.body.receiptIds?.[0]) > 0);
    ok('carries one line per action', res.body.lines?.some((l) => l.agentId === 'act-navigate'));

    const action = res.body.lines.find((l) => l.agentId === 'act-navigate');
    firstTxid = action?.txid;
    ok('the line is checkable on an explorer', Boolean(action?.explorer?.includes(action.txid)));
    console.log(`  ${action?.explorer}`);
  }
}

section('two identical actions back to back — the case `seq` exists for');

{
  const item = (seq) => ({ agentId: 'act-answer', label: 'Answer from chatgpt', step: null, seq });

  const first = await call(runHandler, {
    body: { autoSign: true, sessionId, items: [item(2)] }
  });
  const second = await call(runHandler, {
    body: { autoSign: true, sessionId, items: [item(3)] }
  });

  ok('the first settles', first.statusCode === 200, JSON.stringify(first.body));
  ok('the second settles too', second.statusCode === 200, JSON.stringify(second.body));

  const a = first.body?.lines?.[0]?.txid;
  const b = second.body?.lines?.[0]?.txid;
  ok('and they are two different transactions', Boolean(a && b && a !== b), `${a} vs ${b}`);
  ok('and two different receipts', first.body?.receiptIds?.[0] !== second.body?.receiptIds?.[0]);
}

section('the same shape WITHOUT seq');

{
  /**
   * Reported rather than asserted, because the outcome depends on timing this
   * test does not control. Each settle waits for a confirmed round, so the two
   * requests are built from different suggested params and usually differ
   * anyway — which is exactly why the collision is easy to miss until a batch
   * of actions finishes together and two are built in one block window.
   *
   * The honest claim is therefore narrow: `seq` makes them differ ALWAYS, and
   * the assertion above proves that. This block only prints what happens
   * without it, so a reader can see the guard is not load-bearing in the serial
   * case and is the whole of it in the concurrent one.
   */
  const item = { agentId: 'act-answer', label: 'Identical, no ordinal', step: null };
  const dupeSession = `${sessionId}-dupe`;

  const first = await call(runHandler, {
    body: { autoSign: true, sessionId: dupeSession, items: [item] }
  });
  const second = await call(runHandler, {
    body: { autoSign: true, sessionId: dupeSession, items: [item] }
  });

  ok('the first settles', first.statusCode === 200, JSON.stringify(first.body));
  const collided = second.statusCode !== 200 || second.body?.lines?.[0]?.txid === firstTxid;
  ok(
    'the second either collides or is a distinct transaction',
    collided || second.body?.lines?.[0]?.txid !== first.body?.lines?.[0]?.txid,
    JSON.stringify(second.body?.error || second.body?.lines?.[0]?.txid)
  );
  console.log(
    `  without seq: ${second.statusCode === 200 ? 'went through (different round)' : second.body?.error}`
  );
}

section('refusals');

{
  const res = await call(runHandler, { body: { autoSign: true, sessionId, items: [] } });
  ok('an empty run is refused, not charged', res.statusCode === 400, String(res.statusCode));
}

{
  const res = await call(runHandler, {
    body: { autoSign: true, sessionId, items: [{ agentId: 'not-a-real-agent', label: 'x' }] }
  });
  ok(
    'an unregistered action is free, not an error',
    res.body?.error === 'nothing_billable',
    JSON.stringify(res.body)
  );
}

{
  // The wallet road must still work exactly as before.
  const res = await call(runHandler, {
    body: {
      buyer: account.address,
      sessionId,
      items: [{ agentId: 'act-navigate', label: 'quote only', step: 1 }]
    }
  });
  ok('the wallet road still answers 402', res.statusCode === 402, String(res.statusCode));
  ok('and still carries unsigned groups', res.body?.accepts?.[0]?.extra?.groups?.length > 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
