import { closeRelay, getRelayTabId, forgetTab } from '../relay.js';
import * as embedded from '../embedded.js';
import { isEmbedded } from '../state/settings.js';
import { releaseTab, releaseAllTabs } from './keep-awake.js';
import { inflight } from './inflight.js';

/**
 * Getting back to a clean provider window after a stall.
 *
 * A run that ends in "the provider never started a reply" or "timed out before
 * we could match a reply to this question" is almost never something the user
 * can act on: the tab is signed in and the selectors are usually fine, but the
 * page has been sitting hidden long enough that its app has wedged, or it is
 * showing a state — an interstitial, a half-loaded thread, a dead socket — that
 * nothing short of a reload clears. Reporting it is a dead end. Throwing the
 * window away and opening a fresh one is what actually fixes it, so
 * `ask-provider.js` does that and asks again before it ever mentions a problem.
 *
 * The scope of the teardown is the whole point:
 *
 *  - Nothing else in flight: close every relay window. That is the "close all
 *    the windows, then open it again" reset, and it also sweeps up strays and
 *    duplicates that `closeRelay` adopts on the way out.
 *  - Something else still streaming (compare mode asks three providers at once):
 *    close only the stalled provider's own tab. Tearing down the shared window
 *    would kill the two answers that are arriving normally, and each of those
 *    would then recover by closing the window the others had just reopened.
 */

/** Let Chrome finish closing before anything asks for a window again. */
const SETTLE_MS = 700;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Close everything the extension hosts providers in. Also the Close relay
 * command — releasing the pins first is not optional, an orphaned
 * `chrome.debugger` attachment leaves its infobar behind on a tab that is about
 * to disappear.
 */
export async function resetRelay() {
  await releaseAllTabs();
  await closeRelay();
  await embedded.closeOffscreen().catch(() => {});
}

/**
 * Throw away whatever this provider was talking through, so the next attempt
 * builds it from scratch. Returns what was actually closed, for the log line.
 */
export async function recoverProvider(provider, settings) {
  // Our own request holds a `recovering` placeholder so Stop can still find it;
  // anything else in the map is someone else's answer, mid-stream.
  const alone = [...inflight.values()].every((entry) => entry.recovering);

  if (isEmbedded(settings)) {
    if (alone) await resetRelay();
    else await embedded.dropFrame(provider.id).catch(() => {});
  } else if (alone) {
    await resetRelay();
  } else {
    const tabId = getRelayTabId(provider.id);
    if (tabId != null) {
      await releaseTab(tabId);
      await chrome.tabs.remove(tabId).catch(() => {});
      // onRemoved forgets it too, but not before the next `ensureProviderTab`
      // could look the id up and wait on a tab that no longer exists.
      forgetTab(tabId);
    }
  }

  await sleep(SETTLE_MS);
  return alone ? 'relay' : 'tab';
}
