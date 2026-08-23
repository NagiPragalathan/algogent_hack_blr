/**
 * Keeping a hidden provider tab fully alive.
 *
 * The relay window is minimized by design, and Chrome treats a hidden page as
 * something it may economise on. Measured on a chained 200ms poll: 200ms while
 * visible, 1000ms while hidden. After five minutes hidden it can be frozen
 * outright, and under memory pressure discarded. On top of the browser's own
 * throttling, some provider apps gate their streaming render on
 * `document.hidden` and simply never paint the answer we are trying to read.
 *
 * The layers below escalate, and every one of them is reversible:
 *
 *   1. autoDiscardable = false        Chrome may not throw the tab away.
 *   2. Web Lock (in the adapter)      A held lock is a documented freezing
 *                                    exemption, so Energy Saver cannot suspend
 *                                    the page mid-answer.
 *   3. Visibility spoof, MAIN world   `document.hidden` reads false and
 *                                    visibilitychange/blur/pagehide are
 *                                    swallowed, so the site's own code keeps
 *                                    rendering. This does NOT stop Chrome's
 *                                    timer clamp — the browser decides that from
 *                                    its own state, not from the property — it
 *                                    only stops the *page* from standing down.
 *   4. Debugger pin                   Emulation.setFocusEmulationEnabled plus
 *                                    Page.setWebLifecycleState('active'). A
 *                                    debugged page is exempt from throttling and
 *                                    freezing entirely. This is the one that
 *                                    actually fixes it.
 *
 * Nothing here is required for correctness: every layer failing leaves a working
 * extension that is merely slow, which is why each one is wrapped and ignored on
 * error rather than surfaced.
 */

/** tabId -> what we did to it, so teardown is exact. */
const pinned = new Map();

const isDebuggerPolicy = (policy) => policy === 'debugger';
const isEnabled = (policy) => policy !== 'off';

/**
 * Make the tab believe it is the front-most thing on screen.
 *
 * Runs in the MAIN world: the point is to change what the provider's own
 * JavaScript sees, and a content script's isolated world has a separate
 * `document` wrapper the page never consults.
 */
function visibilitySpoof() {
  if (window.__sidebarAIVisibilityPinned) return;
  window.__sidebarAIVisibilityPinned = true;

  const define = (object, property, value) => {
    try {
      Object.defineProperty(object, property, {
        configurable: true,
        get: () => value
      });
    } catch {
      /* the site froze it — nothing to do */
    }
  };

  define(document, 'hidden', false);
  define(document, 'visibilityState', 'visible');
  define(document, 'webkitHidden', false);
  define(document, 'webkitVisibilityState', 'visible');

  try {
    document.hasFocus = () => true;
  } catch {
    /* ignore */
  }

  // Swallow the events that tell an app to stand down.
  //
  // `visibilitychange` is reliably caught: it targets `document`, so a capture
  // listener on `window` runs before anything the site registered. `blur` and
  // `pagehide` target `window` itself, and listeners on the target node fire in
  // registration order regardless of the capture flag — so a site that
  // registered before we were injected still sees those. Verified, and left as
  // is: the debugger pin is what actually carries this, and the spoof only has
  // to stop the app from voluntarily standing down.
  for (const type of ['visibilitychange', 'webkitvisibilitychange', 'blur', 'pagehide', 'freeze']) {
    window.addEventListener(
      type,
      (event) => {
        event.stopImmediatePropagation();
        event.preventDefault?.();
      },
      { capture: true }
    );
  }
}

/** Layer 1. Cheap, and the only one that survives a worker restart on its own. */
async function keepUndiscardable(tabId) {
  try {
    await chrome.tabs.update(tabId, { autoDiscardable: false });
    return true;
  } catch {
    return false;
  }
}

/** Layer 3. */
async function applyVisibilitySpoof(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: 'MAIN',
      func: visibilitySpoof
    });
    return true;
  } catch {
    return false;
  }
}

/** Layer 4 — the one that actually defeats the throttle. */
async function attachDebuggerPin(tabId) {
  const target = { tabId };

  try {
    await chrome.debugger.attach(target, '1.3');
  } catch (err) {
    // Already attached by us is fine; anything else (DevTools open on that tab,
    // another extension holding it) means this layer is unavailable.
    if (!String(err?.message || err).includes('Another debugger is already attached')) {
      return false;
    }
  }

  try {
    // Tell the renderer it has focus. Without this the page still behaves as a
    // background tab for rendering purposes even while attached.
    await chrome.debugger.sendCommand(target, 'Emulation.setFocusEmulationEnabled', {
      enabled: true
    });
  } catch {
    /* older Chrome, or the domain is unavailable — the lifecycle pin still helps */
  }

  try {
    await chrome.debugger.sendCommand(target, 'Page.enable');
    await chrome.debugger.sendCommand(target, 'Page.setWebLifecycleState', {
      state: 'active'
    });
  } catch {
    /* pinned focus without the lifecycle pin is still better than nothing */
  }

  return true;
}

async function detachDebuggerPin(tabId) {
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    /* already gone */
  }
}

/**
 * Arm every layer the policy allows. Safe to call repeatedly — after a
 * navigation the page is new and the spoof has to be re-applied.
 */
export async function keepTabAwake(tabId, settings = {}) {
  if (tabId == null) return;

  const policy = settings.tabWakePolicy || 'debugger';
  const state = pinned.get(tabId) || { undiscardable: false, debugger: false };

  /**
   * Stepping the policy down applies to the tab that is already pinned.
   *
   * The pin is attached on the first question and, apart from a stall recovery,
   * held for the life of the tab — so an early return on the new policy would
   * leave the debugger attached until the browser closed. Someone turning it
   * off because that window is misbehaving is asking about the window in front
   * of them, and a setting that only affects the next tab reads as a setting
   * that does nothing.
   */
  if (!isDebuggerPolicy(policy) && state.debugger) {
    await detachDebuggerPin(tabId);
    state.debugger = false;
  }

  if (!isEnabled(policy)) {
    if (state.undiscardable) {
      await chrome.tabs.update(tabId, { autoDiscardable: true }).catch(() => {});
    }
    pinned.delete(tabId);
    return;
  }

  if (!state.undiscardable) state.undiscardable = await keepUndiscardable(tabId);

  // Re-applied every time: the spoof lives in the page, so a navigation wipes it.
  state.spoofed = await applyVisibilitySpoof(tabId);

  if (isDebuggerPolicy(policy) && !state.debugger) {
    state.debugger = await attachDebuggerPin(tabId);
  }

  pinned.set(tabId, state);
}

/** Put the tab back exactly as it was found. */
export async function releaseTab(tabId) {
  const state = pinned.get(tabId);
  if (!state) return;
  pinned.delete(tabId);

  if (state.debugger) await detachDebuggerPin(tabId);
  if (state.undiscardable) {
    await chrome.tabs.update(tabId, { autoDiscardable: true }).catch(() => {});
  }
  // The visibility spoof dies with the page; there is nothing to undo.
}

export async function releaseAllTabs() {
  await Promise.all([...pinned.keys()].map((tabId) => releaseTab(tabId)));
}

/**
 * Re-arm after a navigation, and let go when the tab dies.
 *
 * A provider tab navigates constantly — every new conversation is a route
 * change, and a full reload replaces the document the spoof was installed in.
 * Installed once from the worker entry.
 */
export function watchPinnedTabs(loadSettings) {
  chrome.tabs.onUpdated.addListener(async (tabId, info) => {
    if (!pinned.has(tabId)) return;
    if (info.status !== 'complete' && !info.url) return;
    const { settings } = await loadSettings();
    await keepTabAwake(tabId, settings);
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    pinned.delete(tabId);
  });

  // If the user dismisses the infobar, Chrome detaches us. Degrade quietly to
  // the softer layers rather than reattaching in a loop the user cannot escape.
  chrome.debugger?.onDetach?.addListener((source) => {
    const state = pinned.get(source.tabId);
    if (state) state.debugger = false;
  });
}
