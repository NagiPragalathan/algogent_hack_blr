import { ensureProviderTab, resetProviderTab, getRelayTabId } from '../relay.js';
import * as embedded from '../embedded.js';
import { keepTabAwake } from './keep-awake.js';
import { recoverProvider } from './recover.js';
import { isEmbedded } from '../state/settings.js';
import { getConversationUrls } from '../state/conversations.js';
import { askDirect, warmDirect, directOnly, declineReason } from './direct/index.js';
import {
  inflight,
  streamKey,
  startKeepAlive,
  stopKeepAliveIfIdle
} from './inflight.js';

/** Hand the adapter its config, then the adapter itself. */
async function injectAdapter(tabId, provider, settings) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (cfg) => {
      window.__SIDEBAR_AI = cfg;
    },
    args: [{ provider, settings }]
  });
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['src/adapters/adapter.js']
  });
}

/**
 * Open the provider's window and arm it, without asking it anything yet.
 *
 * Everything up to `ready` — creating the relay window, loading the app,
 * arming the anti-throttle layers, injecting the adapter — is "opening the
 * provider", and on a cold start it is most of the wait before a single
 * character is typed. It also has nothing to do with the prompt, and a run
 * spends several seconds *before* its first prompt exists: reading the page,
 * scrolling it for a deep observation, capturing a screenful at a time for the
 * survey picture. All of that used to happen with the provider window still
 * shut.
 *
 * So it is started in parallel and never awaited. `ensureProviderTab` is
 * single-flighted per provider, so the real `attemptAsk` behind it either joins
 * this promise or finds the tab already open — there is no second window and no
 * race to lose. Best-effort throughout: a failure here is retried, reported and
 * recovered from by the ask itself, and warming must not be able to fail a run
 * that would otherwise have worked.
 *
 * `fresh` deliberately does NOT navigate to the new-chat URL. That is
 * `resetProviderTab`'s job at ask time, and doing it twice means loading the
 * app twice; what is worth pre-paying is the window and the first load, which
 * is the expensive half. For the same reason the adapter is only injected when
 * the ask will not be navigating away from it.
 */
export async function warmProvider(
  provider,
  settings,
  { scope = 'chat', sessionId = null, fresh = false, allowDirect = true } = {}
) {
  /**
   * A provider we can reach directly needs no window at all, so the warm-up is
   * the session fetch rather than an app load — and building the relay anyway
   * would put a taskbar entry and a debugger infobar behind an answer that is
   * never going to use either. Only skipped once the session has actually
   * resolved, and only when this caller can use it: see `warmDirect`, and
   * `allowDirect` on `askProvider` for why a run cannot.
   */
  if (allowDirect && !(await getConversationUrls(scope, sessionId))[provider.id]) {
    if (await warmDirect(provider, settings).catch(() => false)) return;

    /**
     * Under `strict` the ask below is going to refuse rather than fall back, so
     * building the window here would put a taskbar entry and a debugger infobar
     * on screen for a request that is never going to touch either — which is
     * precisely the thing the setting was turned on to stop. Warming is
     * best-effort and unobservable, so declining to warm costs nothing.
     */
    if (directOnly(provider, settings)) return;
  }

  if (isEmbedded(settings)) return;

  try {
    const resumeUrl = fresh
      ? null
      : (await getConversationUrls(scope, sessionId))[provider.id] || null;

    const tabId = await ensureProviderTab(provider, settings, resumeUrl);
    await keepTabAwake(tabId, settings);
    if (!fresh) await injectAdapter(tabId, provider, settings);
  } catch {
    /* the ask does all of this again, and reports properly when it fails */
  }
}

/**
 * How many times one question may be put to a provider, recovery included.
 *
 * Three, not more: every attempt costs a full response timeout, so a provider
 * that is genuinely down would otherwise keep the panel busy for a quarter of an
 * hour before saying so — which reads as broken just as much as an error does.
 */
const MAX_ATTEMPTS = 3;

/**
 * Send one prompt to one provider. Resolves with the final reply once the run
 * settles, so callers that need the text — the agent loop — can await it, while
 * the panel keeps getting the same streaming events it always did.
 *
 * A stall is recovered from rather than reported. "Timed out before the
 * provider produced a reply we could match to this question" and its siblings
 * name a cause the reader cannot usually do anything about, and the fix is
 * nearly always mechanical: close the window, open a new one, ask again. So
 * that is what happens here, and the error is only shown once the last attempt
 * has also failed — see `recover.js` for how much gets torn down.
 *
 * The failed attempt's `error` event is swallowed on the way past, because the
 * panel renders one and never un-renders it: leaving it in place would put a
 * red "it timed out" above the answer that arrived a minute later.
 */
export async function askProvider({
  reqId,
  provider,
  settings,
  prompt,
  post,
  image = null,
  /**
   * Which of the provider's two threads this belongs to — see
   * `state/conversations.js`. A chat accumulates on purpose; an agent run must
   * not inherit the last run's conclusions, and must not leave forty turns of
   * JSON above the user's next question.
   */
  scope = 'chat',
  /**
   * Which panel chat this belongs to, so its provider thread is filed under it.
   *
   * Null keeps the old shared bucket, which is what an untracked request and the
   * chat scope still use — the panel manages those itself through
   * `SET_CONVERSATIONS`. See `state/conversations.js` for why one slot per
   * provider was not enough.
   */
  sessionId = null,
  /** Start a new thread rather than resuming. The first turn of a run. */
  fresh = false,
  /**
   * Whether this conversation may be answered over the provider's own API.
   *
   * False for an agent run, and the reason is the one-transport-per-thread rule
   * in `direct/index.js` rather than anything about speed. A run's turns are
   * one accumulating conversation, and some of them carry a screenshot — which
   * the direct path cannot deliver, so those turns would have to go through the
   * window and would land in a different provider thread from the ones around
   * them. The model would then be reasoning about a page from a conversation
   * missing the steps that got there, which is the "finished · 0 steps"
   * failure this codebase has already paid for once. Dropping the picture
   * instead is worse still: the message says one is attached.
   *
   * So a run keeps the window, where every turn — text or picture — goes to the
   * same place. Making this true would mean an upload flow per engine first.
   */
  allowDirect = true,
  /**
   * Chat traffic or an agent run, which is the only thing `pace.js` needs to
   * know to tell the two apart. A run is thirty to forty back-to-back turns and
   * gets a wider floor between them; a person typing questions supplies their
   * own. Nothing else reads it.
   */
  intent = 'chat'
}) {
  const key = streamKey(reqId, provider.id);

  /**
   * The provider's own API first, and the window only when that cannot answer.
   *
   * Everything below this line — opening a window, loading an app, pinning it
   * awake, injecting an adapter, typing, clicking, and then polling the DOM
   * until the text has not changed for `stabilityMs` — is what it takes to
   * drive a page. None of it is needed to POST to the endpoint that page posts
   * to, and the difference is most of the wait. See `direct/index.js`.
   *
   * Null means "not this transport": the provider has no engine, the turn
   * carries a file, the window already owns this thread, or it failed before a
   * character reached the panel. In every one of those cases nothing has been
   * shown and nothing has to be explained, so the loop below proceeds exactly
   * as it always did.
   */
  const direct = await askDirect({
    reqId,
    provider,
    settings,
    prompt,
    post,
    image,
    scope,
    sessionId,
    allowDirect,
    intent
  });
  if (direct) return direct;

  /**
   * "No popup" taken literally, when the user has asked for that.
   *
   * Everything below opens a window. On `auto` that is the whole point — the
   * question still gets answered, just slower — but it is also what makes the
   * failure invisible AND permanent: the window that answers files a
   * conversation URL, and `askDirect` then declines this chat for good, long
   * after the transient 403 or expired token that started it has cleared. On
   * `strict` the refusal is reported instead, carrying the reason `askDirect`
   * recorded on its way out, because "a window opened" with no explanation is
   * the state that cannot be acted on.
   *
   * Housekeeping is exempt: `scope: 'none'` never opens a window anyway (see
   * below), and turning a silent skip into a visible error would put a red
   * message over a chat title nobody asked for.
   */
  if (allowDirect && scope !== 'none' && directOnly(provider, settings)) {
    const why = declineReason(provider.id) ?? 'The direct API could not answer this turn.';
    const error =
      `${provider.name ?? provider.id} is set to No popup and no window will be opened for it. ${why}`;

    post({ type: 'STREAM', reqId, providerId: provider.id, via: 'direct', state: 'error', error });
    return { state: 'error', text: '', error };
  }

  /**
   * Naming a chat is never worth building a window for.
   *
   * `scope: 'none'` is housekeeping the user did not ask for, and letting it
   * reach the code below is what put a whole second UI on screen: a relay
   * window opened, Chrome's "started debugging this browser" bar appeared over
   * it, and because that request has no thread of its own it opened a NEW
   * ChatGPT conversation — so the user's own history filled up with an entry
   * called "Name this conversation. Reply with a title of AT MOST 6 words",
   * one for every chat they started. All of it to fill in a label they can
   * already read.
   *
   * A window that is ALREADY open is a different matter: the exchange goes into
   * the conversation it is sitting in, costs nothing, and is what this feature
   * was designed as. Anything else keeps the truncated first question, which is
   * what the panel is showing anyway.
   */
  if (
    scope === 'none' &&
    /**
     * A window this chat is not in is worse than no title.
     *
     * Housekeeping carries no thread of its own — it joins the chat's. When the
     * chat is API-owned there is no URL to resume, and `ensureProviderTab` with
     * a null resume URL reuses the relay tab EXACTLY as it stands: whatever
     * conversation it was last left in, quite possibly another chat's. So the
     * naming question lands there, the provider titles that conversation after
     * it, and the user's history grows an entry about naming conversations. The
     * panel keeps the truncated first question, which is what it was showing.
     */
    (directOnly(provider, settings) ||
      (!isEmbedded(settings) && getRelayTabId(provider.id) == null))
  ) {
    return { state: 'skipped', text: '', error: null };
  }

  for (let attempt = 1; ; attempt += 1) {
    const lastTry = attempt >= MAX_ATTEMPTS;

    const sink = lastTry
      ? post
      : (msg) => {
          if (msg.type === 'STREAM' && msg.state === 'error') return;
          post(msg);
        };

    const result = await attemptAsk({
      reqId,
      provider,
      settings,
      prompt,
      post: sink,
      image,
      scope,
      sessionId,
      fresh
    });

    // Anything but `error` is the caller's business: `done` is an answer,
    // `need_login` needs a human, and a run settled from outside (the user
    // pressed stop) leaves `error` unset — retrying any of those is wrong.
    if (result.state !== 'error' || lastTry) return result;

    post({
      type: 'ASK_RETRY',
      reqId,
      providerId: provider.id,
      attempt,
      of: MAX_ATTEMPTS - 1,
      error: result.error
    });

    /**
     * Hold the slot while the window is rebuilt.
     *
     * Stop finds a request through `inflight`, and the attempt that just failed
     * removed its own entry. Without a placeholder here, pressing Stop during
     * recovery cancels nothing, tells the panel nothing, and the retry goes
     * ahead anyway — the one moment in a run where the button does not work.
     * `recovering` marks it as having no page to tick or tear down.
     */
    const gap = { cancelled: false };
    inflight.set(key, {
      post,
      settle: () => {
        gap.cancelled = true;
      },
      tabId: null,
      providerId: provider.id,
      recovering: true
    });

    await recoverProvider(provider, settings);
    inflight.delete(key);

    if (gap.cancelled) return { ...result, state: 'cancelled', error: null };
  }
}

/** One prompt, one provider, one attempt. */
async function attemptAsk({
  reqId,
  provider,
  settings,
  prompt,
  post,
  image,
  scope = 'chat',
  sessionId = null,
  fresh = false
}) {
  const key = streamKey(reqId, provider.id);
  const result = { state: 'error', text: '', error: null };

  /**
   * Which transport is answering, stamped on everything the panel will read.
   *
   * Stamped HERE rather than at each `record` call because most of these states
   * come from the adapter, which sends them from inside the page and has no
   * idea there is another road. The panel's stage track used to word `ready` as
   * "Provider window open" unconditionally, which was a lie on the direct path
   * and merely unverifiable here; now each side says which it is, and the label
   * follows.
   */
  const via = isEmbedded(settings) ? 'frame' : 'window';

  const record = (msg) => {
    if (msg.type === 'STREAM') {
      result.state = msg.state;
      if (typeof msg.text === 'string') result.text = msg.text;
      if (msg.error) result.error = msg.error;
      post({ ...msg, via });
      return;
    }
    post(msg);
  };

  const fail = (error) =>
    record({ type: 'STREAM', reqId, providerId: provider.id, state: 'error', error });

  // `text: ''` rather than no text: on a retry the panel is still holding
  // whatever the abandoned attempt streamed, and it would sit there under the
  // spinner until the new answer overwrote it character by character.
  record({ type: 'STREAM', reqId, providerId: provider.id, state: 'connecting', text: '' });
  startKeepAlive();

  try {
    const resumeUrl = fresh ? null : (await getConversationUrls(scope, sessionId))[provider.id] || null;

    /**
     * Wait for the adapter to finish, but never forever.
     *
     * Every path that resolves this promise runs inside the relay tab. If that
     * tab is closed, navigated away, or its adapter is torn down by a page
     * reload, no event ever arrives and the request hangs for the life of the
     * panel — a spinner with nothing behind it. The watchdog turns that into an
     * error you can act on.
     */
    const awaitAdapter = (tabId, start) =>
      new Promise((resolve) => {
        let done = false;

        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(watchdog);
          inflight.delete(key);
          resolve();
        };

        const watchdog = setTimeout(
          () => {
            fail(
              'The provider stopped responding. Its window may have been ' +
                'closed or navigated away — ask again.'
            );
            finish();
          },
          (settings.responseTimeoutMs || 300000) + 30000
        );

        inflight.set(key, {
          post: record,
          settle: finish,
          tabId,
          providerId: provider.id,
          // Both carried so the conversation URL the adapter reports is filed
          // under the thread it belongs to AND the chat that owns it.
          scope,
          sessionId
        });

        start().catch((err) => {
          fail(String(err?.message || err));
          finish();
        });
      });

    if (isEmbedded(settings)) {
      if (settings.relaxCookies) await embedded.relaxCookiesForFrames(provider);

      // `ready` a touch early here: the frame is created inside `submit`, and
      // there is no window to open in this mode, so the two stages are the same
      // instant from the reader's point of view. In window mode below it is
      // reported where it actually happens.
      record({ type: 'STREAM', reqId, providerId: provider.id, state: 'ready' });

      await awaitAdapter(null, () =>
        embedded.submit(provider, settings, resumeUrl, reqId, prompt, image).catch((err) => {
          throw new Error(
            'Could not reach the background frame: ' +
              String(err?.message || err) +
              '. Switch Provider hosting to "Minimized window" in Settings if this persists.'
          );
        })
      );
      return result;
    }

    /**
     * A fresh thread has to be NAVIGATED to, not merely un-resumed.
     *
     * `ensureProviderTab` with no resume URL reuses the tab exactly as it
     * stands — which, after any earlier question, is still sitting in that
     * conversation. So passing `null` looks like "start clean" and is in fact
     * "carry on wherever you left off", which is the bug this whole scope
     * split exists to fix. `resetProviderTab` puts the tab on the provider's
     * new-chat URL and waits for it.
     */
    const tabId = fresh
      ? await resetProviderTab(provider, settings)
      : await ensureProviderTab(provider, settings, resumeUrl);

    // Before the adapter runs, not after: the layers that matter (focus
    // emulation, the lifecycle pin) have to be in place while the page is
    // streaming, and arming them afterwards would leave the first — usually
    // slowest — wait running throttled.
    await keepTabAwake(tabId, settings);

    await injectAdapter(tabId, provider, settings);

    // The window is open, the page has finished loading and the adapter is in
    // it — everything up to here is "opening the provider", and on a cold start
    // that is most of the wait. Saying so is the difference between a panel
    // that looks stuck and one that is visibly working through a queue.
    record({ type: 'STREAM', reqId, providerId: provider.id, state: 'ready' });

    await awaitAdapter(tabId, () =>
      chrome.tabs
        .sendMessage(tabId, { target: 'adapter', type: 'SUBMIT', reqId, text: prompt, image })
        .catch((err) => {
          throw new Error('Could not reach the provider tab: ' + String(err?.message || err));
        })
    );
  } catch (err) {
    inflight.delete(key);
    fail(String(err?.message || err));
  } finally {
    stopKeepAliveIfIdle();
  }

  return result;
}
