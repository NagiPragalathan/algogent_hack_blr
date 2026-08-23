/**
 * Which tab the open panel is attached to, and marking that tab so you can see
 * it.
 *
 * This module used to try to make the side panel itself per-tab, with
 * `setOptions({tabId, enabled:false})`. That does not work and cannot be made
 * to: disabling **closes** the panel, and re-enabling does not reopen it —
 * `sidePanel.open()` needs a user gesture, so nothing here can bring it back.
 * An agent run activates tabs constantly (a screenshot has to foreground the
 * tab), so every run closed the panel a second after it started and left no
 * way to restore it except clicking the icon again. Switching tabs by hand did
 * the same. Chrome's own Gemini panel is a browser feature and is not bound by
 * this; an extension is.
 *
 * So the panel stays window-wide, which is the only shape that survives, and
 * the *conversation* is what is per-tab — see `openTabSession` in the panel,
 * which swaps the thread as you move. This module's remaining job is the part
 * that was missing either way: making it visible which tab the assistant is
 * attached to, because a window-wide panel looks identical on every tab.
 */

/** The tab currently wearing the marker, so it can be taken off again. */
let markedTab = null;
/** Whether a panel is open at all. Not persisted — neither is an open panel. */
let panelOpen = false;

function mark(tabId, on) {
  if (tabId == null) return;
  chrome.tabs
    .sendMessage(tabId, { target: 'agent-page', type: 'AGENT_PANEL', on })
    .catch(() => {
      // A tab whose content script pre-dates the last extension reload has no
      // handler for this and will not answer until it is reloaded. Not worth
      // injecting over — the marker is information, not function.
    });
}

/** Move the marker to `tabId`, taking it off wherever it was. */
function moveMarkTo(tabId) {
  if (markedTab === tabId) {
    // Re-assert rather than return: a reload wipes the marker out of the
    // document while our idea of where it is stays the same.
    mark(tabId, true);
    return;
  }

  if (markedTab != null) mark(markedTab, false);
  markedTab = tabId;
  if (tabId != null) mark(tabId, true);
}

/**
 * The panel is open, and this is the tab in front of the user.
 *
 * Called with the LITERAL active tab, including a chrome:// one — not
 * `resolveUserTab()`, which answers "which page is worth reading" and skips
 * chrome:// and relay tabs. Opening the panel on chrome://extensions and
 * marking whatever unrelated background tab that returned is exactly how the
 * indicator ended up on a tab nobody could see.
 */
export function panelOpenedOn(tabId) {
  panelOpen = true;
  moveMarkTo(tabId ?? null);
}

/** The panel closed. */
export function panelClosed() {
  panelOpen = false;
  moveMarkTo(null);
}

/** Installed once from the worker entry. */
export function watchPanelTabs() {
  // Chrome opens the panel on an icon click by itself. Taking that over made
  // opening it depend on this worker being alive — and `openPanelOnActionClick`
  // is a setting Chrome remembers, so a worker that failed to start left an
  // icon that did nothing and no way into the extension at all.
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

  // Undo any per-tab disabling left over from the version that tried it. A
  // profile that ran that build has tabs stuck with the panel switched off,
  // and nothing else would ever turn them back on.
  chrome.sidePanel.setOptions({ enabled: true }).catch(() => {});

  chrome.tabs.onActivated.addListener(({ tabId }) => {
    if (panelOpen) moveMarkTo(tabId);
  });

  // A reloaded or navigated page has a fresh document with no marker in it.
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (panelOpen && info.status === 'complete' && tabId === markedTab) mark(tabId, true);
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    if (markedTab === tabId) markedTab = null;
  });
}
