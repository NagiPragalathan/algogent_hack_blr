/**
 * The one-run-at-a-time slot, driven for real.
 *
 * These are the two failures behind "An agent run is already going. Stop it
 * first." appearing in a chat with no Stop button on screen: a run that has
 * been cancelled still holding the slot while its last provider round trip
 * unwinds, and two AGENT_RUNs racing through the gap between the check and the
 * claim. Both are timing, so both need the real module rather than a rewrite of
 * its logic — the point is that `startAgentRun` awaits three things before it
 * used to claim anything.
 *
 * Run: node tests/agent/run-slot.test.mjs
 */

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`); }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A tab the agent is allowed to drive, and page calls that never answer. */
const TAB = { id: 7, url: 'https://example.com/', title: 'Example' };

let pageCallsHang = true;
const neverSettles = () => new Promise(() => {});

globalThis.chrome = {
  runtime: { onMessage: { addListener() {} }, lastError: null, id: 'test' },
  tabs: {
    get: async (id) => (id === TAB.id ? { ...TAB } : null),
    query: async () => [{ ...TAB }],
    create: async () => ({ ...TAB }),
    update: async () => ({ ...TAB }),
    remove: async () => {},
    sendMessage: () => (pageCallsHang ? neverSettles() : Promise.resolve({ ok: true })),
    onUpdated: { addListener() {}, removeListener() {} },
    onCreated: { addListener() {}, removeListener() {} },
    onRemoved: { addListener() {}, removeListener() {} },
    onActivated: { addListener() {}, removeListener() {} },
    group: async () => 1,
    ungroup: async () => {}
  },
  tabGroups: { update: async () => {}, get: async () => ({}), TAB_GROUP_ID_NONE: -1 },
  windows: {
    getAll: async () => [{ id: 1, focused: true, type: 'normal' }],
    create: async () => ({ id: 2, tabs: [{ ...TAB }] }),
    update: async () => {},
    remove: async () => {},
    getLastFocused: async () => ({ id: 1 }),
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
  contextMenus: { create() {}, removeAll(cb) { cb?.(); }, onClicked: { addListener() {} } }
};

const { startAgentRun, cancelAgentRun, isAgentRunning } =
  await import('../../src/background/agent/run.js');

const providers = {
  chatgpt: { id: 'chatgpt', name: 'ChatGPT', enabled: true, selectors: {}, homeUrl: 'https://chatgpt.com/' }
};
const settings = { agentPolicy: 'never', safePacing: false, providerTransport: {} };

/** Start a run and collect everything it posts back. */
function start(task, runId) {
  const posts = [];
  const done = startAgentRun({
    msg: { runId, task, providerId: 'chatgpt', tabId: TAB.id, sessionId: 's1', policy: 'never' },
    settings,
    providers,
    post: (m) => posts.push(m)
  });
  return { posts, done };
}

const errorsIn = (posts) => posts.filter((p) => p.type === 'AGENT_ERROR').map((p) => p.error);

console.log('\nthe slot');

// 1. A live run holds it, and says which one.
const a = start('Open Wikipedia and search for Artificial Intelligence.', 'r1');
await sleep(300);
ok('a run claims the slot', isAgentRunning());

const b = start('hyy', 'r2');
await b.done;
const refusal = errorsIn(b.posts)[0] || '';
ok('a LIVE run still refuses a second', refusal.includes('already going'), refusal);
ok('the refusal names the running task', refusal.includes('Open Wikipedia'), refusal);
ok('the refusal points somewhere real', refusal.includes('Recent chats'), refusal);
ok('the refused run releases the composer',
  b.posts.some((p) => p.type === 'AGENT_FINISHED' && p.runId === 'r2'));
ok('the refusal did not steal the slot', isAgentRunning());

// 2. Cancel it. The slot is still held while the loop unwinds — and that is
//    exactly the window the old code refused in.
console.log('\nafter Stop');
cancelAgentRun();
ok('cancelling does not instantly clear the slot', isAgentRunning());

const c = start('hyy', 'r3');
await sleep(600);
const cErrors = errorsIn(c.posts);
ok('a stopping run is taken over, not refused',
  !cErrors.some((e) => e.includes('already going')), cErrors.join(' | '));
ok('the new run holds the slot', isAgentRunning());

// 3. The old run unwinding must not pull the new one's slot out.
console.log('\nhandover');
pageCallsHang = false;
await sleep(400);
ok('the superseded run left the live one alone', isAgentRunning());

// 4. Two arriving together — the race between the check and the claim.
console.log('\nthe race');
cancelAgentRun();
await sleep(8500);
ok('the cancelled run eventually clears', !isAgentRunning());

pageCallsHang = true;
const d = start('one', 'r4');
const e = start('two', 'r5');
await sleep(400);
const both = [...errorsIn(d.posts), ...errorsIn(e.posts)];
ok('only one of two simultaneous runs starts',
  both.filter((x) => x.includes('already going')).length === 1, both.join(' | '));

cancelAgentRun();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
