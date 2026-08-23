/**
 * One real x402 payment, all the way to a confirmed round.
 *
 * Everything either side of the signature was already covered — the panel's
 * fixtures drive `settleRun` with a fake wallet, and `run-billing.test.mjs`
 * drives the quote — and the gap between them is where every failure of the
 * last few hours lived: a signer that could not sign, a price list that was
 * null, a company address that could not receive. None of those had a symptom.
 *
 * So this signs for real and submits for real. It needs a funded TestNet
 * account and it moves actual (worthless) TestNet ALGO, which is the point: a
 * test that stops short of the chain cannot tell you the chain would have
 * accepted it.
 *
 *   TEST_MNEMONIC="…" node tests/x402-end-to-end.test.mjs
 *
 * The mnemonic is read from the environment or site/.env, never committed, and
 * should be a throwaway. A seed phrase is total control of an account.
 */
import algosdk from 'algosdk';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`); }
};
const section = (n) => console.log(`\n${n}`);

const here = path.dirname(fileURLToPath(import.meta.url));

/** Environment first, then site/.env — the same order the other scripts use. */
function envValue(name) {
  if (process.env[name]) return process.env[name].trim();
  const envPath = path.join(here, '..', '.env');
  if (!fs.existsSync(envPath)) return '';
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const at = line.indexOf('=');
    if (at < 0) continue;
    if (line.slice(0, at).trim() !== name) continue;
    return line.slice(at + 1).trim().replace(/^["']|["']$/g, '');
  }
  return '';
}

const API = process.env.MARKETPLACE_API || 'https://algogent.vercel.app';
const ALGOD = 'https://testnet-api.algonode.cloud';
const INDEXER = 'https://testnet-idx.algonode.cloud';

const mnemonic = envValue('TEST_MNEMONIC');
if (!mnemonic) {
  console.error('TEST_MNEMONIC is not set (environment or site/.env). Use a throwaway account.');
  process.exit(1);
}

const account = algosdk.mnemonicToSecretKey(mnemonic);
const buyer = account.addr.toString();

section('the buyer');
console.log(`  ${buyer}`);

{
  const res = await fetch(`${ALGOD}/v2/accounts/${buyer}`);
  const balance = res.ok ? (await res.json()).amount : 0;
  console.log(`  ${(balance / 1e6).toFixed(6)} ALGO on TestNet`);
  ok('is funded past the minimum balance', balance >= 200_000,
     `${(balance / 1e6).toFixed(6)} ALGO — send it at least 0.2`);
  if (balance < 200_000) { console.log(`\n${pass}/${pass + fail} passed`); process.exit(1); }
}

/** The exact shape a two-step run plus its answer produces. */
const sessionId = `e2e-${Date.now().toString(36)}`;
const items = [
  { agentId: 'act-open-tab', label: 'Opened a starting page', step: 0 },
  { agentId: 'act-navigate', label: 'Go to https://mail.google.com/', step: 1 },
  { agentId: 'act-answer', label: 'Answer from chatgpt', step: null }
];

/* ── quote ──────────────────────────────────────────────────────────────── */
section('the quote');

const quoteRes = await fetch(`${API}/api/x402/run`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ buyer, sessionId, items })
});

ok('answers 402, which IS the challenge', quoteRes.status === 402, `got ${quoteRes.status}`);
const quote = await quoteRes.json();
if (quoteRes.status !== 402) {
  console.log('  ', JSON.stringify(quote).slice(0, 300));
  console.log(`\n${pass}/${pass + fail} passed`);
  process.exit(1);
}

const groups = quote.accepts?.[0]?.extra?.groups || [];
ok('carries at least one group', groups.length > 0);

const flat = groups.flatMap((g) => g.transactions.map((t) => t.txn));
ok('three action legs and a marketplace leg', flat.length === 4, `${flat.length} transactions`);

/* ── the note, which is what an auditor reads ───────────────────────────── */
section('the on-chain note');

const decoder = new TextDecoder();
for (const raw of flat) {
  const txn = algosdk.decodeUnsignedTransaction(Buffer.from(raw, 'base64'));
  const note = decoder.decode(txn.note || new Uint8Array());
  ok(`starts with x402 — ${note.slice(0, 46)}…`, note.startsWith('x402'), note || '(empty)');
  ok('  and is within Algorand\'s 1024-byte note limit', (txn.note?.length ?? 0) <= 1024);
}

/* ── sign ───────────────────────────────────────────────────────────────── */
section('the signature');

const signed = flat.map((raw) =>
  Buffer.from(
    algosdk.decodeUnsignedTransaction(Buffer.from(raw, 'base64')).signTxn(account.sk)
  ).toString('base64')
);

ok('every transaction signed', signed.length === flat.length);

let cursor = 0;
const byGroup = groups.map((g) => ({
  signed: signed.slice(cursor, (cursor += g.transactions.length))
}));

/* ── settle ─────────────────────────────────────────────────────────────── */
section('settlement');

const settleRes = await fetch(`${API}/api/x402/run?settle=1`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ buyer, sessionId, items, groups: byGroup })
});

const settled = await settleRes.json().catch(() => null);
ok('the marketplace accepted it', settleRes.ok, `${settleRes.status} ${JSON.stringify(settled).slice(0, 260)}`);

if (!settleRes.ok) { console.log(`\n${pass}/${pass + fail} passed`); process.exit(1); }

ok('a receipt was written', Array.isArray(settled.receiptIds) && settled.receiptIds.length > 0);
ok('with a confirmed round', settled.groups?.[0]?.confirmedRound > 0, JSON.stringify(settled.groups?.[0]));
ok('and a line per action', settled.lines?.length === 4, `${settled.lines?.length} lines`);

section('what anyone can check without asking us');
for (const line of settled.lines || []) {
  console.log(`  ${(line.microAlgo / 1e6).toFixed(6)} ALGO  ${line.label || line.agentId || 'marketplace'}`);
  console.log(`    https://lora.algokit.io/testnet/transaction/${line.txid}`);
}

/* ── the chain agrees ───────────────────────────────────────────────────── */
section('the chain');

const first = settled.lines?.[0]?.txid;
if (first) {
  // The indexer lags the node by a round or two.
  let found = null;
  for (let i = 0; i < 20 && !found; i += 1) {
    const r = await fetch(`${INDEXER}/v2/transactions/${first}`);
    if (r.ok) found = (await r.json()).transaction;
    else await new Promise((res) => setTimeout(res, 1000));
  }

  ok('the first leg is on chain', Boolean(found), 'the indexer never saw it');
  if (found) {
    const note = found.note ? decoder.decode(Buffer.from(found.note, 'base64')) : '';
    ok('its note starts with x402, as the explorer will show', note.startsWith('x402'), note);
    ok('it is part of an atomic group', Boolean(found.group), 'a lone payment is not a receipt');
    console.log(`    note: ${note}`);
  }
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
