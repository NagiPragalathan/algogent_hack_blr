/**
 * A tab the agent opens goes in a window the user can see.
 *
 * `chrome.tabs.create` with no `windowId` uses the LAST FOCUSED window, and for
 * most of every run that is the relay — it is a `type: 'normal'` window on
 * purpose (see relay.js) and it is restored and focused the instant a provider
 * tab is created or navigated in it. So `open_tab` put the run's pages in among
 * the provider tabs, which fails three ways at once:
 *
 *   - the user cannot see them;
 *   - `isRelayOwned` is true of them, so the run is refused the very page it
 *     just opened;
 *   - creating a tab in a MINIMIZED window restores it, so the relay is dragged
 *     onto the screen with Chrome's "started debugging this browser" bar over
 *     the top of it.
 *
 * Reported as exactly that: "the tabs are getting opened [in] the ChatGPT-opened
 * Chrome, not the Chrome for the chatting window."
 *
 * The fake browser below models Chrome's actual rule, so a bare `tabs.create`
 * really does land in the relay here — that is asserted first, because a test
 * whose fake cannot reproduce the bug proves nothing about the fix.
 *
 * Run: node tests/agent/new-tab-window.test.mjs
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

const RELAY_WIN = 99;

/** Rebuilt before each case, so one test cannot leak into the next. */
let browser;

function reset({ relayFocused = true, misplace = false, noUserWindows = false } = {}) {
  browser = {
    windows: new Map(),
    tabs: new Map(),
    nextTabId: 1000,
    nextWindowId: 500,
    created: [],
    moved: [],
    focusedWindows: [],
    createdWindows: [],
    /** Chrome ignores the requested windowId — the belt-and-braces case. */
    misplace
  };

  if (!noUserWindows) {
    browser.windows.set(1, { id: 1, type: 'normal', focused: false, state: 'normal' });
    browser.windows.set(2, { id: 2, type: 'normal', focused: false, state: 'normal' });
    browser.tabs.set(7, {
      id: 7,
      windowId: 2,
      url: 'https://example.com/',
      title: 'Example',
      status: 'complete'
    });
  }

  browser.windows.set(RELAY_WIN, {
    id: RELAY_WIN,
    type: 'normal',
    focused: relayFocused,
    state: 'minimized'
  });
  browser.tabs.set(900, {
    id: 900,
    windowId: RELAY_WIN,
    url: 'https://chatgpt.com/',
    title: 'ChatGPT',
    status: 'complete'
  });
}

reset();

const noop = { addListener() {}, removeListener() {} };

globalThis.chrome = {
  runtime: { onMessage: { addListener() {} }, lastError: null, id: 'test' },
  tabs: {
    get: async (id) => {
      const tab = browser.tabs.get(id);
      if (!tab) throw new Error('no such tab');
      return { ...tab };
    },
    query: async () => [...browser.tabs.values()].map((t) => ({ ...t })),
    create: async ({ windowId, url, active = false }) => {
      // Chrome's own rule: no windowId means the CURRENT window, which for an
      // extension worker is the last focused one. That is the bug.
      const focused = [...browser.windows.values()].find((w) => w.focused);
      let target = windowId ?? focused?.id ?? 1;
      if (browser.misplace) target = RELAY_WIN;

      // …and creating a tab in a minimized window pops it open.
      const win = browser.windows.get(target);
      if (win) win.state = 'normal';

      const tab = {
        id: browser.nextTabId++,
        windowId: target,
        url,
        title: url,
        status: 'complete',
        active
      };
      browser.tabs.set(tab.id, tab);
      browser.created.push({ ...tab, requestedWindowId: windowId ?? null });
      return { ...tab };
    },
    move: async (id, { windowId }) => {
      browser.moved.push({ id, windowId });
      const tab = browser.tabs.get(id);
      if (tab) tab.windowId = windowId;
      return tab ? { ...tab } : null;
    },
    update: async (id, props) => ({ ...browser.tabs.get(id), ...props }),
    remove: async () => {},
    group: async () => 1,
    ungroup: async () => {},
    captureVisibleTab: async () => 'data:image/jpeg;base64,AAAA',
    sendMessage: async (_id, msg) => {
      if (msg?.type === 'AGENT_PULSE') {
        return { ok: true, ready: 'complete', url: 'https://opened.example/', nodes: 10 };
      }
      return { ok: true };
    },
    onUpdated: noop,
    onCreated: noop,
    onRemoved: noop,
    onActivated: noop
  },
  tabGroups: { update: async () => {}, get: async () => ({}), TAB_GROUP_ID_NONE: -1 },
  windows: {
    getAll: async () => [...browser.windows.values()].map((w) => ({ ...w })),
    getLastFocused: async () => {
      const w = [...browser.windows.values()].find((x) => x.focused);
      return w ? { ...w } : null;
    },
    get: async (id) => ({ ...browser.windows.get(id) }),
    create: async ({ url, focused = false }) => {
      const id = browser.nextWindowId++;
      browser.windows.set(id, { id, type: 'normal', focused, state: 'normal' });
      const tab = {
        id: browser.nextTabId++,
        windowId: id,
        url,
        title: url,
        status: 'complete'
      };
      browser.tabs.set(tab.id, tab);
      browser.createdWindows.push({ id, url });
      return { id, tabs: [{ ...tab }] };
    },
    update: async (id, props) => {
      if (props?.focused) browser.focusedWindows.push(id);
      return { ...browser.windows.get(id), ...props };
    },
    onRemoved: noop
  },
  scripting: { executeScript: async () => [{ result: null }] },
  storage: {
    // Seeded so relay.js hydrates window 99 as ours the moment it is imported.
    session: {
      get: async () => ({
        relayState: {
          windowId: RELAY_WIN,
          windowIds: [RELAY_WIN],
          tabs: { chatgpt: 900 },
          revealReason: null
        }
      }),
      set: async () => {},
      remove: async () => {}
    },
    local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
    onChanged: { addListener() {} }
  },
  alarms: { create() {}, clear() {}, onAlarm: { addListener() {} } },
  debugger: { attach: async () => {}, detach: async () => {}, sendCommand: async () => {} },
  action: { setIcon() {} }
};

const { createUserTab, userWindowId } = await import('../../src/background/state/user-tabs.js');
const { isRelayWindow } = await import('../../src/background/relay.js');

console.log('\nthe fake browser reproduces the bug');

reset();
ok('window 99 hydrated as the relay', isRelayWindow(RELAY_WIN));
{
  const stray = await chrome.tabs.create({ url: 'https://github.com/', active: false });
  ok(
    'a bare tabs.create lands in the relay window',
    stray.windowId === RELAY_WIN,
    `went to ${stray.windowId}`
  );
  ok(
    'and it restores the minimized relay onto the screen',
    browser.windows.get(RELAY_WIN).state === 'normal'
  );
}

console.log('\ncreateUserTab picks a window of the user’s');

reset();
{
  const tab = await createUserTab('https://github.com/', { active: false });
  ok('never the relay window', tab.windowId !== RELAY_WIN, `went to ${tab.windowId}`);
  ok('the first ordinary window', tab.windowId === 1, `went to ${tab.windowId}`);
  ok(
    'and the relay is left minimized',
    browser.windows.get(RELAY_WIN).state === 'minimized'
  );
  ok('no focus was stolen for an inactive tab', browser.focusedWindows.length === 0);
}

console.log('\nnearTabId puts it beside the page it came from');

reset();
{
  const tab = await createUserTab('https://github.com/', { nearTabId: 7 });
  ok('follows the current tab into window 2', tab.windowId === 2, `went to ${tab.windowId}`);
}

reset();
{
  // The run's own tab should never be in the relay — but if it somehow is, the
  // answer is a user window, not "well, that window then".
  const tab = await createUserTab('https://github.com/', { nearTabId: 900 });
  ok('a relay tab is not a hint worth taking', tab.windowId !== RELAY_WIN);
}

reset();
{
  const tab = await createUserTab('https://github.com/', { nearTabId: 4242 });
  ok('a tab that no longer exists falls through', tab.windowId !== RELAY_WIN);
}

console.log('\nwhich of the user’s windows');

reset();
{
  browser.windows.get(2).focused = true;
  browser.windows.get(RELAY_WIN).focused = false;
  ok('focused wins', (await userWindowId()) === 2);
}

reset();
{
  browser.windows.get(1).state = 'minimized';
  ok(
    'a minimized window of theirs is skipped too',
    (await userWindowId()) === 2,
    'popping open the user’s own window is the same rudeness, one size smaller'
  );
}

reset();
{
  browser.windows.get(1).state = 'minimized';
  browser.windows.get(2).state = 'minimized';
  const win = await userWindowId();
  ok('but a minimized window still beats the relay', win === 1 || win === 2, `got ${win}`);
}

console.log('\nthe awkward cases');

reset({ noUserWindows: true });
{
  const tab = await createUserTab('https://github.com/', { active: false });
  ok('every window was ours, so a new one is made', browser.createdWindows.length === 1);
  ok('and the tab is in it', tab && tab.windowId !== RELAY_WIN, `went to ${tab?.windowId}`);
}

reset({ misplace: true });
{
  const tab = await createUserTab('https://github.com/', { active: false });
  ok('a misplaced tab is dragged back out of the relay', browser.moved.length === 1);
  ok('to the window it was asked for', browser.moved[0]?.windowId === 1);
  ok('and the tab object reflects it', tab.windowId === 1 || browser.tabs.get(tab.id).windowId === 1);
}

reset();
{
  await createUserTab('https://github.com/', { active: true });
  ok(
    'an active tab focuses its window',
    browser.focusedWindows.length === 1 && browser.focusedWindows[0] === 1,
    JSON.stringify(browser.focusedWindows)
  );
}

console.log('\nopen_tab, through the action layer');

const { performAction } = await import('../../src/background/agent/actions.js');

reset();
{
  const events = [];
  const changed = [];

  const result = await performAction({
    action: { action: 'open_tab', url: 'https://github.com/features/copilot', thought: 'read it' },
    step: 3,
    currentTab: 7,
    emit: (e) => events.push(e),
    confirm: async () => true,
    policy: 'auto',
    onTabChange: (id) => changed.push(id),
    onFrameChange: () => {}
  });

  const opened = browser.tabs.get(result.tabId);

  ok('the action reported a tab', result.tabId != null, JSON.stringify(result));
  ok(
    'open_tab does not open into the relay window',
    opened && opened.windowId !== RELAY_WIN,
    `went to ${opened?.windowId}`
  );
  ok('it opens beside the tab the run is on', opened?.windowId === 2, `went to ${opened?.windowId}`);
  ok('the relay stays minimized', browser.windows.get(RELAY_WIN).state === 'minimized');
  ok('the run moves onto it', changed[0] === result.tabId);
  ok(
    'and the step is reported as an open_tab',
    events.some((e) => e.type === 'AGENT_STEP' && e.kind === 'open_tab'),
    JSON.stringify(events.map((e) => e.kind))
  );
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
