/**
 * A greeting must not take over the browser.
 *
 * Typed with Agent Mode still on from the last question, "hyy" opened a start
 * page, photographed it, and searched Google for "hyy" — because a model handed
 * a browser and told to act will act, and there is no goal here that could ever
 * count as met. The run goes to MAX_STEPS with a curtain over the page.
 *
 * Two halves are tested: the shape test itself, which must be narrow enough to
 * let "hi, open my gmail" through, and the preflight, which must answer without
 * touching a tab.
 *
 * Run: node tests/agent/not-a-task.test.mjs
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TAB = { id: 7, url: 'https://example.com/', title: 'Example' };

/** Everything the preflight would do to the browser, if it did anything. */
const touched = { created: 0, updated: 0, grouped: 0, messaged: 0 };

globalThis.chrome = {
  runtime: { onMessage: { addListener() {} }, lastError: null, id: 'test' },
  tabs: {
    get: async () => ({ ...TAB }),
    query: async () => [{ ...TAB, active: true, windowId: 1 }],
    create: async () => {
      touched.created += 1;
      return { ...TAB };
    },
    update: async () => {
      touched.updated += 1;
      return { ...TAB };
    },
    remove: async () => {},
    sendMessage: async () => {
      touched.messaged += 1;
      return { ok: true };
    },
    group: async () => {
      touched.grouped += 1;
      return 1;
    },
    ungroup: async () => {},
    onUpdated: { addListener() {}, removeListener() {} },
    onCreated: { addListener() {}, removeListener() {} },
    onRemoved: { addListener() {}, removeListener() {} },
    onActivated: { addListener() {}, removeListener() {} }
  },
  tabGroups: { update: async () => {}, get: async () => ({}), TAB_GROUP_ID_NONE: -1 },
  windows: {
    getAll: async () => [{ id: 1, focused: true, type: 'normal' }],
    getLastFocused: async () => ({ id: 1 }),
    get: async () => ({ id: 1, focused: true }),
    create: async () => ({ id: 2, tabs: [{ ...TAB }] }),
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
  declarativeNetRequest: { updateSessionRules: async () => {}, getSessionRules: async () => [] },
  offscreen: { createDocument: async () => {}, hasDocument: async () => false },
  sidePanel: { setOptions: async () => {}, setPanelBehavior: async () => {} },
  action: { setIcon() {}, onClicked: { addListener() {} } },
  contextMenus: {
    create() {},
    removeAll(cb) {
      cb?.();
    },
    onClicked: { addListener() {} }
  }
};

const { startAgentRun, isNotATask, cancelAgentRun } = await import(
  '../../src/background/agent/run.js'
);

console.log('\nwhat counts as a task');

// The ones people actually type. A fixed word list catches none of these, which
// is how "hyy" reached the browser in the first place.
for (const input of [
  'hyy',
  'hi',
  'hii',
  'hey',
  'heyyy',
  'hello',
  'helloo',
  'hlo',
  'yo',
  'ok',
  'okkk',
  'okay',
  'thanks',
  'thx',
  'test',
  'hmm',
  'asdf',
  'yes',
  'no',
  'bye',
  '   ',
  '???',
  'hyy!!'
]) {
  ok(`"${input}" is not a task`, isNotATask(input));
}

// Everything below is a real instruction and must reach the browser. The two
// that matter most are the greeting with an instruction after it, and the short
// imperative — the shape a narrow test is most likely to swallow.
for (const input of [
  'hi, open my gmail',
  'hey read the top 5 unread messages',
  'open gmail',
  'search',
  'click apply',
  'summarise',
  'help',
  'refresh',
  'fill in this form from my CV',
  'ok now publish it'
]) {
  ok(`"${input}" IS a task`, !isNotATask(input), 'wrongly refused');
}

console.log('\nthe preflight answers without touching the browser');

const providers = {
  chatgpt: {
    id: 'chatgpt',
    name: 'ChatGPT',
    enabled: true,
    selectors: {},
    homeUrl: 'https://chatgpt.com/'
  }
};
const settings = { agentPolicy: 'never', safePacing: false, providerTransport: {} };

const posts = [];
await startAgentRun({
  msg: {
    runId: 'r1',
    task: 'hyy',
    providerId: 'chatgpt',
    tabId: TAB.id,
    sessionId: 's1',
    policy: 'never'
  },
  settings,
  providers,
  post: (m) => posts.push(m)
});

const done = posts.find((p) => p.type === 'AGENT_DONE');
ok('it answers rather than erroring', Boolean(done) && !posts.some((p) => p.type === 'AGENT_ERROR'));
// One line, not a lecture: this is answering a greeting, and the first
// version delivered three worked examples every time — twice in a row to
// somebody who typed "hyy" twice.
ok('and says what to type instead', /tell me what to do on this page/i.test(done?.answer || ''), done?.answer);
ok('in one line, not a lecture', (done?.answer || '').length < 140, String((done?.answer || '').length));
ok(
  'the composer is released',
  posts.some((p) => p.type === 'AGENT_FINISHED' && p.runId === 'r1')
);
ok('no step was ever run', done?.steps === 0, String(done?.steps));
ok(
  'nothing was opened, navigated or grouped',
  touched.created === 0 && touched.updated === 0 && touched.grouped === 0,
  JSON.stringify(touched)
);
ok('the page was never taken over', touched.messaged === 0, String(touched.messaged));

// And the slot is free: a refusal that kept it would block the real task the
// user types next.
const after = [];
const real = startAgentRun({
  msg: {
    runId: 'r2',
    task: 'open my gmail and read the top 5 unread messages',
    providerId: 'chatgpt',
    tabId: TAB.id,
    sessionId: 's1',
    policy: 'never'
  },
  settings,
  providers,
  post: (m) => after.push(m)
});
await sleep(300);
ok(
  'the real task right after it is not refused',
  !after.some((p) => p.type === 'AGENT_ERROR' && /already going/.test(p.error || '')),
  after
    .filter((p) => p.type === 'AGENT_ERROR')
    .map((p) => p.error)
    .join(' | ')
);

cancelAgentRun();
await real.catch(() => {});
// Let the cancelled run finish unwinding before the process goes: exiting on
// top of its pending handles is a libuv assertion, not a test failure, but it
// reads exactly like one.
await sleep(400);

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
