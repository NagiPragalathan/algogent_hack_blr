import {
  isRelayTab,
  isRelayWindow,
  forgetTab,
  forgetWindow,
  whenRelayReady
} from '../relay.js';

/**
 * Which tab the user is actually looking at.
 *
 * The relay window steals nothing, but it *is* a window — so we track the last
 * ordinary tab the user looked at rather than trusting `lastFocusedWindow`.
 */

let lastUserTabId = null;

export function isOrdinaryUrl(url = '') {
  return /^https?:/i.test(url) || /^file:/i.test(url);
}

/**
 * Who wants to know which page the user is on.
 *
 * A callback list rather than a direct call into `channel/panel.js`, which
 * already imports this module — the import would close a ring, and the panel
 * channel is not the only thing that will ever care. The panel subscribes per
 * connection and unsubscribes when its port dies, so a reopened panel replaces
 * a dead one instead of accumulating.
 */
const watchers = new Set();

export function onUserTabChange(fn) {
  watchers.add(fn);
  return () => watchers.delete(fn);
}

function announce(event) {
  for (const fn of watchers) {
    try {
      fn(event);
    } catch {
      /* one bad listener must not stop the rest */
    }
  }
}

/**
 * A relay tab must never be mistaken for the page the user is reading.
 *
 * Checking `isRelayTab` alone is not enough: a brand new relay tab fires
 * onActivated while `chrome.windows.create` is still in flight, before its id
 * has been recorded, so it briefly looks like an ordinary tab. Testing the
 * window id as well closes that gap, because the window is registered the
 * moment it exists.
 */
export function isRelayOwned(tab) {
  return isRelayTab(tab.id) || isRelayWindow(tab.windowId);
}

/**
 * Tell the panel about a tab, readable or not.
 *
 * The unreadable half is the whole point. This used to announce only when the
 * URL was ordinary, so moving to a new-tab page, Settings or the Web Store
 * fired NOTHING — the panel never heard about the switch, never swapped the
 * session, and went on showing the previous page's conversation. From the
 * user's side that is the worst possible reading: "I opened a new tab and it is
 * still showing the old chat", with a Page-unavailable notice underneath
 * proving the panel knew perfectly well the page had changed.
 *
 * So the event always goes out and carries `tabId` unconditionally — a tab you
 * cannot READ is still a tab whose conversation is its own. `tab` is null when
 * there is nothing to read, which is what the context chip renders as "Page
 * unavailable"; the panel binds the session on `tabId` and never on `tab`.
 *
 * `lastUserTabId` still only tracks readable pages: it answers "which page do
 * I put in the prompt", and a chrome:// tab is not an answer to that.
 */
function announceTab(tabId, tab) {
  const readable = isOrdinaryUrl(tab.url);
  if (readable) lastUserTabId = tabId;
  announce({ type: 'active', tabId, tab: readable ? describe(tab) : null });
}

/** Installed once from the worker entry. */
export function watchUserTabs() {
  chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
    // The worker may have just restarted, so the relay ids might not be back in
    // memory yet — waiting avoids latching a relay tab as the user's page.
    await whenRelayReady();
    if (isRelayTab(tabId) || isRelayWindow(windowId)) return;
    try {
      const tab = await chrome.tabs.get(tabId);
      if (isRelayOwned(tab)) return;
      announceTab(tabId, tab);
    } catch {
      /* gone */
    }
  });

  chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
    if (info.status !== 'complete' || !tab.active) return;
    await whenRelayReady();
    if (isRelayOwned(tab)) return;
    // Announced on navigation as well as activation: the tab is the same one,
    // but its title and url are what the panel labels the conversation with.
    announceTab(tabId, tab);
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    forgetTab(tabId);
    if (tabId === lastUserTabId) lastUserTabId = null;
    announce({ type: 'closed', tabId });
  });

  chrome.windows.onRemoved.addListener((windowId) => forgetWindow(windowId));
}

/** A tab as the panel needs it: enough to key a conversation and label it. */
export function describe(tab) {
  return tab ? { id: tab.id, title: tab.title || tab.url, url: tab.url } : null;
}

/**
 * The tab the user is looking at, and whether we can do anything with it.
 *
 * Three outcomes, and collapsing them is what caused the bug this exists for:
 *
 *  - `{tab}`          an ordinary page. Use it.
 *  - `{tab, blocked}` they ARE looking at something, and it is a page we
 *                     cannot read or drive: the New Tab page, chrome://,
 *                     the Web Store.
 *  - `{ours: true}`   our own relay window has focus. That is our
 *                     interference, not a choice they made, so falling back to
 *                     their last real tab is right.
 *
 * Only the third justifies looking somewhere else. `blocked` used to fall
 * through the same path and quietly hand back an unrelated tab — open a New
 * Tab, ask "find the official website for OpenAI", and the run drove the
 * GitHub tab sitting behind it, screenshotted it, and the composer chip
 * offered 8,570 characters of that page to the provider. Nothing on screen
 * said which page was being used, because as far as every layer above was
 * concerned this WAS the user's tab.
 */
export async function focusedUserTab() {
  await whenRelayReady();

  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!active || isRelayOwned(active)) return { tab: null, ours: true };
  if (isOrdinaryUrl(active.url)) return { tab: active };
  return { tab: active, blocked: true };
}

export async function resolveUserTab() {
  const focused = await focusedUserTab();
  if (focused.tab && !focused.blocked) return focused.tab;

  // They are looking at a page we cannot use. Say so by returning nothing —
  // never by substituting a different tab they cannot see.
  if (focused.blocked) return null;

  if (lastUserTabId != null) {
    try {
      const tab = await chrome.tabs.get(lastUserTabId);
      if (!isRelayOwned(tab) && isOrdinaryUrl(tab.url)) return tab;
    } catch {
      /* gone */
    }
  }

  // Last resort: the most recently used ordinary tab anywhere, ignoring the
  // relay window entirely.
  const all = await chrome.tabs.query({});
  const candidates = all
    .filter((t) => !isRelayOwned(t) && isOrdinaryUrl(t.url))
    .sort((a, b) => Number(b.active) - Number(a.active));

  return candidates[0] || null;
}

/**
 * May the agent drive this tab id?
 *
 * The guard that matters is the relay one. A provider tab is a perfectly
 * ordinary https page, so an agent that finds one and switches to it starts
 * typing into the same chat window that is issuing its own instructions —
 * every keystroke becomes part of the conversation deciding the next keystroke.
 */
export async function isUserTabId(tabId) {
  await whenRelayReady();
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  return Boolean(tab && !isRelayOwned(tab) && isOrdinaryUrl(tab.url));
}

/** Ordinary tabs the user could share, newest-window-first. Relay tabs excluded. */
export async function listShareableTabs() {
  await whenRelayReady();
  const all = await chrome.tabs.query({});
  return all
    .filter((tab) => !isRelayOwned(tab) && isOrdinaryUrl(tab.url))
    .map((tab) => ({
      id: tab.id,
      title: tab.title || tab.url,
      url: tab.url,
      active: tab.active
    }));
}

/**
 * A window of the user's own to put a new tab in.
 *
 * `chrome.tabs.create` with no `windowId` uses the *last focused* window, and
 * for most of every run that is the relay window — it is a `type: 'normal'`
 * window (deliberately, see relay.js) and it is restored and focused the moment
 * a provider tab is created or navigated in it. So a tab meant for the user
 * lands among the provider tabs instead, which fails twice over: it is not
 * where they are looking, and `isRelayOwned` is then true of it, so the run is
 * refused the very page it just opened.
 *
 * The visible half is worse. Creating a tab in a minimized window RESTORES that
 * window, so the relay — which exists to stay out of the way — is dragged onto
 * the screen with Chrome's "started debugging this browser" bar across the top
 * of it, and the user watches their task happen inside what looks like a second
 * browser they did not open. Reported as exactly that: *"the tabs are getting
 * opened [in] the ChatGPT-opened Chrome, not the Chrome for the chatting
 * window."*
 *
 * `preferTabId` is the tab the new one belongs beside — the page whose link is
 * being followed. Answering from that rather than from "any window of theirs"
 * is what puts the tab next to its own page when the user has two windows open.
 */
export async function userWindowId(preferTabId = null) {
  await whenRelayReady();

  if (preferTabId != null) {
    const tab = await chrome.tabs.get(preferTabId).catch(() => null);
    if (tab && !isRelayWindow(tab.windowId)) return tab.windowId;
  }

  const windows = await chrome.windows.getAll({ windowTypes: ['normal'] }).catch(() => []);
  const mine = windows.filter((win) => !isRelayWindow(win.id));

  // Focused first, then anything not minimized: a tab created in a minimized
  // window pops it open, and doing that to the user's own window is the same
  // rudeness as doing it to ours, one step smaller.
  return (
    mine.find((win) => win.focused) ||
    mine.find((win) => win.state !== 'minimized') ||
    mine[0]
  )?.id ?? null;
}

/**
 * Open a tab where the user can see it. The one road for every new tab.
 *
 * There were three copies of this decision and only one of them made it — the
 * agent's start page picked a user window, while `open_tab` and the panel's
 * "open this conversation" did not. One function, so the next caller cannot get
 * it wrong by omission.
 *
 * `active` focuses the window as well as the tab, because a tab the user is
 * meant to read is no use activated inside a window behind theirs.
 */
export async function createUserTab(url, { active = false, nearTabId = null } = {}) {
  const windowId = await userWindowId(nearTabId);

  if (windowId != null) {
    const tab = await chrome.tabs.create({ windowId, url, active }).catch(() => null);
    if (tab) {
      // Chrome has been known to place a tab somewhere other than the window it
      // was asked for. Drag it back rather than leave it loose in the relay.
      if (isRelayWindow(tab.windowId)) {
        await chrome.tabs.move(tab.id, { windowId, index: -1 }).catch(() => {});
      }
      if (active) await chrome.windows.update(windowId, { focused: true }).catch(() => {});
      return tab;
    }
  }

  // Every normal window was ours, so there is nowhere to put it but a new one.
  const win = await chrome.windows.create({ url, focused: active }).catch(() => null);
  return win?.tabs?.[0] || null;
}
