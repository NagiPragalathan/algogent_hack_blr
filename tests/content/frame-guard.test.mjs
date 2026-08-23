/**
 * A subframe must not answer a broadcast meant for the page.
 *
 * `page-context.js` is declared on the top frame only, which is why it looked
 * safe — and `reachFrames` injects it into EVERY subframe the moment an agent
 * run starts, because the agent has to be able to see a form inside an iframe.
 * From then on, for the life of that tab, `chrome.tabs.sendMessage(tabId, msg)`
 * with no frameId settles on whichever frame answers first.
 *
 * Measured on a LinkedIn run: the context chip read *Sharing "reCAPTCHA" —
 * www.google.com · 12,000 chars* on a tab showing LinkedIn Jobs. A Google
 * reCAPTCHA iframe had won the race, so the page handed to the model was an
 * invisible challenge widget from another origin.
 *
 * The script is a classic content script with no imports, so the guard is lifted
 * out of the source and driven directly — the same trick `scrub.test.mjs` uses
 * for the adapter's copy of the citation rules.
 *
 * Run: node tests/content/frame-guard.test.mjs
 */

import fs from 'node:fs';

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`); }
};

const FILES = {
  'page-context.js': 'src/content/page-context.js',
  'agent-page.js': 'src/content/agent-page.js'
};

console.log('\nboth content scripts refuse an untargeted broadcast in a subframe');

for (const [name, path] of Object.entries(FILES)) {
  const src = fs.readFileSync(path, 'utf8');

  // The guard, as written in each file. Lifted rather than described, so a
  // rewrite that drops it fails here rather than in a browser six weeks later.
  const guard = /if \(window\.top !== window && !msg\??\.?frameTargeted\) return;/.exec(src);
  ok(`${name} has the guard`, Boolean(guard), 'no top-frame check in the message listener');

  if (!guard) continue;

  // Drive the exact line from the file, in both frames, both message shapes.
  const run = new Function(
    'window',
    'msg',
    `let out = 'answered'; (() => { ${guard[0].replace('return;', "out = 'ignored'; return;")} })(); return out;`
  );

  const top = { top: null };
  top.top = top;
  const sub = { top };

  ok(`${name}: the top frame answers a broadcast`, run(top, { type: 'X' }) === 'answered');
  ok(`${name}: a subframe ignores a broadcast`, run(sub, { type: 'X' }) === 'ignored');
  ok(
    `${name}: a subframe answers when addressed`,
    run(sub, { type: 'X', frameTargeted: true }) === 'answered'
  );
  ok(`${name}: the top frame still answers when addressed`,
    run(top, { type: 'X', frameTargeted: true }) === 'answered');
}

console.log('\nthe guard runs before anything else in the listener');

// Placed after a branch, it protects nothing: the branch above it has already
// answered from the wrong frame.
const ctx = fs.readFileSync(FILES['page-context.js'], 'utf8');
const listenerAt = ctx.indexOf('chrome.runtime.onMessage.addListener');
const guardAt = ctx.indexOf('window.top !== window', listenerAt);
const firstBranchAt = ctx.indexOf("if (msg?.type === 'PICK_ELEMENT')", listenerAt);

ok(
  'page-context.js: the guard is above the first branch',
  guardAt > listenerAt && guardAt < firstBranchAt,
  `listener ${listenerAt}, guard ${guardAt}, first branch ${firstBranchAt}`
);

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
