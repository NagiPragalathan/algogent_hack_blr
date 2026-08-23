/**
 * Everything that reaches into a tab: talking to the content script, waiting
 * for the page to stop moving, and photographing it.
 */

import { MAX_FULL_SHOTS } from './limits.js';
import {
  beginTabSession,
  endTabSession,
  gatherTabs,
  scatterTabs,
  setWaitingOnUser
} from './session-tabs.js';

export { setWaitingOnUser };

/** Both halves, always. See the comment in sendToPage for why. */
const AGENT_SCRIPTS = ['src/content/page-context.js', 'src/content/agent-page.js'];

/**
 * Ask the page for something, injecting the agent's content scripts if needed.
 *
 * "Needed" covers two cases, and only one of them throws.
 *
 * With nothing injected, `sendMessage` rejects — no receiver — which is the
 * obvious one. But a tab can also hold `page-context.js` *without*
 * `agent-page.js`: the chat path injects the extractor by itself when a tab
 * pre-dates the extension, and that is the very tab you then point the agent
 * at. Its listener receives this message, sees a type it does not handle, and
 * returns without answering. A receiver existed, so nothing rejects — the call
 * simply resolves `undefined`, the catch never runs, agent-page.js is never
 * injected, and every run dies on step 0 with "Could not read the starting
 * page". Silence has to mean the same thing as refusal here.
 */
export async function sendToPage(tabId, message, frameId = null) {
  /**
   * `frameTargeted` is what tells a subframe it is being spoken to.
   *
   * Chrome's own `{frameId}` routing already delivers only to that frame, so
   * this is redundant on the happy path — and it is not redundant on the one
   * that matters. A message sent WITHOUT a frameId goes to every frame in the
   * tab and settles on whoever answers first, so the moment these scripts live
   * in subframes an ad iframe can win an observation. The content script
   * ignores anything untargeted unless it is the top frame; this flag is the
   * only way it can tell the difference.
   */
  const payload = { target: 'agent-page', ...message };
  if (frameId != null) payload.frameTargeted = true;

  const options = frameId != null ? { frameId } : undefined;
  const ask = () =>
    chrome.tabs.sendMessage(tabId, payload, options).catch(() => null);

  // An `{ok: false}` reply is still a reply — the page answered and said no.
  // Only a falsy result means nobody on the other end handled this.
  const first = await ask();
  if (first) return first;

  try {
    await chrome.scripting.executeScript({
      target: frameId != null ? { tabId, frameIds: [frameId] } : { tabId },
      files: AGENT_SCRIPTS
    });
  } catch (err) {
    return { ok: false, error: 'Cannot reach this page: ' + String(err?.message || err) };
  }

  const second = await ask();
  return (
    second || {
      ok: false,
      error:
        'This page loaded the agent scripts but did not answer. Reload the tab ' +
        'and try again — Chrome blocks extensions on its own pages and on the ' +
        'Web Store, and a page that is still loading can drop the first message.'
    }
  );
}

/**
 * Which tabs currently believe the agent is driving them.
 *
 * Tracked here rather than in the loop because a run changes tabs — it can
 * navigate, open one, or switch — and every tab it has touched has to be
 * released at the end. The loop only knows where it is now; this knows
 * everywhere it has been.
 */
const controlled = new Set();

/**
 * Tabs whose page has CONFIRMED the curtain is up — a different fact from owning
 * the tab, and it used to be the same one.
 *
 * `controlled` is ownership: `mayUseTab`, the tab-group guard and
 * `userIsWatching` all read it, so it has to be true the moment a run claims a
 * tab. Whether the overlay actually went up is a property of a DOCUMENT, and
 * the send that draws it can land nowhere — mid-navigation, content script not
 * in yet, a restricted page. That failure was swallowed and the tab marked
 * controlled anyway, so `takeControl` returned early ever after and the curtain
 * was never drawn again for the rest of the run. Kept apart, an unconfirmed
 * curtain is simply retried on the next step.
 */
const curtained = new Set();

/**
 * Put the page under the agent's control, or hand it back.
 *
 * The page draws a curtain that takes clicks and says who is driving. Two
 * clicks landing on the same page from two directions is not a race the user
 * can win: the model chose what to click from an observation taken before the
 * user's click changed the page, so it acts on a page that no longer exists and
 * reports something that never happened.
 */
export async function takeControl(tabId) {
  if (tabId == null) return;

  const claiming = !controlled.has(tabId);
  controlled.add(tabId);

  if (!curtained.has(tabId)) {
    const ack = await sendToPage(tabId, { type: 'AGENT_CONTROL', on: true }).catch(() => null);
    // Only a reply proves the page drew anything. `loop.js` calls this every
    // step, so leaving it unconfirmed is what makes the retry happen.
    if (ack?.ok) curtained.add(tabId);
  }

  if (claiming) await gatherTabs([...controlled]);
}

/**
 * Name and colour this run's tab group before anything is taken over.
 *
 * Called once from `run.js`, which is the only layer that knows both the task
 * (the group's name) and the panel chat it belongs to (its colour). The tab
 * session also installs the guard that keeps the user's own new tabs out of the
 * group — see `session-tabs.js` — so it has to be up before the first
 * `takeControl`, not after the first group exists.
 */
export function startTabSession({ task, sessionId }) {
  beginTabSession({ task, sessionId, claims: agentOpened });
}

/**
 * Is the agent acting on a page right now?
 *
 * The whole of tab ownership hangs off this. A run is mostly a provider round
 * trip — ten to forty seconds in which nothing is clicked and the curtain is up
 * — and a tab that appears during THAT is the user's, by elimination: the
 * curtain swallows their trusted clicks, so the only thing that can open a tab
 * from a page we are driving is our own synthetic click.
 *
 * A counter rather than a flag, because `settle` can overlap the next plan, and
 * a trailing grace because the tab a click opens does not always arrive in the
 * same task as the click. 1.2s is long enough for Chrome to create the tab and
 * far shorter than the gap to the next provider reply.
 */
let acting = 0;
const ACTION_GRACE_MS = 1200;

export async function duringAction(run) {
  acting += 1;
  try {
    return await run();
  } finally {
    setTimeout(() => {
      acting = Math.max(0, acting - 1);
    }, ACTION_GRACE_MS);
  }
}

export const isActing = () => acting > 0;

/**
 * Would this run claim a tab that has just appeared?
 *
 * Yes if it is already being driven, or if the agent was mid-action when it
 * appeared. Everything else is the user opening a tab for themselves, and the
 * run must not follow it, curtain it, or let Chrome file it under the agent's
 * group — which is the failure all three of those descriptions share.
 */
export function agentOpened(tab) {
  if (tab?.id != null && controlled.has(tab.id)) return true;
  return acting > 0;
}

export const isControlled = (tabId) => controlled.has(tabId);

/**
 * Is the user watching this run, or working somewhere else?
 *
 * The whole focus policy turns on this one question, and it is the difference
 * between an agent that is *demonstrating* and an agent that is *interrupting*.
 * Someone looking at one of the run's own tabs has chosen to watch it: bringing
 * the next tab forward is showing them what it is doing, which is the point.
 * Someone who has moved to a tab of their own has chosen not to, and stealing
 * the foreground from them is the single rudest thing this extension can do —
 * the page they were reading vanishes mid-sentence, with no click of their own
 * to explain it.
 *
 * Measured against the FOCUSED window's active tab, not "is any of our tabs
 * active anywhere": a run's tab sitting active in a background window is not
 * something anybody is looking at.
 */
export async function userIsWatching() {
  if (!controlled.size) return false;
  try {
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return Boolean(active && controlled.has(active.id));
  } catch {
    // Unknowable means "do not take the foreground". The cost of being wrong in
    // that direction is a screenshot skipped; the other way it is the user's
    // page disappearing while they read it.
    return false;
  }
}

/**
 * Bring a tab forward, but only if the user is already following along.
 *
 * Called when the run moves between the tabs it was given, so that watching an
 * agent read one tab and fill in another looks like what it is. It is a no-op
 * for someone working elsewhere, which is the same rule the camera obeys.
 */
export async function followFocus(tabId) {
  if (tabId == null || !controlled.has(tabId)) return false;
  if (!(await userIsWatching())) return false;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || tab.active) return false;
  await chrome.tabs.update(tabId, { active: true }).catch(() => {});
  return true;
}

/**
 * A navigation throws the overlay away, and the tab still says it has one.
 *
 * `controlled` remembers tabs, but the curtain, the border and the pointer live
 * in a *document* — so the moment the agent navigates, or follows a link, the
 * new page comes up bare and `takeControl` returns early because the tab is
 * already in the set. Measured on a run that searched Google mid-task: the
 * results page had no border, no curtain and no pointer for the rest of the
 * run, so the one page the user was actually looking at was the one with no
 * sign the agent was driving it — and its clicks were live again, which is the
 * failure the curtain exists to prevent.
 *
 * Called after a navigation settles rather than on the navigation event: the
 * content script has to be in the new document before it can be told anything,
 * and `settle` is what waits for that.
 */
export async function retakeControl(tabId) {
  if (tabId == null) return;
  // The document changed and took the overlay with it. Ownership is unchanged,
  // so only the drawn-ness is forgotten — re-claiming would re-run the tab
  // grouping on every navigation for nothing.
  curtained.delete(tabId);
  await takeControl(tabId);
}

/**
 * Follow a tab the *page* opened, not one the agent asked for.
 *
 * `open_tab` is the agent's own doing and already routes through `onTabChange`.
 * This is the other half: a `target="_blank"` link, a "Continue on the employer
 * site" button, an OAuth popup. Chrome puts that page in a new tab with no
 * announcement, so the run carried on driving the tab it started in — which by
 * then is a page that has finished its part and is showing nothing the task
 * needs. From the panel that reads as the agent freezing on a stale page for
 * the rest of its steps.
 *
 * Two tests, and the second one is the one that was missing. `openerTabId` says
 * the tab came out of a page we are driving — necessary, and nowhere near
 * sufficient, because a Ctrl+click, a middle-click and "open link in new tab"
 * all set it too. So a run followed the user into the tab THEY had just opened,
 * curtained it, and carried on working there: they went to read something else
 * for thirty seconds and came back to find the agent had moved in.
 *
 * `agentOpened` closes it. A page can only open a tab in response to a click,
 * the curtain eats the user's clicks for the whole run, so a tab that appears
 * while the agent is mid-action is the agent's and a tab that appears in the
 * long wait between actions is theirs. `onOpened` is told which, rather than
 * simply not being called: a run that silently ignores a tab the user is now
 * looking at should say so once, and only the loop can put that in the timeline.
 */
let openedTabListener = null;

export function watchOpenedTabs(onOpened) {
  stopWatchingOpenedTabs();

  openedTabListener = (tab) => {
    if (tab.openerTabId == null || !controlled.has(tab.openerTabId)) return;
    onOpened(tab, agentOpened(tab));
  };

  chrome.tabs.onCreated.addListener(openedTabListener);
}

/**
 * Torn down by `releaseControl`, which is the one thing already guaranteed to
 * run on every path out of a run — finished, cancelled, thrown, or refused in
 * preflight. A listener left registered would keep firing into a closure that
 * belongs to a run that ended, and quietly curtain a tab with nothing driving
 * it, which is the exact failure the curtain teardown exists to prevent.
 */
function stopWatchingOpenedTabs() {
  if (!openedTabListener) return;
  chrome.tabs.onCreated.removeListener(openedTabListener);
  openedTabListener = null;
}

/** Hand every tab this run touched back to the user. Always safe to call. */
export async function releaseControl() {
  stopWatchingOpenedTabs();
  const tabs = [...controlled];
  controlled.clear();
  curtained.clear();
  // Before the scatter, so the guard cannot eject a tab out of a group that is
  // about to be dissolved anyway, and so no pulse survives the run.
  endTabSession();
  // Before the curtains come down, so a slow ungroup cannot leave the last tab
  // looking like it is still being driven.
  await scatterTabs();
  await Promise.all(
    tabs.map((tabId) =>
      chrome.tabs
        .sendMessage(tabId, { target: 'agent-page', type: 'AGENT_CONTROL', on: false })
        .catch(() => {})
    )
  );
}

/**
 * Read the page: element list, and page text when it is not already known.
 *
 * `sentTextFor` is the {url, modal} mark of the text the model has already been
 * shown; the page decides for itself whether that is still current, so one round
 * trip covers both "did it change" and "here it is".
 *
 * `deep` scrolls the page to the bottom before reading it — the only way to see
 * a list that renders as you scroll. It costs several seconds on the user's own
 * tab, so it is asked for per observation, never assumed.
 */
export function observePage(
  tabId,
  { query, maxChars, sentTextFor = null, deep = false, budgetMs, frameId = null }
) {
  return sendToPage(
    tabId,
    { type: 'AGENT_OBSERVE', query, maxChars, sentTextFor, deep, budgetMs },
    frameId
  );
}

/**
 * The frames of a tab, with the agent scripts put into all of them.
 *
 * Done on demand rather than by `all_frames` in the manifest, and that is a
 * deliberate trade. Declaring all_frames would also put `page-context.js` into
 * every ad slot and tracking pixel on every page the user visits — the chat
 * path broadcasts to a tab with no frameId, so each of those becomes another
 * racer for a reply that is supposed to describe the page you are reading.
 * Injecting here means the cost is paid by the one run that needs it, on the
 * one tab it is driving.
 *
 * Frames are matched to the page's own census by URL, never by position.
 * Chrome does not promise the order `executeScript` returns its results in,
 * and "close enough, probably document order" is the kind of assumption that
 * silently sends a use_frame into a tracking pixel — the model would then be
 * shown an empty document and told it was the application form.
 */
export async function reachFrames(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: AGENT_SCRIPTS
    });
  } catch {
    // A page can refuse the whole injection. The top frame is still driveable,
    // which is where we already were.
    return [];
  }

  try {
    const seen = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => location.href
    });
    return seen
      .filter((r) => r.frameId != null && typeof r.result === 'string')
      .map((r) => ({ frameId: r.frameId, url: r.result }));
  } catch {
    return [];
  }
}

/**
 * The frameId for the frame the page listed at `index` (1-based).
 *
 * A frame's `src` and the URL it has actually settled on are not always the
 * same string — a redirect, a fragment the app added, `about:blank` replaced
 * after load — so this narrows rather than demanding equality: exact match
 * first, then same origin and path, then same origin. Anything looser would
 * start matching the wrong frame on a page that embeds two of the same widget,
 * which is the common case for a chat box plus its own notification frame.
 */
export function frameIdFor(frames, listed) {
  if (!listed?.url) return null;

  const exact = frames.find((f) => f.url === listed.url);
  if (exact) return exact.frameId;

  const stem = (url) => {
    try {
      const u = new URL(url);
      return { origin: u.origin, path: u.origin + u.pathname };
    } catch {
      return null;
    }
  };

  const want = stem(listed.url);
  if (!want) return null;

  const byPath = frames.find((f) => stem(f.url)?.path === want.path);
  if (byPath) return byPath.frameId;

  return frames.find((f) => stem(f.url)?.origin === want.origin)?.frameId ?? null;
}

export function waitForLoad(tabId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timer);
      resolve();
    };
    const onUpdated = (id, info) => {
      if (id === tabId && info.status === 'complete') finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId).then(
      (tab) => tab.status === 'complete' && finish(),
      () => finish()
    );
  });
}

/** One pulse, no re-injection — this is polled, so it must stay cheap. */
async function pulseOnce(tabId) {
  try {
    return await chrome.tabs.sendMessage(tabId, { target: 'agent-page', type: 'AGENT_PULSE' });
  } catch {
    return null;
  }
}

/**
 * Return as soon as the page stops changing, rather than after a fixed sleep.
 *
 * A blanket "wait 1.5s after every action" is most of the dead time in a
 * browser agent: it is far too long for a menu that opened instantly and far
 * too short for a search page still fetching. Polling a cheap fingerprint until
 * two readings agree costs ~300ms on a fast page and stays patient on a slow
 * one, which is the behaviour that actually makes a run feel quick.
 */
export async function settle(tabId, maxMs = 4000) {
  const deadline = Date.now() + maxMs;
  let previous = null;

  while (Date.now() < deadline) {
    const now = await pulseOnce(tabId);

    if (
      now?.ok &&
      now.ready === 'complete' &&
      previous &&
      previous.url === now.url &&
      previous.nodes === now.nodes
    ) {
      return;
    }

    previous = now?.ok ? now : null;
    await new Promise((r) => setTimeout(r, 140));
  }
}

/**
 * A picture of the tab, as a data URL.
 *
 * captureVisibleTab only ever photographs the focused tab of a window, so the
 * target has to be brought forward first. The previously active tab is put back
 * afterwards — an agent step should not quietly rearrange the user's browser.
 */
export async function captureTab(tabId, { label = 'Agent screenshot' } = {}) {
  /**
   * Our own overlay must not end up in the model's eyes.
   *
   * The curtain, its moving frame and the "Agent is in control" pill are drawn
   * over the page, so a screenshot taken with them up shows the model a dimmed
   * page with a badge on it — and it will describe them, or worse, try to click
   * them. Hidden for the length of the capture and put straight back; the
   * listeners that block real clicks stay installed throughout.
   */
  const veil = (visible) =>
    chrome.tabs
      .sendMessage(tabId, { target: 'agent-page', type: 'AGENT_OVERLAY', visible })
      .catch(() => {});

  try {
    const tab = await chrome.tabs.get(tabId);
    const [wasActive] = await chrome.tabs.query({ active: true, windowId: tab.windowId });

    /**
     * A photograph is not worth taking the screen away from someone.
     *
     * `captureVisibleTab` only ever photographs the active tab of a window, so
     * this used to activate whatever it wanted to see — several times a run,
     * since most of a run's pictures are the loop's own idea. For anyone who
     * had switched to a tab of their own that is the page they are reading
     * being yanked away and handed back a second later, repeatedly, with
     * nothing on screen explaining it. It is the single most intrusive thing
     * the extension does and it was doing it for a screenshot.
     *
     * Note what does NOT need activating: a tab that is already active in its
     * own window photographs fine even when that window is behind another, so
     * a run in a background window is unaffected. Only pulling a background tab
     * forward is in question, and that now needs the user to be watching.
     */
    // Nothing to undo: the veil is only lowered below, so declining here leaves
    // the page exactly as it was.
    if (!tab.active && !(await userIsWatching())) return null;

    if (!tab.active) {
      await chrome.tabs.update(tabId, { active: true });
      // Only a tab that was just brought forward needs the compositor to catch
      // up; paying 250ms for one that was already on screen is dead time on the
      // path the loop now takes several times a run.
      await new Promise((r) => setTimeout(r, 250));
    }

    await veil(false);
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: 'jpeg',
      quality: 55
    });
    await veil(true);

    /**
     * Show it, here rather than at the call site.
     *
     * Most of the pictures a run takes are the loop's own idea — a step that
     * failed, a page that is all pixels, a form that keeps refusing — and those
     * captures went through here without ever telling the page, so the flash
     * and the thumbnail only ever appeared for the one case where the model
     * asked out loud. From the user's side that reads as an animation that
     * mostly does not work, when in fact most screenshots were silent.
     *
     * After the veil goes back up, never before: fire it earlier and the
     * overlay is in the picture the model is about to be shown.
     */
    sendToPage(tabId, {
      type: dataUrl ? 'AGENT_SHOT' : 'AGENT_FLASH',
      image: dataUrl,
      label
    }).catch(() => {});

    if (wasActive && wasActive.id !== tabId) {
      await chrome.tabs.update(wasActive.id, { active: true }).catch(() => {});
    }
    return dataUrl;
  } catch {
    // Failing between the two veils would leave the page permanently hiding
    // the very overlay that is still swallowing the user's clicks.
    await veil(true);
    return null;
  }
}

/**
 * The whole page in one picture: scroll, capture, stitch.
 *
 * `captureVisibleTab` is the only capture an extension gets without attaching
 * the debugger, and it photographs exactly the viewport — so a long form, a
 * receipt, a chart below the fold or a table with twelve rows off screen can
 * only be seen a screenful at a time. The model then decides from the top
 * third of a page and says so with complete confidence.
 *
 * `load` first walks the page to the bottom and back, for the lists that only
 * render what you have scrolled past. It is a separate flag because it is not
 * free — a virtualised feed can take seconds — and most pages do not need it.
 *
 * Three things bound the cost, and all of them matter: `MAX_FULL_SHOTS`
 * screenfuls (a stitched image is one attachment, and an eight-thousand-pixel
 * JPEG is a slow upload for a model that will downscale it anyway), a wait
 * between captures (`captureVisibleTab` is rate-limited to about two a second
 * and throws rather than queueing), and the page's own scroll position put
 * back at the end — the user did not ask for their page to move.
 */
export async function captureFullTab(tabId, { load = false, label } = {}) {
  const veil = (visible) =>
    chrome.tabs
      .sendMessage(tabId, { target: 'agent-page', type: 'AGENT_OVERLAY', visible })
      .catch(() => {});

  const pause = (ms) => new Promise((r) => setTimeout(r, ms));

  try {
    const tab = await chrome.tabs.get(tabId);
    const [wasActive] = await chrome.tabs.query({ active: true, windowId: tab.windowId });

    // The same rule as the single capture, and it matters more here: a stitched
    // shot is one photograph per screenful, so the tab would be held in front of
    // the user for seconds rather than a moment.
    if (!tab.active && !(await userIsWatching())) return null;

    if (!tab.active) {
      await chrome.tabs.update(tabId, { active: true });
      await pause(250);
    }

    if (load) {
      const loaded = await sendToPage(tabId, { type: 'AGENT_LOAD_ALL' });
      if (loaded?.ok) await pause(300);
    }

    const page = await sendToPage(tabId, { type: 'AGENT_METRICS' });
    if (!page?.ok) return null;

    const { innerHeight, scrollHeight, dpr = 1, scrollY: was = 0 } = page;
    const screenfuls = Math.min(
      MAX_FULL_SHOTS,
      Math.max(1, Math.ceil(scrollHeight / Math.max(1, innerHeight)))
    );

    await veil(false);

    const tiles = [];
    let reached = -1;

    for (let i = 0; i < screenfuls; i++) {
      const asked = i * innerHeight;
      const moved = await sendToPage(tabId, { type: 'AGENT_SCROLL_TO', y: asked });

      /**
       * Where the page actually went, not where we asked it to go.
       *
       * The last screenful is the one that matters: a page is rarely a whole
       * number of viewports, so the browser clamps the final scroll to
       * `scrollHeight - innerHeight`. Pasting that tile at the offset we
       * *asked* for slides it down by the difference — the bottom of the image
       * repeats a band it already had and loses the real end of the page.
       */
      const y = Number.isFinite(moved?.scrollY) ? moved.scrollY : asked;

      // Clamped onto a tile we already have: the page has no more to show.
      if (y <= reached) break;
      reached = y;

      // Long enough for the rate limit and for the page to paint what the
      // scroll revealed. Below about 500ms captureVisibleTab starts throwing.
      await pause(i === 0 ? 260 : 560);

      const shot = await chrome.tabs
        .captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 55 })
        .catch(() => null);
      if (!shot) break;

      tiles.push({ shot, y });
    }

    await sendToPage(tabId, { type: 'AGENT_SCROLL_TO', y: was });
    await veil(true);

    const dataUrl = tiles.length > 1 ? await stitch(tiles, dpr) : tiles[0]?.shot || null;

    sendToPage(tabId, {
      type: dataUrl ? 'AGENT_SHOT' : 'AGENT_FLASH',
      image: dataUrl,
      label: label || `Agent screenshot · whole page (${tiles.length})`
    }).catch(() => {});

    if (wasActive && wasActive.id !== tabId) {
      await chrome.tabs.update(wasActive.id, { active: true }).catch(() => {});
    }

    return dataUrl ? { dataUrl, screenfuls: tiles.length, capped: screenfuls === MAX_FULL_SHOTS } : null;
  } catch {
    await veil(true);
    return null;
  }
}

/**
 * The screenfuls, drawn into one tall image.
 *
 * In the worker, with `OffscreenCanvas`: there is no DOM here, and an offscreen
 * document for one paste-up would cost more than the captures did. Tiles are
 * placed at the scroll offset they were taken at, so the last one — which
 * usually overlaps the one before it, because a page is rarely a whole number
 * of screenfuls — simply paints over the repeat.
 *
 * A sticky header repeats down the seam. That is inherent to scroll-and-stitch
 * and it is worth less than the pixels below the fold.
 */
async function stitch(tiles, dpr) {
  const bitmaps = [];
  for (const tile of tiles) {
    const blob = await (await fetch(tile.shot)).blob();
    bitmaps.push({ bitmap: await createImageBitmap(blob), y: tile.y });
  }

  const width = bitmaps[0].bitmap.width;
  const last = bitmaps[bitmaps.length - 1];
  const height = Math.round(last.y * dpr) + last.bitmap.height;

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  for (const { bitmap, y } of bitmaps) {
    ctx.drawImage(bitmap, 0, Math.round(y * dpr));
    bitmap.close();
  }

  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.55 });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:image/jpeg;base64,${btoa(binary)}`;
}
