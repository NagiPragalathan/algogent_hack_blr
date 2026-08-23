import { loadState } from '../state/settings.js';
import { isRelayOwned } from '../state/user-tabs.js';
import { whenRelayReady } from '../relay.js';

/**
 * Text arriving from a page, and how it reaches the panel.
 *
 * Two ways in, one destination:
 *
 *   highlighting     the content script reports what you selected, so it is
 *                    already attached by the time you turn to the panel
 *   right-click      "Ask Sidebar AI about this" opens the panel with the
 *                    selection attached, from a page where the panel was shut
 *
 * The second is why this module holds state at all. `chrome.sidePanel.open()`
 * returns before the panel has booted, let alone connected its port, so a
 * handoff posted at click time lands nowhere. It is parked here instead and
 * collected when the panel says INIT — which happens on every open, including
 * the one we just triggered.
 */

const PENDING_KEY = 'pendingHandoff';

/** Set by `channel/panel.js` while a panel is connected. */
let sink = null;

export function setPanelSink(post) {
  sink = post;
}

export function clearPanelSink(post) {
  if (sink === post) sink = null;
}

/**
 * Session storage, not a module variable: the worker is torn down between the
 * right-click and the panel finishing its boot often enough to matter, and a
 * handoff that survives everything except the thing it was waiting for is
 * worse than no handoff.
 */
async function park(handoff) {
  await chrome.storage.session?.set({ [PENDING_KEY]: handoff }).catch(() => {});
}

/** Anything waiting for a panel that has just opened. Clears as it is read. */
export async function takePendingHandoff() {
  const stored = await chrome.storage.session?.get(PENDING_KEY).catch(() => null);
  const handoff = stored?.[PENDING_KEY] || null;
  if (handoff) await chrome.storage.session?.remove(PENDING_KEY).catch(() => {});
  return handoff;
}

const cut = (text, n) => (text.length > n ? text.slice(0, n - 1) + '…' : text);

/** What the panel shows as an attachment. Same shape the element picker sends. */
const asPick = (text, tab) => ({
  type: 'PICKED',
  ok: true,
  label: cut(text.replace(/\s+/g, ' ').trim(), 60),
  text,
  url: tab?.url || '',
  title: tab?.title || '',
  fromSelection: true
});

// ------------------------------------------------------------ right-click ---

const MENU = {
  selection: 'sidebar-ai-ask-selection',
  page: 'sidebar-ai-ask-page'
};

/**
 * Installed once from the worker entry.
 *
 * Menus are rebuilt on every startup rather than only on install: they live in
 * the browser profile, and an update that renames one leaves the old title
 * behind forever otherwise.
 */
export function watchContextMenus() {
  const build = () => {
    chrome.contextMenus?.removeAll(() => {
      chrome.contextMenus.create({
        id: MENU.selection,
        title: 'Ask Sidebar AI about “%s”',
        contexts: ['selection']
      });
      chrome.contextMenus.create({
        id: MENU.page,
        title: 'Ask Sidebar AI about this page',
        contexts: ['page']
      });
    });
  };

  chrome.runtime.onInstalled.addListener(build);
  chrome.runtime.onStartup?.addListener(build);

  chrome.contextMenus?.onClicked.addListener(async (info, tab) => {
    if (!tab) return;

    /**
     * Open the panel FIRST, and synchronously.
     *
     * `sidePanel.open()` requires a user gesture, and a context-menu click only
     * counts as one until the first await — so anything asynchronous before
     * this line turns "opens the panel" into "does nothing, silently". The
     * relay check therefore comes after it: opening the panel for a provider
     * window is harmless, handing it that window's text is not.
     */
    if (tab.windowId != null) {
      chrome.sidePanel?.open({ windowId: tab.windowId }).catch(() => {});
    }

    await whenRelayReady();
    if (isRelayOwned(tab)) return;

    const selection = (info.selectionText || '').trim();
    const handoff =
      info.menuItemId === MENU.selection && selection
        ? asPick(selection, tab)
        : { type: 'FOCUS_PAGE', tabId: tab.id, url: tab.url, title: tab.title };

    // A panel that is already open gets it now; one that is still booting finds
    // it at INIT. Both, rather than either: `sidePanel.open` on an open panel
    // resolves without re-running boot, so waiting for INIT alone would hang.
    await park(handoff);
    if (sink) {
      sink({ type: 'HANDOFF', handoff });
      await takePendingHandoff();
    }
  });
}

// ------------------------------------------------------- what you selected ---

/**
 * Text highlighted on a page, on its way to the panel.
 *
 * Gated in the worker rather than in the content script: the setting is read
 * fresh on every message here, so turning it off takes effect on the next
 * selection instead of on the next page load. The message itself is cheap and
 * already debounced by the page.
 *
 * Installed once from the worker entry.
 */
export function watchPageSelection() {
  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (msg?.type !== 'PAGE_SELECTION' || !sender.tab) return;

    (async () => {
      /**
       * Wait for the relay ids before deciding this is an ordinary page.
       *
       * A provider tab runs `page-context.js` too — the chat path injects it —
       * and after a worker restart the ids that identify those tabs are still
       * in session storage rather than in memory. Skip the wait and a selection
       * made while watching the provider window attaches the assistant's own
       * words as "the page you are reading".
       */
      await whenRelayReady();
      if (isRelayOwned(sender.tab)) return;

      const { settings } = await loadState();
      if (settings.captureSelection === false) return;
      if (!sink) return;

      const text = (msg.text || '').trim();
      // An empty selection is a signal too: you deselected, so the chip goes.
      sink(text ? asPick(text, sender.tab) : { type: 'SELECTION_CLEARED' });
    })();
  });
}
