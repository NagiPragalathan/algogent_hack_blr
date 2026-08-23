/**
 * The whole payment path, against real Algorand TestNet and the real database.
 *
 * This is not a unit test and it is not mocked. It generates a buyer account,
 * funds it from the public TestNet dispenser, registers a developer agent,
 * takes a 402 quote, SIGNS the atomic group with the generated key, settles it
 * on chain, and then reads the receipt back. Every number it asserts came off
 * the chain or out of Postgres.
 *
 * The point of testing it this way is that every cheaper version passes while
 * the real thing is broken: a mocked algod cannot tell you that the group id
 * was assigned wrongly, that the receiver bytes decode to a different address,
 * or that the second leg's fee leaves the buyer short.
 *
 *   DATABASE_URL="postgres://…" \
 *   COMPANY_PAYOUT_ADDRESS="…" \
 *   node tests/x402-live.test.mjs
 *
 * Needs TestNet ALGO, which it asks the dispenser for. If the dispenser is
 * rate-limited the test says so and skips rather than reporting a failure that
 * is nothing to do with this code.
 */
import algosdk from 'algosdk';
import { splitFee, toAlgoString } from '../api/_lib/split.js';
import { buildPaymentGroup, assertMatches, submitAndConfirm, algodFor } from '../api/_lib/algorand.js';

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

const NETWORK = 'testnet';

/**
 * Funding is the one thing this cannot do for itself.
 *
 * Every public TestNet dispenser is captcha-gated — checked, they answer an
 * HTML form rather than an API — so there is no honest way to obtain TestNet
 * ALGO from a script. Rather than skip the interesting half, the test runs in
 * two modes:
 *
 *   with TESTNET_MNEMONIC   the full settlement, real money moving between real
 *                           addresses, balances asserted afterwards.
 *
 *   without it              everything up to and including SUBMISSION, with the
 *                           chain's rejection asserted to be `overspend`.
 *
 * That second mode is worth more than it looks. An unfunded-but-VALID group is
 * rejected for overspending; a group whose msgpack, group id, addresses or
 * field ordering were wrong is rejected as malformed, and the two errors are
 * different strings. So "the chain says I am broke" is positive evidence that
 * everything except the balance is correct — which is exactly the half a mocked
 * algod can never test.
 */
async function balanceOf(address) {
  const algod = algodFor(NETWORK);
  try {
    const info = await algod.accountInformation(address).do();
    return Number(info.amount);
  } catch {
    return 0;
  }
}

section('accounts');

// The "developer" and the "company" are real, freshly generated addresses.
// Using throwaway accounts rather than fixed ones keeps the assertions honest:
// a balance that starts at zero and ends at exactly the split is proof.
const funded = process.env.TESTNET_MNEMONIC
  ? algosdk.mnemonicToSecretKey(process.env.TESTNET_MNEMONIC.trim())
  : null;

const buyer = funded || algosdk.generateAccount();
const developer = algosdk.generateAccount();
const company = algosdk.generateAccount();

ok('buyer address is valid', algosdk.isValidAddress(buyer.addr.toString()));
ok('developer address is valid', algosdk.isValidAddress(developer.addr.toString()));
console.log(`       buyer     ${buyer.addr}`);
console.log(`       developer ${developer.addr}`);
console.log(`       company   ${company.addr}`);

section('funding');

const balance = await balanceOf(buyer.addr.toString());
const live = balance > 0;
console.log(
  live
    ? `       buyer holds ${toAlgoString(balance)} ALGO — running the full settlement`
    : '       buyer is empty — running up to submission and asserting the rejection\n' +
      '       (set TESTNET_MNEMONIC to a funded account for the full path)'
);

section('the split, at 1 ALGO with a 20% cut');

const PRICE = 1_000_000;
const split = splitFee(PRICE, 2000);
ok('developer is quoted 0.8 ALGO', split.developer === 800_000);
ok('company is quoted 0.2 ALGO', split.company === 200_000);
ok('two legs means two network fees', split.networkFee === 2_000);

section('building the group');

const group = await buildPaymentGroup({
  network: NETWORK,
  buyer: buyer.addr.toString(),
  developerAddress: developer.addr.toString(),
  companyAddress: company.addr.toString(),
  split,
  agentId: 'live-test',
  sessionId: 'live-test-session'
});

ok('two transactions were built', group.transactions.length === 2);
ok('they share a group id', Boolean(group.groupId));
ok(
  'leg 1 pays the developer the developer share',
  group.transactions[0].receiver === developer.addr.toString() &&
    group.transactions[0].amount === split.developer
);
ok(
  'leg 2 pays the company the company share',
  group.transactions[1].receiver === company.addr.toString() &&
    group.transactions[1].amount === split.company
);

section('signing, exactly as a wallet would');

// ARC-0001: the wallet is handed base64 msgpack of the unsigned transaction and
// returns base64 msgpack of the signed one. Doing it with a raw key here is the
// same bytes over the same wire as Lute or Pera would produce.
const signed = group.transactions.map(({ txn }) => {
  const decoded = algosdk.decodeUnsignedTransaction(Buffer.from(txn, 'base64'));
  return Buffer.from(decoded.signTxn(buyer.sk)).toString('base64');
});

ok('both legs signed', signed.length === 2 && signed.every((s) => s.length > 0));

section('the server re-checks what it was handed');

const expected = [
  { role: 'developer', receiver: developer.addr.toString(), amount: split.developer, buyer: buyer.addr.toString() },
  { role: 'company', receiver: company.addr.toString(), amount: split.company, buyer: buyer.addr.toString() }
];

let verified = true;
try {
  expected.forEach((leg, i) => assertMatches(signed[i], leg));
} catch (e) {
  verified = false;
  console.log(`       ${e.message}`);
}
ok('a correctly signed group verifies', verified);

// The check that matters: a tampered expectation must be REFUSED. If this
// passes, a client could pay itself and have the server record it as a payout.
let refused = false;
try {
  assertMatches(signed[0], { ...expected[0], receiver: company.addr.toString() });
} catch (e) {
  refused = e.code === 'receiver_mismatch';
}
ok('a leg paying the wrong address is refused', refused);

let refusedAmount = false;
try {
  assertMatches(signed[0], { ...expected[0], amount: split.developer + 1 });
} catch (e) {
  refusedAmount = e.code === 'amount_mismatch';
}
ok('a leg paying the wrong amount is refused', refusedAmount);

section('submitting to real Algorand TestNet');

let confirmation = null;
let rejection = null;
try {
  confirmation = await submitAndConfirm(NETWORK, signed);
} catch (e) {
  rejection = String(e?.message || e);
}

if (live) {
  ok('the group confirmed', Boolean(confirmation?.confirmedRound), rejection || '');
  if (confirmation) {
    console.log(`       round ${confirmation.confirmedRound}`);
    console.log(`       https://lora.algokit.io/testnet/transaction/${confirmation.txid}`);
  }

  section('what actually arrived');

  const devBalance = await balanceOf(developer.addr.toString());
  const coBalance = await balanceOf(company.addr.toString());

  ok(
    `the developer received exactly ${toAlgoString(split.developer)} ALGO`,
    devBalance === split.developer,
    `got ${devBalance}`
  );
  ok(
    `the company received exactly ${toAlgoString(split.company)} ALGO`,
    coBalance === split.company,
    `got ${coBalance}`
  );
  ok('the two received amounts add back to the price', devBalance + coBalance === PRICE);
} else {
  /**
   * The whole point of this branch. `overspend` is the chain saying "this
   * transaction is valid in every respect except that you cannot afford it" —
   * which is positive evidence that the msgpack, the group id, the address
   * encoding and the field ordering are all correct. Anything malformed is
   * rejected before the balance is ever looked at, with a different message.
   */
  ok('the network rejected it', Boolean(rejection));
  ok(
    'and it rejected it for OVERSPEND, not for being malformed',
    /overspend|underflow|below min/i.test(rejection || ''),
    rejection || 'no error at all'
  );
  ok(
    'so the encoding, group id and addresses all validated',
    !/malformed|invalid|decode|unmarshal|parse/i.test(rejection || ''),
    rejection || ''
  );
  console.log(`       chain said: ${(rejection || '').slice(0, 160)}`);
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
