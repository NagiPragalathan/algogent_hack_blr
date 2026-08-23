/**
 * A research run must not spend its budget arriving somewhere twice.
 *
 * The measured failure, from a run given "Best AI coding assistants 2026":
 * 25 steps, roughly eight minutes, and inside it —
 *
 *   - zapier.com/blog/best-ai-coding-assistant/ is a 404. The run opened it
 *     FOUR times and spent THREE screenshots on it (22s, 17s, 16s), out of a
 *     whole-run budget of six.
 *   - the identical Google query was navigated to three separate times.
 *   - meanwhile `read_url` had returned one of the real articles in 0.2s, and
 *     was then abandoned for tab-opening.
 *
 * Nothing in the loop could catch any of it. A 404 loads perfectly well — the
 * navigation succeeds, the DOM is there, no step fails — and it is short and
 * decorative, which is precisely the fingerprint `unreadableReason` exists to
 * photograph. So the run was told "an embedded document or frame with no
 * readable text", which reads as "try again" rather than "this does not exist".
 *
 * Run: node tests/agent/dead-ends.test.mjs
 */

import { readFileSync } from 'node:fs';
import { closing } from '../../src/background/agent/protocol.js';

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
const section = (name) => console.log(`\n${name}`);

/**
 * `deadPage` is module-private in loop.js and importing the module would drag
 * in the whole background graph, so it is lifted out of the source the same way
 * `scrub.test.mjs` lifts its copy out of adapter.js. Brittle on purpose: if the
 * function is renamed the test fails loudly rather than silently testing
 * nothing.
 */
const source = readFileSync(new URL('../../src/background/agent/loop.js', import.meta.url), 'utf8');

const lift = (name, pattern) => {
  const match = source.match(pattern);
  if (!match) {
    console.log(`  FAIL could not lift ${name} out of loop.js`);
    process.exit(1);
  }
  return match[0];
};

const deadPage = new Function(
  `${lift('READABLE_CHARS', /const READABLE_CHARS = \d+;/)}
   ${lift('DEAD_PAGE', /const DEAD_PAGE =\s*\/[\s\S]*?\/i;/)}
   ${lift('DEAD_PAGE_CHARS', /const DEAD_PAGE_CHARS = [^;]+;/)}
   ${lift('deadPage', /function deadPage\(observation\) \{[\s\S]*?\n\}/)}
   return deadPage;`
)();

const page = (text, { title = '', chars = null } = {}) => ({
  title,
  text,
  visual: { chars: chars ?? text.length }
});

section('the page that cost three screenshots');

// Verbatim from the Zapier 404 in the reported run.
const zapier404 = page('404\n\nOops! It looks like something went wrong.\n\nBack to Zapier Blog', {
  title: 'Zapier'
});
ok('a 404 is recognised as a dead link', Boolean(deadPage(zapier404)));
ok(
  'and it is named as a dead link, not as an unreadable one',
  /dead link/.test(deadPage(zapier404) || ''),
  deadPage(zapier404) || 'null'
);

ok(
  'a "page not found" with no status number is caught too',
  Boolean(deadPage(page('Page not found. The page you requested has moved.')))
);
ok(
  'so is a 403',
  Boolean(deadPage(page('403 Forbidden')))
);

section('what must NOT be called dead');

ok(
  'a real article is left alone',
  deadPage(
    page('Cursor is an AI-first code editor built on VS Code. '.repeat(30))
  ) === null
);

/**
 * The half that keeps the rule honest. "went wrong" and "not found" appear in
 * ordinary prose constantly, so wording alone would condemn a real page — the
 * length test is what separates an error page from an article about them.
 */
ok(
  'a long article that MENTIONS 404s is not a dead link',
  deadPage(
    page(
      'Everything you need to know about the 404 status code and why pages go missing. '.repeat(20)
    )
  ) === null,
  'the length guard did not hold'
);

ok(
  'a short page with no error wording is not a dead link',
  deadPage(page('Sign in to continue.')) === null
);

ok(
  'an observation with no text at all is not a dead link',
  deadPage(page('')) === null
);

section('the ledger the model reads every turn');

const visited = new Map([
  ['https://zapier.com/blog/best-ai-coding-assistant/', 'dead link'],
  ['https://www.faros.ai/blog/best-ai-coding-agents-2026', 'read']
]);

const withLedger = closing('compare the best AI coding assistants', '', { visited });

ok('the block is rendered', withLedger.includes('PAGES THIS RUN HAS ALREADY BEEN TO'));
ok('the dead URL is listed', withLedger.includes('zapier.com/blog/best-ai-coding-assistant/'));
ok(
  'with its verdict, because "already visited" alone invites a re-check',
  withLedger.includes('— dead link')
);
ok('and the one that worked is listed as read', withLedger.includes('— read'));

ok(
  'no ledger block on the first turn, when there is nothing to say',
  !closing('anything', '', { visited: new Map() }).includes('PAGES THIS RUN')
);

// An unbounded list would grow past the useful part of the prompt on a long
// run, and the pages that matter to the next decision are the recent ones.
const many = new Map(
  Array.from({ length: 30 }, (_, i) => [`https://example.com/${i}`, 'read'])
);
const capped = closing('anything', '', { visited: many });
ok('a long run caps the list', capped.includes('and 18 earlier'));
ok('and keeps the NEWEST entries', capped.includes('example.com/29'));
ok('rather than the oldest', !capped.includes('example.com/0\n'));

section('steering a reading task onto the fast road');

const research = closing('compare the best AI coding assistants 2026', '', { research: true });
ok('the reading block fires', research.includes('THIS TASK IS READING, NOT CLICKING'));
ok('it names read_url', research.includes('"action":"read_url"'));
ok(
  'and it asks for them BATCHED — one round trip, not one per source',
  research.includes('"actions":[')
);
ok(
  'it says not to re-run a search already run',
  /Do not search again/.test(research)
);

/**
 * The trigger is narrow on purpose. A form-filling run that reached for
 * read_url instead of clicking would be worse than slow — it would be wrong.
 */
const acting = closing('click the apply button and submit the form', '', {});
ok('and it stays off an acting task', !acting.includes('THIS TASK IS READING'));

section('the blocks compose rather than replace');

const both = closing('research the best tools', '', { visited, research: true, blind: true });
ok('ledger survives', both.includes('PAGES THIS RUN HAS ALREADY BEEN TO'));
ok('reading block survives', both.includes('THIS TASK IS READING'));
ok('the no-camera block survives', both.includes('THERE IS NO CAMERA ON THIS RUN'));
ok(
  'and the format demand is still the LAST thing read',
  both.trimEnd().endsWith('{"action":"finish","answer":"…"}.'),
  JSON.stringify(both.trimEnd().slice(-80))
);

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
