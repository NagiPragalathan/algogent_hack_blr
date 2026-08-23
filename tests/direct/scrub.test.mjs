/**
 * Citation scaffolding must never reach the reader.
 *
 * ChatGPT emits its source references as markup its own web client is supposed
 * to turn into little chips. Reading the endpoint means reading the text BEFORE
 * that happens, and there is a second form the client leaves behind even in the
 * page when a citation does not resolve — so both roads can carry it out.
 *
 * The measured failure, verbatim from a train-fares run:
 *
 *   "…and another ₹1,046–₹1,931. :contentReference[oaicite:0]{index=0}
 *    :contentReference[oaicite:1]{index=1}"
 *
 * printed into the panel under the answer. In an agent run it is worse than
 * cosmetic: the answer is a JSON string and this lands inside it, so it is
 * saved with the conversation.
 *
 * The half that matters as much as the stripping is what must SURVIVE. An
 * earlier version of the span rule ate real text — "Runway offers 125 credits on
 * the free tier" came out as "Runway offers 125 credits" — so every rule here
 * is checked against prose that looks like it and must not be touched.
 *
 * Run: node tests/direct/scrub.test.mjs
 */

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

globalThis.chrome = {
  storage: {
    local: { get: async () => ({}), set: async () => {} },
    session: { get: async () => ({}), set: async () => {} }
  },
  declarativeNetRequest: { updateSessionRules: async () => {}, getSessionRules: async () => [] },
  cookies: { get: async () => null, getAll: async () => [] },
  runtime: { id: 'test' }
};

const { scrub } = await import('../../src/background/transport/direct/chatgpt.js');

console.log('\nthe reported failure');

const REPORTED =
  'Bengaluru to Chennai train ticket prices vary by train and class. For the ' +
  'displayed Mon 24 Aug results, one train showed ₹323–₹806 and another ' +
  '₹1,046–₹1,931. :contentReference[oaicite:0]{index=0} ' +
  ':contentReference[oaicite:1]{index=1}';

const cleaned = scrub(REPORTED);
ok('the contentReference markup is gone', !cleaned.includes('contentReference'), cleaned);
ok('so is the oaicite token', !cleaned.includes('oaicite'), cleaned);
ok(
  'and the answer itself is untouched',
  cleaned.endsWith('₹1,046–₹1,931.') && cleaned.startsWith('Bengaluru to Chennai'),
  cleaned
);

console.log('\nthe other shapes');

const cases = [
  ['a span between the private-use delimiters', 'citeturn0search1', ''],
  ['a span still arriving', 'The answer so farciteturn0', 'The answer so far'],
  ['a bare marker welded to a word', 'the free tierciteturn0search3', 'the free tier'],
  ['a bare file reference', 'lines 5-8fileciteturn0file0', 'lines 5-8'],
  ['one contentReference', 'Fares from ₹130. :contentReference[oaicite:0]{index=0}', 'Fares from ₹130.'],
  ['a contentReference with no colon', 'Done contentReference[oaicite:9]{index=9}', 'Done'],
  ['the bracket form', 'See the docs 【oaicite:0†source】', 'See the docs'],
  ['a bracket form naming a file', 'It says so 【4:1†report.pdf】', 'It says so']
];

for (const [name, input, want] of cases) {
  const got = scrub(input);
  ok(name, got === want, `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
}

console.log('\nwhat must survive');

// Each of these has looked strippable to one version of one of these rules.
const keep = [
  'Runway offers 125 credits on the free tier',
  'The book is called 【NAME】 in Japanese',
  'Use turn0 as the variable name',
  'The index is {index: 0} in the config',
  'Cite the source properly',
  'contentReference is a term of art, apparently',
  'A dagger † on its own is fine',
  'Costs ₹1,046–₹1,931 depending on class'
];

for (const text of keep) {
  const got = scrub(text);
  ok(`kept: "${text.slice(0, 44)}…"`, got === text, `became ${JSON.stringify(got)}`);
}

console.log('\nthe adapter keeps its own copy, and it must not drift');

/**
 * `adapters/adapter.js` is a classic content script and cannot import, so it
 * carries the same rules by hand. Two copies of a regex drift — that is written
 * down in AGENTS.md about a different pair and it is just as true here — and the
 * drift is silent: one road strips the scaffolding, the other prints it.
 *
 * So the copy is lifted out of the file and driven over the same table. It does
 * not need a DOM: `SCAFFOLD` and `scrubScaffold` are pure.
 */
const adapterSrc = await import('node:fs').then((fs) =>
  fs.readFileSync('src/adapters/adapter.js', 'utf8')
);

const from = adapterSrc.indexOf('  const SCAFFOLD = [');
const to = adapterSrc.indexOf('  function nodeText(el)');

let adapterScrub = null;
if (from > 0 && to > from) {
  // eslint-disable-next-line no-new-func
  adapterScrub = new Function(
    adapterSrc.slice(from, to) + '\nreturn scrubScaffold;'
  )();
}

ok('the adapter copy is where the test expects it', typeof adapterScrub === 'function');

if (adapterScrub) {
  for (const [name, input, want] of cases) {
    ok(`adapter: ${name}`, adapterScrub(input) === want, JSON.stringify(adapterScrub(input)));
  }
  for (const text of keep) {
    ok(`adapter kept: "${text.slice(0, 34)}…"`, adapterScrub(text) === text,
      JSON.stringify(adapterScrub(text)));
  }
  ok(
    'adapter: the reported failure',
    !adapterScrub(REPORTED).includes('contentReference'),
    adapterScrub(REPORTED)
  );
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
