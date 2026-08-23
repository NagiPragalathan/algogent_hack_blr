/**
 * When a run may take the fast path without a camera, and when it may not.
 *
 * Claude, Meta AI and NoTrack have engines but no uploader, so every agent run
 * on them used to go through the provider window — ten to forty seconds a turn,
 * thirty turns — to keep a capability most runs never use. Vision is rationed to
 * MAX_AUTO_LOOKS precisely because a screenshot is the most expensive thing in a
 * turn; the ordinary form-or-search run never takes one.
 *
 * The transport is still fixed once per run. What is tested here is that the
 * decision is made from real evidence — the page and the task — and that a run
 * which gives up its camera is TOLD so, every turn, rather than discovering it
 * by being refused.
 *
 * Run: node tests/agent/blind-transport.test.mjs
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

const TAB = { id: 7, url: 'https://jobs.example.com/apply', title: 'Apply — Example' };

/** An ordinary form: plenty of text, nothing the DOM cannot describe. */
const READABLE = {
  ok: true,
  url: TAB.url,
  title: TAB.title,
  scroll: 0,
  moreBelow: false,
  viewport: { width: 1200, height: 800 },
  elements: [
    { id: 1, tag: 'input', role: 'textbox', label: 'Full name' },
    { id: 2, tag: 'button', role: 'button', label: 'Submit application' }
  ],
  text: 'Apply for this role. '.repeat(40),
  visual: { chars: 840, canvas: 0, image: 0, video: 0, embed: 0 },
  frames: []
};

/** A page that is pixels: the case where losing the camera loses the run. */
const UNREADABLE = {
  ...READABLE,
  text: 'Loading',
  visual: { chars: 7, canvas: 2, image: 0, video: 0, embed: 0 }
};

let observation = READABLE;

globalThis.chrome = {
  runtime: { onMessage: { addListener() {} }, lastError: null, id: 'test' },
  tabs: {
    get: async () => ({ ...TAB }),
    query: async () => [{ ...TAB, active: true, windowId: 1 }],
    update: async () => ({ ...TAB }),
    create: async () => ({ ...TAB }),
    remove: async () => {},
    captureVisibleTab: async () => 'data:image/jpeg;base64,AAAA',
    group: async () => 1,
    ungroup: async () => {},
    sendMessage: async (_id, msg) => {
      if (msg?.type === 'AGENT_OBSERVE') return { ok: true, observation: { ...observation } };
      if (msg?.type === 'AGENT_PLAN') return { ok: true, description: 'did a thing', risk: null };
      if (msg?.type === 'AGENT_ACT') return { ok: true, note: 'ok' };
      if (msg?.type === 'AGENT_PULSE')
        return { ok: true, ready: 'complete', url: TAB.url, nodes: 40 };
      return { ok: true };
    },
    onUpdated: { addListener() {}, removeListener() {} },
    onCreated: { addListener() {}, removeListener() {} },
    onRemoved: { addListener() {}, removeListener() {} },
    onActivated: { addListener() {}, removeListener() {} }
  },
  tabGroups: { update: async () => {}, get: async () => ({}), TAB_GROUP_ID_NONE: -1 },
  windows: {
    getAll: async () => [{ id: 1, focused: true, type: 'normal' }],
    getLastFocused: async () => ({ id: 1, focused: true }),
    get: async () => ({ id: 1, focused: true }),
    update: async () => {},
    onRemoved: { addListener() {} }
  },
  scripting: { executeScript: async () => [{ result: null }] },
  storage: {
    local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
    session: { get: async () => ({}), set: async () => {}, remove: async () => {} },
    onChanged: { addListener() {} }
  },
  alarms: { create() {}, clear() {}, onAlarm: { addListener() {} } },
  debugger: { attach: async () => {}, detach: async () => {}, sendCommand: async () => {} },
  action: { setIcon() {} }
};

const { runAgent } = await import('../../src/background/agent/loop.js');

const FINISH =
  '```json\n{"thought":"nothing to do here","action":"finish","answer":"Done."}\n```';

/**
 * Drive one run and report what the transport decision was asked, what it was
 * told, and what went out in the prompts.
 */
async function drive(task, { blind = false, page = READABLE, blankStart = false } = {}) {
  observation = page;

  const prompts = [];
  const events = [];
  let asked = null;

  await runAgent({
    task,
    tabId: TAB.id,
    tabs: [TAB],
    blankStart,
    decideTransport: (q) => {
      asked = q;
      return { direct: true, blind };
    },
    ask: async (prompt) => {
      prompts.push(prompt);
      return { text: FINISH, imageDelivered: null, error: '' };
    },
    emit: (e) => events.push(e),
    confirm: async () => true,
    signal: { cancelled: false },
    policy: 'never',
    pacing: false
  });

  return { prompts, events, asked };
}

console.log('\nwhen a camera is wanted');

const form = await drive('Fill in this application form and submit it.');
ok('an ordinary form does not need one', form.asked?.needsVision === false, JSON.stringify(form.asked));

const canvas = await drive('Fill in this application form and submit it.', { page: UNREADABLE });
ok(
  'a page the DOM cannot describe does',
  canvas.asked?.needsVision === true,
  JSON.stringify(canvas.asked)
);

// The user naming visual work is the other half: the page may read perfectly
// well and the task still be about what it looks like.
for (const task of [
  'Edit the canvas on this page',
  'Read this PDF and summarise it',
  'What does the chart show?',
  'Play the video and tell me what happens',
  'Check the colours in this design',
  'Crop the image at the top'
]) {
  const run = await drive(task);
  ok(`"${task}" keeps the camera`, run.asked?.needsVision === true);
}

// …and the ordinary ones must not, or nothing is ever fast.
for (const task of [
  'Fill in this application form and submit it.',
  'Find the cheapest flight on this page and book it',
  'Log in and download the invoice',
  'Search for fullstack jobs and apply to the first three'
]) {
  const run = await drive(task);
  ok(`"${task}" does not`, run.asked?.needsVision === false);
}

console.log('\na blind run is told, not left to find out');

const nocam = await drive('Fill in this application form and submit it.', { blind: true });

ok(
  'the prompt says there is no camera',
  /THERE IS NO CAMERA ON THIS RUN/.test(nocam.prompts[0] || ''),
  (nocam.prompts[0] || '').slice(-300)
);
ok(
  'and says not to guess coordinates, which is the failure next door',
  /Never guess at x\/y/.test(nocam.prompts[0] || '')
);
ok(
  'the timeline says why the run is fast',
  nocam.events.some(
    (e) => e.type === 'AGENT_STEP' && e.description === 'Working from the page text'
  ),
  nocam.events
    .filter((e) => e.type === 'AGENT_STEP')
    .map((e) => e.description)
    .join(' | ')
);

const seeing = await drive('Fill in this application form and submit it.');
ok(
  'a run that kept its camera is told none of this',
  !/THERE IS NO CAMERA ON THIS RUN/.test(seeing.prompts[0] || '')
);
ok(
  'and its timeline says nothing about it either',
  !seeing.events.some(
    (e) => e.type === 'AGENT_STEP' && e.description === 'Working from the page text'
  )
);

console.log('\nthe placeholder start page does not decide anything');

// google.com reads as an unreadable frame — it is a handful of frames around a
// search box. Letting that answer the question would drag every blank-start run
// onto the window over a page the task is not about.
const blank = await drive('Fill in this application form and submit it.', {
  page: UNREADABLE,
  blankStart: true
});
ok(
  'a blank start is judged on the task alone',
  blank.asked?.needsVision === false,
  JSON.stringify(blank.asked)
);

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
