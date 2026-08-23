/**
 * The survey costs a round trip, or it does not.
 *
 * The plan used to be its own provider turn — ten to forty seconds in front of
 * every run, producing a route and, by instruction, no action at all. This
 * drives `runAgent` with scripted replies and counts the asks: the first turn
 * must carry the survey format AND execute the actions that come back with it.
 *
 * `runAgent` takes `ask`, `emit`, `confirm` and `signal` as arguments precisely
 * so it can be driven like this. Nothing here touches a provider or a page.
 *
 * Run: node tests/agent/survey-turn.test.mjs
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

/** One screenful of a form, the shape a survey is actually for. */
const OBSERVATION = {
  ok: true,
  url: TAB.url,
  title: TAB.title,
  scroll: 0,
  moreBelow: false,
  viewport: { width: 1200, height: 800 },
  elements: [
    { id: 1, tag: 'input', role: 'textbox', label: 'Full name' },
    { id: 2, tag: 'input', role: 'textbox', label: 'Email' },
    { id: 3, tag: 'button', role: 'button', label: 'Submit application' }
  ],
  text: 'Apply for this role. Full name. Email. Submit application.',
  visual: { chars: 58, canvases: 0, images: 0, video: 0, frames: 0 },
  frames: []
};

/** Everything the run sends into the page. */
const toPage = [];

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
      toPage.push(msg);
      if (msg?.type === 'AGENT_OBSERVE') return { ok: true, observation: { ...OBSERVATION } };
      if (msg?.type === 'AGENT_PLAN') {
        const el = OBSERVATION.elements.find((e) => e.id === msg.action?.id);
        return { ok: true, description: `Typed "${msg.action?.text}" into "${el?.label}"`, risk: null };
      }
      if (msg?.type === 'AGENT_ACT') return { ok: true, note: 'typed' };
      if (msg?.type === 'AGENT_PULSE') return { ok: true, ready: 'complete', url: TAB.url, nodes: 40 };
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

/**
 * Drive one run to completion on a fixed script of replies.
 *
 * Returns every prompt that went out and every event that came back, which is
 * the whole of what this file asserts on.
 */
async function drive(task, replies) {
  const prompts = [];
  const events = [];
  let at = 0;
  toPage.length = 0;

  await runAgent({
    task,
    tabId: TAB.id,
    tabs: [TAB],
    ask: async (prompt) => {
      prompts.push(prompt);
      const text = replies[Math.min(at, replies.length - 1)];
      at += 1;
      return { text, imageDelivered: null, error: '' };
    },
    emit: (e) => events.push(e),
    confirm: async () => true,
    signal: { cancelled: false },
    policy: 'never',
    pacing: false
  });

  return { prompts, events };
}

const ROUTE = [
  '## Route',
  '1. Type the name into "Full name" and the address into "Email" — one turn.',
  '2. Press "Submit application" **alone**.',
  '',
  '## Done when',
  'The page says the application was received.',
  '',
  '## Missing',
  'nothing',
  '',
  '```json',
  '{"thought":"both fields are listed, so fill them together","actions":[',
  '  {"action":"type","id":1,"text":"Ada Lovelace"},',
  '  {"action":"type","id":2,"text":"ada@example.com"}',
  ']}',
  '```',
  '',
  '## Notes',
  '- This is a single-page job application with no account required.',
  '- The submit button sits directly under the two fields.'
].join('\n');

const FINISH = '```json\n{"thought":"the fields are filled","action":"finish","answer":"Filled it in."}\n```';

const TASK = 'Fill in this application form with my details and submit it.';

console.log('\none turn, not two');

const run = await drive(TASK, [ROUTE, FINISH]);
const steps = run.events.filter((e) => e.type === 'AGENT_STEP');
const plans = steps.filter((e) => e.kind === 'plan');

ok(
  'the first prompt asks for the route',
  /THIS IS YOUR FIRST TURN ON THIS PAGE/.test(run.prompts[0] || ''),
  (run.prompts[0] || '').slice(-160)
);
ok(
  'and it asks for the actions in the same reply',
  /SECOND, one fenced JSON block with the actions to carry out NOW/.test(run.prompts[0] || '')
);
ok(
  'the survey does not also demand a bare action block',
  !/Reply with ONE fenced ```json block containing an "action", and nothing/.test(run.prompts[0] || '')
);

ok('the survey was announced', plans.some((p) => p.description === 'Working out a plan'));
ok('the route came back and was shown', plans.some((p) => p.description === 'Plan ready'));

const shown = plans.find((p) => p.description === 'Plan ready')?.note || '';
ok('the shown route is the prose, not the JSON', shown.includes('## Route') && !shown.includes('"action"'), shown);
ok('the notes survive into it, for the page to show', shown.includes('## Notes'));

// The actions that travelled WITH the route were carried out — this is the
// round trip that used to be spent producing nothing.
const typed = steps.filter((e) => /Typed/i.test(e.description || ''));
ok('the actions in the survey reply ran', typed.length === 2, steps.map((s) => s.description).join(' | '));

ok(
  'the run reached the provider twice, not three times',
  run.prompts.length === 2,
  `${run.prompts.length} prompts`
);

console.log('\nthe route is carried, not re-derived');

ok(
  'the second prompt repeats it as YOUR PLAN',
  /YOUR PLAN/.test(run.prompts[1] || '') && (run.prompts[1] || '').includes('Press "Submit application"')
);
ok(
  'and stops asking for a route once it has one',
  !/THIS IS YOUR FIRST TURN ON THIS PAGE/.test(run.prompts[1] || '')
);

console.log('\nthe route travels, the notes do not');

// Twenty lines of site trivia in front of the two lines that matter, in every
// one of up to forty prompts, is what this splits.
ok(
  'the repeated block is the route alone',
  !/## Notes/.test(run.prompts[1] || ''),
  (run.prompts[1] || '').slice(0, 200)
);

const notes = toPage.find((m) => m?.type === 'AGENT_NOTES')?.notes || [];
ok(
  'and the notes still reach the page for the waits',
  notes.length === 2,
  JSON.stringify(notes)
);

console.log('\na bare action is not a plan');

// A model that skips the prose entirely must not have its one-line `thought`
// stored and replayed for the rest of the run as the route it checked against
// a picture of the whole page.
const bare = await drive(TASK, [
  '```json\n{"thought":"just fill it in","action":"type","id":1,"text":"Ada"}\n```',
  FINISH
]);
ok(
  'no route means no YOUR PLAN block',
  !/YOUR PLAN/.test(bare.prompts[1] || ''),
  (bare.prompts[1] || '').slice(0, 120)
);
ok(
  'and it is not asked for a second time',
  !/THIS IS YOUR FIRST TURN ON THIS PAGE/.test(bare.prompts[1] || '')
);

console.log('\na look-up still skips the survey entirely');

const lookup = await drive('Tell me what this page says about the salary.', [FINISH]);
ok(
  'no route was asked for',
  !/THIS IS YOUR FIRST TURN ON THIS PAGE/.test(lookup.prompts[0] || '')
);
ok(
  'and the ordinary closing is intact',
  /Reply with ONE fenced ```json block containing an "action", and nothing/.test(lookup.prompts[0] || '')
);

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
