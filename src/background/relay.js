/**
 * Relay window management.
 *
 * The providers all send `frame-ancestors`/`X-Frame-Options` headers that make
 * embedding them in an iframe impossible, so the extension instead keeps one
 * real tab per provider inside a dedicated popup window. That window is parked
 * out of the way (minimized or offscreen) and is only ever brought forward when
 * you need to log in or when you ask to watch what the adapters are doing.
 *
 * Two rules keep that from multiplying into a mess of windows:
 *
 *  1. Creation is single-flight. Asking three providers at once (compare mode)
 *     fires three concurrent calls; without a shared in-flight promise every one
 *     of them checks "does a window exist?", all get `false` because none has
 *     been created yet, and all three create one.
 *  2. Every window we create is remembered in a Set, not a single id. Hiding or
 *     closing then reaches all of them, so nothing can be orphaned on screen
 *     with no way to reach it from the UI.
 */

const RELAY_TITLE_MARKER = '__sidebar_ai_relay__';
const RELAY_STATE_KEY = 'relayState';

/** Every window we have created; normally one, more only while cleaning up. */
let relayWindowIds = new Set();
/** The window new provider tabs are added to. */
let relayWindowId = null;
/** providerId -> tabId */
const relayTabs = new Map();

/** Hostnames the providers live on, used to spot stray relay windows. */
let providerHosts = new Set();

/**
 * Why the window is currently on screen, if it is.
 *   null    — hidden, as it should be
 *   'login' — auto-revealed so the user could sign in; re-hide once used
 *   'manual'— the user asked for it via the menu; leave it alone
 */
let revealReason = null;

/**
 * Which tabs belong to the relay CANNOT live only in these variables.
 *
 * An MV3 service worker is torn down after roughly 30 seconds idle and restarted
 * on the next event, which wipes module state. With the ids gone the relay tab
 * stops being recognised as ours: it starts looking like an ordinary page and
 * gets scraped as "the page you are reading", and the next question opens a
 * second relay window because the first is no longer known.
 *
 * chrome.storage.session is the right home for it — it survives worker restarts,
 * lives in memory rather than on disk, and clears itself when the browser
 * closes, which is exactly the lifetime a tab id is valid for.
 */
let hydration = null;

async function hydrate() {
  if (!chrome.storage?.session) return;
  const stored = await chrome.storage.session.get(RELAY_STATE_KEY);
  const saved = stored[RELAY_STATE_KEY];
  if (!saved) return;

  relayWindowId = saved.windowId ?? null;
  relayWindowIds = new Set(saved.windowIds || (saved.windowId ? [saved.windowId] : []));
  revealReason = saved.revealReason ?? null;
  relayTabs.clear();
  for (const [providerId, tabId] of Object.entries(saved.tabs || {})) {
    relayTabs.set(providerId, tabId);
  }
}

/** Await before trusting any relay state after a possible worker restart. */
export function whenRelayReady() {
  if (!hydration) hydration = hydrate().catch(() => {});
  return hydration;
}

async function persist() {
  if (!chrome.storage?.session) return;
  await chrome.storage.session
    .set({
      [RELAY_STATE_KEY]: {
        windowId: relayWindowId,
        windowIds: [...relayWindowIds],
        tabs: Object.fromEntries(relayTabs),
        revealReason
      }
    })
    .catch(() => {});
}

// Warm the cache as soon as the worker spins up.
whenRelayReady();

/** Told by the service worker which hosts count as provider pages. */
export function registerProviderHosts(hosts) {
  providerHosts = new Set(hosts.filter(Boolean));
}

export function getRelayWindowId() {
  return relayWindowId;
}

/** True for any tab living in any relay window, tracked individually or not. */
export function isRelayWindow(windowId) {
  return windowId != null && relayWindowIds.has(windowId);
}

export function getRelayTabId(providerId) {
  return relayTabs.get(providerId) ?? null;
}

export function isRelayTab(tabId) {
  for (const id of relayTabs.values()) if (id === tabId) return true;
  return false;
}

export function forgetTab(tabId) {
  let changed = false;
  for (const [providerId, id] of relayTabs) {
    if (id === tabId) {
      relayTabs.delete(providerId);
      changed = true;
    }
  }
  if (changed) persist();
}

export function forgetWindow(windowId) {
  if (!relayWindowIds.has(windowId)) return;

  relayWindowIds.delete(windowId);
  if (relayWindowId === windowId) relayWindowId = [...relayWindowIds][0] ?? null;
  if (!relayWindowIds.size) revealReason = null;
  persist();
}

// ------------------------------------------------------------- primitives ---

async function windowExists(id) {
  if (id == null) return false;
  try {
    await chrome.windows.get(id);
    return true;
  } catch {
    return false;
  }
}

/** Same conversation? Ignore trailing slashes and fragments. */
function sameUrl(a, b) {
  if (!a || !b) return false;
  const norm = (u) => {
    try {
      const parsed = new URL(u);
      return parsed.origin + parsed.pathname.replace(/\/+$/, '') + parsed.search;
    } catch {
      return String(u);
    }
  };
  return norm(a) === norm(b);
}

/**
 * Point a provider's ALREADY OPEN tab at `url`. Returns false when that
 * provider has no tab yet — in that case there is nothing to switch, and the
 * stored URL will simply be where its tab opens later.
 */
export async function navigateExistingTab(providerId, url) {
  await whenRelayReady();
  if (!url) return false;

  const tabId = relayTabs.get(providerId);
  if (!(await tabExists(tabId))) return false;

  const tab = await chrome.tabs.get(tabId);
  if (sameUrl(tab.url, url)) return true;

  await chrome.tabs.update(tabId, { url });
  await waitForTabLoad(tabId).catch(() => {});
  return true;
}

async function tabExists(id) {
  if (id == null) return false;
  try {
    await chrome.tabs.get(id);
    return true;
  } catch {
    return false;
  }
}

async function applyWindowMode(windowId, mode) {
  try {
    if (mode === 'visible') {
      await chrome.windows.update(windowId, { state: 'normal', focused: false });
    } else if (mode === 'offscreen') {
      // Park it past the right edge of the primary display. Chrome clamps
      // windows onto a display on some platforms, in which case this behaves
      // like a small unfocused window — still harmless.
      await chrome.windows.update(windowId, {
        state: 'normal',
        focused: false,
        left: 20000,
        top: 20000,
        width: 900,
        height: 800
      });
    } else {
      await chrome.windows.update(windowId, { state: 'minimized' });
    }
  } catch {
    /* window may have been closed mid-flight */
  }
}

/**
 * Put a relay window that has drifted back where it belongs.
 *
 * The mode is applied when a window is created and after a provider tab is
 * added to it, and neither of those runs on the common path: a second question
 * finds the tab already open and returns early. So a relay window that got
 * restored ONCE stayed on screen for the rest of the session, debugger bar and
 * all, with nothing that would ever put it away again.
 *
 * That used to need a bug to reach — `open_tab` creating a tab in the minimized
 * relay, which restores it (see state/user-tabs.js) — and it is fixed at source.
 * It is not the only way in, though: a login reveal that never got used, Chrome
 * restoring windows on startup, a stray click on the taskbar. One window that is
 * meant to be invisible and is not is worth a cheap check per ask.
 *
 * Cheap because it READS first: `windows.update` on an already-minimized window
 * is a no-op to the user but not to Chrome, and doing it on every question of
 * every chat is churn for nothing. A window we cannot read is left alone.
 */
async function reassertWindowMode(mode) {
  if (mode === 'visible' || revealReason === 'manual') return;

  for (const id of relayWindowIds) {
    const win = await chrome.windows.get(id).catch(() => null);
    if (!win) continue;
    // 'offscreen' is a position rather than a state, so a window dragged back
    // onto the display reads as perfectly normal and has to be tested for.
    const wrong =
      mode === 'minimized'
        ? win.state !== 'minimized'
        : win.state === 'minimized' || (win.left ?? 0) < 10000;

    if (wrong) await applyWindowMode(id, mode);
  }
}

/** Drop ids for windows that no longer exist. */
async function pruneDeadWindows() {
  for (const id of [...relayWindowIds]) {
    if (!(await windowExists(id))) relayWindowIds.delete(id);
  }
  if (!relayWindowIds.has(relayWindowId)) relayWindowId = [...relayWindowIds][0] ?? null;
}

/**
 * Find popup windows that are plainly ours but are not being tracked — strays
 * left behind by a crash, a worker restart before state was persisted, or an
 * older build. Adopting them means Hide and Close can reach them instead of
 * leaving the user with windows nothing in the UI controls.
 *
 * Deliberately narrow: only `popup` windows, and only when *every* tab in them
 * is a provider page. Relay windows are `normal` now, so this only ever catches
 * leftovers from the older popup-based build — and that restriction is the
 * point. A user may well keep a normal window with nothing but ChatGPT open in
 * it, and closing that would be unforgivable. Live relay windows are tracked by
 * id in session storage, which is what makes them findable across restarts.
 */
async function adoptStrayWindows() {
  if (!providerHosts.size) return;

  let windows;
  try {
    windows = await chrome.windows.getAll({ populate: true });
  } catch {
    return;
  }

  for (const win of windows) {
    if (win.type !== 'popup' || relayWindowIds.has(win.id)) continue;
    if (!win.tabs?.length) continue;

    const allProviderPages = win.tabs.every((tab) => {
      try {
        return providerHosts.has(new URL(tab.url || tab.pendingUrl || '').hostname);
      } catch {
        return false;
      }
    });

    if (allProviderPages) relayWindowIds.add(win.id);
  }
}

/**
 * Close relay windows that hold none of our tracked tabs. That is exactly the
 * shape of a duplicate created by a concurrent race, and never the shape of the
 * window actually in use.
 */
async function closeRedundantWindows() {
  if (relayWindowIds.size <= 1) return;

  const tracked = new Set(relayTabs.values());

  for (const id of [...relayWindowIds]) {
    if (id === relayWindowId) continue;
    try {
      const win = await chrome.windows.get(id, { populate: true });
      const holdsTracked = (win.tabs || []).some((tab) => tracked.has(tab.id));
      if (holdsTracked) continue;
      await chrome.windows.remove(id);
    } catch {
      /* already gone */
    }
    relayWindowIds.delete(id);
  }
}

// -------------------------------------------------------- window creation ---

/**
 * In-flight window creation. Concurrent callers await the same promise instead
 * of each creating their own window.
 */
let windowCreation = null;

/**
 * A freshly created window arrives with one tab already loading the URL we
 * asked for. Exactly one caller may claim it — the concurrent callers sharing
 * `windowCreation` must not all adopt the same tab as their provider's — so it
 * is handed over once and then cleared.
 */
let pendingSeed = null;

function claimSeedTab(windowId, url) {
  if (!pendingSeed) return null;
  if (pendingSeed.windowId !== windowId || pendingSeed.url !== url) return null;
  const { tabId } = pendingSeed;
  pendingSeed = null;
  return tabId;
}

async function ensureRelayWindow(url, mode) {
  await pruneDeadWindows();
  if (await windowExists(relayWindowId)) return relayWindowId;
  if (windowCreation) return windowCreation;

  windowCreation = (async () => {
    // Re-check inside the critical section: a queued caller may have created
    // the window between our first check and getting here.
    if (await windowExists(relayWindowId)) return relayWindowId;

    await adoptStrayWindows();
    if (relayWindowIds.size) {
      const revived = [...relayWindowIds].find(Boolean);
      if (await windowExists(revived)) {
        relayWindowId = revived;
        await persist();
        return revived;
      }
    }

    // 'normal', not 'popup'. A popup is meant to hold exactly one tab, and
    // Chrome does not reliably honour tabs.create({windowId}) into one — the
    // extra providers' tabs end up in the user's own browsing window instead,
    // which is how a stray ChatGPT tab appears next to their real tabs. A
    // normal window holds several tabs properly and, minimized, is just as
    // far out of the way.
    const opts = { url, type: 'normal', focused: false };

    if (mode === 'minimized') {
      // Ask for 'minimized' up front rather than creating a normal window and
      // shrinking it a moment later — that two-step version paints a real
      // window on screen first, which is the flash you see on the first
      // question. Chrome rejects state alongside left/top/width/height.
      opts.state = 'minimized';
    } else {
      Object.assign(opts, {
        width: 900,
        height: 800,
        left: mode === 'offscreen' ? 20000 : 100,
        top: mode === 'offscreen' ? 20000 : 100
      });
    }

    const win = await chrome.windows.create(opts);
    relayWindowId = win.id;
    relayWindowIds.add(win.id);
    pendingSeed = { windowId: win.id, tabId: win.tabs?.[0]?.id ?? null, url };
    await persist();

    if (mode !== 'minimized') await applyWindowMode(win.id, mode);
    return win.id;
  })();

  try {
    return await windowCreation;
  } finally {
    windowCreation = null;
  }
}

// ----------------------------------------------------------- provider tabs --

/** In-flight tab creation, per provider — same single-flight reasoning. */
const tabCreation = new Map();

/**
 * Return a live tab for `provider`, creating the relay window and/or tab as
 * needed. Resolves once the tab has finished its top-level load.
 */
export async function ensureProviderTab(provider, settings, resumeUrl = null) {
  await whenRelayReady();

  const pending = tabCreation.get(provider.id);
  if (pending) return pending;

  const work = (async () => {
    const mode = settings.relayWindowMode || 'minimized';

    // Reopen the conversation we were last using rather than a blank chat, so
    // the thread keeps its context and stays a single entry in the provider's
    // own history.
    const startUrl = resumeUrl || provider.homeUrl;

    // If the window was popped open for a login, put it away again now that it
    // is being used normally. A window the user opened themselves from the menu
    // stays where they put it.
    if (revealReason === 'login' && mode !== 'visible') {
      revealReason = null;
      await persist();
      for (const id of relayWindowIds) await applyWindowMode(id, mode);
    }

    const existing = relayTabs.get(provider.id);
    if (await tabExists(existing)) {
      const tab = await chrome.tabs.get(existing);

      // Already open, but possibly on the wrong conversation — after loading a
      // session from history the tab still shows whatever it was last used for.
      // Steer the existing tab rather than opening another one.
      if (resumeUrl && !sameUrl(tab.url, resumeUrl)) {
        await chrome.tabs.update(existing, { url: resumeUrl });
        await waitForTabLoad(existing);
      } else if (tab.status !== 'complete') {
        await waitForTabLoad(existing);
      }

      await reassertWindowMode(mode);
      return existing;
    }

    relayTabs.delete(provider.id);

    const winId = await ensureRelayWindow(startUrl, mode);

    // Take the new window's seed tab if it was opened for this provider's URL;
    // otherwise the window belongs to someone else (or was adopted) and this
    // provider needs a tab of its own. Never inherit another provider's page.
    let tabId = claimSeedTab(winId, startUrl);

    if (tabId == null) {
      const tab = await chrome.tabs.create({
        windowId: winId,
        url: startUrl,
        active: false
      });
      tabId = tab.id;

      // Belt and braces: if Chrome placed the tab somewhere other than the
      // relay window, drag it back rather than leaving a provider page loose
      // among the user's own tabs.
      if (tab.windowId !== winId) {
        try {
          await chrome.tabs.move(tabId, { windowId: winId, index: -1 });
        } catch {
          /* if the move fails the tab still works, just in the wrong window */
        }
      }
    }

    relayTabs.set(provider.id, tabId);
    await persist();
    await waitForTabLoad(tabId);
    await closeRedundantWindows();

    // Settle: unless the user asked to watch it, put the window back where it
    // belongs. Navigation and tab creation can pull a window forward, so
    // re-asserting here is what guarantees it does not sit on screen after a
    // question.
    if (revealReason !== 'manual' && mode !== 'visible') {
      for (const id of relayWindowIds) await applyWindowMode(id, mode);
    }

    await persist();
    return tabId;
  })();

  tabCreation.set(provider.id, work);
  try {
    return await work;
  } finally {
    tabCreation.delete(provider.id);
  }
}

export function waitForTabLoad(tabId, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      clearTimeout(timer);
      fn(arg);
    };

    const onUpdated = (id, info) => {
      if (id === tabId && info.status === 'complete') finish(resolve, tabId);
    };
    const onRemoved = (id) => {
      if (id === tabId) finish(reject, new Error('Provider tab was closed'));
    };

    const timer = setTimeout(
      () => finish(reject, new Error('Timed out loading the provider page')),
      timeoutMs
    );

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);

    // The tab may already be done before we attached listeners.
    chrome.tabs.get(tabId).then(
      (tab) => {
        if (tab.status === 'complete') finish(resolve, tabId);
      },
      () => finish(reject, new Error('Provider tab is gone'))
    );
  });
}

// ------------------------------------------------------------- operations ---

/** Reset a provider's conversation by navigating its tab to a fresh chat. */
export async function resetProviderTab(provider, settings) {
  await whenRelayReady();
  const tabId = await ensureProviderTab(provider, settings);
  await chrome.tabs.update(tabId, { url: provider.newChatUrl });
  await waitForTabLoad(tabId);
  return tabId;
}

/**
 * Bring a provider tab forward. `reason` is 'login' when the extension opened
 * it on the user's behalf (auto-hidden again on the next question) or 'manual'
 * when the user asked for it from the menu (left alone until they hide it).
 */
export async function revealProviderTab(provider, settings, reason = 'login') {
  await whenRelayReady();
  const tabId = await ensureProviderTab(provider, settings);

  revealReason = reason;
  await persist();

  const tab = await chrome.tabs.get(tabId);
  await chrome.windows.update(tab.windowId, { state: 'normal', focused: true });
  await chrome.tabs.update(tabId, { active: true });
  return tabId;
}

/** Push every relay window back out of the way. */
export async function hideRelayWindow(settings) {
  await whenRelayReady();
  revealReason = null;

  await pruneDeadWindows();
  await adoptStrayWindows();

  const mode = settings.relayWindowMode || 'minimized';
  // 'visible' is a debugging mode, but an explicit Hide should still hide.
  const target = mode === 'visible' ? 'minimized' : mode;

  for (const id of relayWindowIds) await applyWindowMode(id, target);
  await persist();
}

/** Close every relay window, tracked or adopted. */
export async function closeRelay() {
  await whenRelayReady();
  await pruneDeadWindows();
  await adoptStrayWindows();

  for (const id of [...relayWindowIds]) {
    await chrome.windows.remove(id).catch(() => {});
  }

  relayWindowIds.clear();
  relayWindowId = null;
  relayTabs.clear();
  revealReason = null;
  await persist();
}

export { RELAY_TITLE_MARKER };
