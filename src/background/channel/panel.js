import { PROVIDER_ORDER } from '../../providers/config.js';
import {
  getRelayTabId,
  hideRelayWindow,
  resetProviderTab,
  revealProviderTab,
  navigateExistingTab,
  whenRelayReady
} from '../relay.js';
import * as embedded from '../embedded.js';
import { loadState, isEmbedded } from '../state/settings.js';
import {
  hasConversation,
  getConversationUrls,
  setConversationUrls,
  forgetConversation,
  forgetThread
} from '../state/conversations.js';
import {
  resolveUserTab,
  listShareableTabs,
  isRelayOwned,
  isOrdinaryUrl,
  onUserTabChange,
  describe
} from '../state/user-tabs.js';
import { panelOpenedOn, panelClosed } from '../state/panel-tabs.js';
import { capturePages } from '../context/capture.js';
import { setPanelSink, clearPanelSink, takePendingHandoff } from '../context/handoff.js';
import { buildPrompt } from '../context/prompt.js';
import { askProvider, warmProvider } from '../transport/ask-provider.js';

/** Strip what a model wraps a title in. Returns '' if it did not write one. */
function cleanTitle(text) {
  const line = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);

  if (!line) return '';

  const title = line
    .replace(/^(?:title|name)\s*[:\-—]\s*/i, '')
    .replace(/^["'“”‘’«»]+|["'“”‘’«»]+$/g, '')
    .replace(/[.。!?]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();

  // A sentence is not a title. Better the truncated question than a paragraph
  // that will be truncated in the same list anyway.
  if (!title || title.length > 70 || title.split(/\s+/).length > 10) return '';
  return title;
}
import { askDeep, planDeepRead } from '../transport/deep-ask.js';
import { inflight, cancelInflight } from '../transport/inflight.js';
import { resetRelay } from '../transport/recover.js';
import {
  startAgentRun,
  resolveAgentConfirm,
  cancelAgentRun,
  isAgentRunning
} from '../agent/run.js';

/**
 * The side panel's channel.
 *
 * One long-lived port per open panel. Every message the panel can send is
 * listed in `HANDLERS` below, so "what can the panel ask for?" has a single
 * answer, and a handler that throws becomes one FATAL rather than a silent
 * dead end.
 */
export function watchPanelConnections() {
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'sidepanel') return;

    const post = (msg) => {
      try {
        port.postMessage(msg);
      } catch {
        /* panel closed */
      }
    };

    port.onMessage.addListener(async (msg) => {
      const handler = HANDLERS[msg.type];
      if (!handler) return;

      const { settings, providers } = await loadState();
      try {
        await handler({ msg, post, settings, providers });
      } catch (err) {
        post({ type: 'FATAL', error: String(err?.message || err) });
      }
    });

    // While this panel is open, page selections and right-click handoffs go to
    // it. Registered per connection, so a reopened panel replaces a dead one.
    setPanelSink(post);

    /**
     * The panel shows the conversation belonging to the tab in front of you,
     * so it has to be told when that changes — including when the tab is
     * closed, or its binding outlives the tab and a recycled id inherits
     * someone else's chat.
     */
    const offTabs = onUserTabChange((event) => post({ type: 'ACTIVE_TAB', ...event }));

    port.onDisconnect.addListener(() => {
      offTabs();
      // Now that nothing disables the panel per tab, a disconnect really does
      // mean it closed — so the marker comes off the page it was on.
      panelClosed();
      clearPanelSink(post);
      // Cancel anything still running for this panel.
      cancelInflight('', {
        cancelAdapter: (entry) => {
          if (entry.tabId == null) return;
          chrome.tabs
            .sendMessage(entry.tabId, { target: 'adapter', type: 'CANCEL' })
            .catch(() => {});
        }
      });
    });
  });
}

const HANDLERS = {
  INIT: async ({ post, settings, providers }) => {
    const current = await resolveUserTab();

    post({
      type: 'INIT_RESULT',
      providers: PROVIDER_ORDER.map((id) => providers[id]),
      settings,
      // Which tab this panel is looking at, so it can open that tab's own
      // conversation rather than whichever one happened to be current when
      // the panel was last closed.
      tab: describe(current)
    });

    /**
     * However it was opened — the icon, a right-click, a keyboard shortcut —
     * the panel now belongs to the tab in front of the user.
     *
     * The LITERAL active tab, which is not `current` above. `resolveUserTab`
     * answers "which page is worth reading", so it skips chrome:// and relay
     * tabs — open the panel on chrome://extensions and it names some unrelated
     * background tab, which then gets claimed and marked while the tab you are
     * looking at stays enabled. That is both halves of the bug: the panel on
     * every tab, and the indicator on none of them.
     */
    const [here] = await chrome.tabs
      .query({ active: true, currentWindow: true })
      .catch(() => []);
    panelOpenedOn(here?.id ?? null);

    // A right-click that opened this panel is waiting here: `sidePanel.open()`
    // returns long before the port exists, so the handoff could not have been
    // posted at click time.
    const handoff = await takePendingHandoff();
    if (handoff) post({ type: 'HANDOFF', handoff });
  },

  GET_CONTEXT: async ({ msg, post, settings }) => {
    const res = await capturePages(settings, msg.tabIds || []);
    post({
      type: 'CONTEXT_RESULT',
      ok: res.ok,
      error: res.error,
      context: res.contexts?.[0],
      contexts: res.contexts,
      requestId: msg.requestId
    });
  },

  LIST_TABS: async ({ post }) =>
    post({ type: 'TAB_LIST', tabs: await listShareableTabs() }),

  PICK_ELEMENT: async ({ msg, post }) => {
    const picked = await runPicker('PICK_ELEMENT', msg.tabId ?? null);
    post({ type: 'PICKED', ...picked });
  },

  /**
   * The same gesture, for what the page LOOKS like.
   *
   * Drag a box; the crop of that box is what travels with the question. The
   * element picker answers "what does this say", this one answers "what is
   * wrong with this chart" — questions the DOM cannot be asked.
   */
  PICK_REGION: async ({ msg, post }) => {
    const picked = await runPicker('PICK_REGION', msg.tabId ?? null);
    if (!picked.ok) {
      post({ type: 'PICKED_IMAGE', ...picked });
      return;
    }

    const image = await cropVisibleTab(picked.tabId, picked.rect, picked.dpr);

    // Show the crop back on the page it came from. The panel gets a chip too,
    // but the panel is not where you were looking when you dragged the box.
    if (image) {
      chrome.tabs
        .sendMessage(picked.tabId, {
          target: 'agent-page',
          type: 'AGENT_SHOT',
          image,
          label: 'Selection'
        })
        .catch(() => {});
    }

    post({
      type: 'PICKED_IMAGE',
      ok: Boolean(image),
      error: image ? null : 'Could not photograph that part of the page.',
      image,
      width: Math.round(picked.rect.width),
      height: Math.round(picked.rect.height),
      url: picked.url,
      title: picked.title
    });
  },

  ASK: async ({ msg, post, settings, providers }) => {
    const targets = (msg.providerIds || [])
      .map((id) => providers[id])
      .filter((p) => p && p.enabled !== false);

    if (!targets.length) {
      post({ type: 'ASK_ERROR', reqId: msg.reqId, error: 'No provider selected.' });
      return;
    }

    /**
     * Open the provider windows while the page is still being read.
     *
     * `capturePages` with `deep: true` scrolls the user's tab to the bottom and
     * back before it returns anything — seconds, on the lazily-rendered lists
     * that made it necessary — and until now the provider window did not start
     * opening until after all of it. The two are unrelated, so they overlap.
     * Not awaited, and failures are the ask's business: see `warmProvider`.
     */
    targets.forEach(async (provider) =>
      warmProvider(provider, settings, {
        sessionId: msg.sessionId ?? null,
        fresh: !(await hasConversation(provider.id, 'chat', msg.sessionId ?? null))
      })
    );

    let context = null;
    let extraPages = [];

    if (msg.includeContext) {
      // Deep: scroll the page before reading it. The chip the panel showed while
      // you typed came from a plain read, so what actually gets sent is usually
      // several times larger — a lazily-rendered list only exists in the DOM
      // once it has been scrolled past.
      const res = await capturePages(settings, msg.contextTabIds || [], { deep: true });
      if (res.ok) {
        context = res.contexts[0];
        extraPages = res.contexts.slice(1);
        post({ type: 'CONTEXT_USED', reqId: msg.reqId, context, count: res.contexts.length });
      } else {
        post({ type: 'CONTEXT_WARNING', reqId: msg.reqId, error: res.error });
      }
    }

    const pages = context ? [context, ...extraPages] : [];
    const extras = {
      files: msg.files || [],
      picked: msg.picked || null,
      // Named in the prompt so the model knows to look at what was uploaded
      // rather than answering from the page alone — the file arrives through
      // the provider's own uploader, which the prompt cannot see.
      uploadName: msg.uploadName || null
    };
    const parts = planDeepRead({ question: msg.question, pages, settings });

    const prompt = buildPrompt(msg.question, context, { ...extras, extraPages });

    // Fan out — each provider runs independently so a slow or broken one never
    // holds up the others. A deep read is several turns per provider; they are
    // sequential within a provider and parallel across them, same as one turn is.
    targets.forEach(async (provider) =>
      parts
        ? askDeep({
            reqId: msg.reqId,
            provider,
            settings,
            post,
            question: msg.question,
            pages,
            parts,
            extras,
            // Only the answering turn gets the picture: a reading turn is
            // extracting text from one part of a page, and pasting the same
            // image into all six of them costs six uploads for one question.
            image: msg.image || null,
            sessionId: msg.sessionId ?? null,
            fresh: !(await hasConversation(provider.id, 'chat', msg.sessionId ?? null))
          })
        : askProvider({
            reqId: msg.reqId,
            provider,
            settings,
            prompt,
            post,
            image: msg.image || null,
            /**
             * The chat that asked, so its provider thread is filed under it.
             *
             * Without this the chat scope was one thread per provider for the
             * whole extension, kept roughly in step by the panel pushing
             * SET_CONVERSATIONS when you opened something from history. That
             * covered history and nothing else — and the panel now follows the
             * tab you are on, so switching tabs swapped the conversation on
             * screen while the provider stayed in the previous chat's thread.
             * The next question in an apparently blank chat continued somebody
             * else's.
             */
            sessionId: msg.sessionId ?? null,
            /**
             * A chat with no thread of its own starts one, rather than
             * inheriting whatever the provider tab was last on.
             *
             * `ensureProviderTab` with a null resume URL does NOT steer the
             * tab — it reuses it exactly as it stands. So "this chat has no
             * thread yet" and "carry on where the last chat left off" were the
             * same call, and the first question typed into a brand new chat
             * (opening a browser tab makes one) landed in the previous chat's
             * conversation. The agent path already forced a reset here; the
             * chat path never did.
             */
            fresh: !(await hasConversation(provider.id, 'chat', msg.sessionId ?? null))
          })
    );
  },

  AGENT_RUN: ({ msg, post, settings, providers }) =>
    startAgentRun({ msg, settings, providers, post }),

  AGENT_CONFIRM_RESULT: ({ msg }) => resolveAgentConfirm(msg.approved, msg.reply),

  AGENT_STOP: ({ msg }) => {
    cancelAgentRun();
    // The provider may be mid-reply for the step we just abandoned.
    cancelInflight(`${msg.runId}-`, {
      cancelAdapter: (entry) => {
        if (entry.tabId == null) return;
        chrome.tabs
          .sendMessage(entry.tabId, { target: 'adapter', type: 'CANCEL' })
          .catch(() => {});
      }
    });
  },

  CANCEL: ({ msg, post }) => {
    cancelInflight(`${msg.reqId}:`, {
      cancelAdapter: (entry) => {
        // A null tabId means this request is running in a background frame.
        if (entry.tabId == null) {
          embedded.cancel(entry.providerId, msg.reqId);
          return;
        }
        chrome.tabs
          .sendMessage(entry.tabId, { target: 'adapter', type: 'CANCEL', reqId: msg.reqId })
          .catch(() => {});
      },
      onCancelled: (entry) =>
        post({
          type: 'STREAM',
          reqId: msg.reqId,
          providerId: entry.providerId,
          state: 'cancelled'
        })
    });
  },

  /**
   * Start over with one provider — which builds nothing.
   *
   * Forgetting the two records IS the whole operation. Both have to go or the
   * "new" chat carries straight on from the old one: the URL is what the window
   * would reopen, and the ids are what a direct turn would send.
   *
   * What must NOT happen here is opening a page. This used to call
   * `resetProviderTab` unconditionally, which CREATES the relay window and
   * navigates it — so pressing New chat, or switching provider (which sends one
   * of these per provider), put a window and Chrome's "started debugging this
   * browser" bar on screen before a single question had been asked, for a
   * provider that was then going to answer over its own API and never look at
   * it. An existing window is still steered, because leaving one sitting in the
   * conversation you just walked away from is its own kind of lie; a window
   * that does not exist is left not existing, and `attemptAsk` navigates at ask
   * time anyway when it turns out one is needed.
   */
  NEW_CHAT: async ({ msg, post, settings, providers }) => {
    const provider = providers[msg.providerId];
    if (!provider) return;

    await forgetConversation(msg.providerId, 'chat', msg.sessionId ?? null);
    await forgetThread(msg.providerId, 'chat', msg.sessionId ?? null);

    if (isEmbedded(settings)) {
      // `navigate` is already a no-op with no offscreen document, so this only
      // ever steers a frame that is genuinely there.
      await embedded.navigate(msg.providerId, provider.newChatUrl);
    } else if (getRelayTabId(msg.providerId) != null) {
      await resetProviderTab(provider, settings);
    }

    post({ type: 'NEW_CHAT_DONE', providerId: msg.providerId });
  },

  /**
   * A name for the conversation, written by the model that answered it.
   *
   * The fallback is the first question cut at 80 characters, which is why the
   * history reads "Summarise this page in 5 concise bullet points. Lead with
   * what it is actually ab" — a truncation is not a title, and a list of them
   * cannot be scanned, which is the only thing a history list is for.
   *
   * Three things keep the cost honest. It goes in the SAME thread, so it is one
   * short exchange at the end of a conversation that already exists rather than
   * a new two-line chat in the provider's history for every session. It runs
   * *after* the answer has been delivered, so nobody waits for it — a title
   * arriving a few seconds late costs nothing, and blocking a reply on one
   * would be absurd. And it is best effort in every direction: a failure, a
   * timeout or an empty reply simply leaves the truncated title in place, which
   * is what the panel is already showing.
   */
  /**
   * What comes back is not always just the title.
   *
   * Models wrap it in quotes, prefix it with "Title:", end it with a full stop,
   * or answer in a fenced block — and any one of those put raw into the history
   * list looks like the feature is broken rather than like the model was
   * chatty. A reply that is a whole paragraph is a refusal to follow the format
   * and is dropped: the truncated first question is a worse title than a good
   * one and a better title than a paragraph.
   */
  TITLE: async ({ msg, post, settings, providers }) => {
    const provider = providers[msg.providerId] || providers[PROVIDER_ORDER[0]];
    if (!provider || !msg.sessionId) return;

    /**
     * Never while the agent is driving.
     *
     * This request carried no scope, so it defaulted to `chat` — and with no
     * chat thread yet it reuses the tab exactly as it stands, which mid-run is
     * the RUN's conversation. Three things then went wrong at once: the run's
     * URL was filed as the chat thread, so the user's next ordinary question
     * resumed a conversation full of JSON actions; "Name this conversation"
     * landed in the middle of the agent's context, where the next turn reads it
     * as an instruction; and if a stale chat URL did exist, the tab NAVIGATED
     * away from the run's thread and the next step had to navigate back —
     * which is how one panel session ends up with several provider chats.
     *
     * A run's own title is not worth any of that. The panel keeps the
     * truncated first question, which is what it is already showing.
     */
    if (isAgentRunning()) return;

    const result = await askProvider({
      reqId: `${msg.sessionId}-title`,
      provider,
      settings,
      // Housekeeping, not a conversation: `none` stops the URL being filed, so
      // naming a chat can never become the thread we resume into later.
      scope: 'none',
      /**
       * Which chat is being named — needed to find the thread to ask IN.
       *
       * Without it the question had no conversation to join, and "no
       * conversation to join" is how every provider is told to start a new one:
       * the transport opened a fresh thread, so the user's provider history
       * collected a chat called "Name this conversation. Reply with a title of
       * AT MOST 6 words" for every session. `scope: 'none'` still keeps this
       * turn out of the record — it joins the thread, it does not move it on.
       */
      sessionId: msg.sessionId,
      prompt:
        'Name this conversation.\n\n' +
        'Reply with a title of AT MOST 6 words and nothing else — no quotes, no ' +
        'punctuation at the end, no "Title:" prefix, no explanation. Say what it ' +
        'is about, not what was asked: "OpenAI official site", not "Question ' +
        'about OpenAI".',
      // Silence. The panel has a request in flight it never started and would
      // render this as an answer in the thread — a "title" bubble appearing
      // under the real reply is exactly the kind of thing nobody can explain.
      post: () => {}
    }).catch(() => null);

    const title = cleanTitle(result?.state === 'done' ? result.text : '');
    if (title) post({ type: 'TITLE', sessionId: msg.sessionId, title });
  },

  /**
   * Which provider threads a chat owns, as the PANEL remembers them.
   *
   * Two callers with two different meanings, and conflating them destroyed a
   * live thread. Opening a session from history is a deliberate "point at
   * these" and replaces what is stored. A tab switch is only the panel saying
   * "by the way, this chat is the one on screen now" — and there the stored
   * record must WIN, because it is filed from the adapter as each reply lands
   * and the panel's copy can easily be behind it or empty.
   *
   * Empty is the case that broke: an agent run files its thread in the store,
   * the panel is not told (see `run.js` — it forwards STREAM only), so
   * `session.conversationUrls` is still `{}`. Sending that on the next tab
   * switch wiped the bucket the run had just filled, the next ordinary question
   * found no thread, and Gemini got a second conversation for the same chat.
   */
  SET_CONVERSATIONS: async ({ msg, post, settings }) => {
    const urls = msg.urls || {};
    const sessionId = msg.sessionId ?? null;

    if (msg.navigate === false) {
      // Seed only: fill in what the store does not already know, never replace.
      // Nothing is steered either — `ensureProviderTab` does that when the
      // question is actually asked, and driving the provider window on every
      // tab switch would be motion for nothing.
      const known = await getConversationUrls('chat', sessionId);
      await setConversationUrls({ ...urls, ...known }, 'chat', sessionId);
      post({ type: 'CONVERSATIONS_SET' });
      return;
    }

    await setConversationUrls(urls, 'chat', sessionId);

    // Storing the URL is not enough — a provider whose tab is already open would
    // keep showing its previous conversation. Steer the tabs that exist;
    // providers with no tab yet will simply open at the right place when they
    // are next used. Nothing new is created here.
    await Promise.all(
      Object.entries(urls).map(([providerId, url]) =>
        isEmbedded(settings)
          ? embedded.navigate(providerId, url).catch(() => false)
          : navigateExistingTab(providerId, url).catch(() => false)
      )
    );

    post({ type: 'CONVERSATIONS_SET' });
  },

  OPEN_CONVERSATION: async ({ msg, providers }) => {
    // Open the provider's own thread in a normal tab the user can read.
    const urls = await getConversationUrls('chat', msg.sessionId ?? null);
    const url = urls[msg.providerId] || providers[msg.providerId]?.homeUrl;
    if (!url) return;

    // Focus a tab already showing it rather than stacking up duplicates every
    // time this is clicked. Relay tabs are excluded — those live in the hidden
    // window and are not for reading.
    const open = (await chrome.tabs.query({ url: url.split('#')[0] })).find(
      (tab) => !isRelayOwned(tab)
    );

    if (open) {
      await chrome.windows.update(open.windowId, { focused: true });
      await chrome.tabs.update(open.id, { active: true });
    } else {
      await chrome.tabs.create({ url, active: true });
    }
  },

  OPEN_LOGIN: async ({ msg, post, settings, providers }) => {
    const provider = providers[msg.providerId];
    if (!provider) return;

    if (isEmbedded(settings)) {
      // There is no window to bring forward in embedded mode, so sign in the
      // ordinary way. The session is shared with the frame.
      await chrome.tabs.create({ url: provider.homeUrl, active: true });
    } else {
      await revealProviderTab(provider, settings);
    }

    post({
      type: 'LOGIN_OPENED',
      providerId: msg.providerId,
      embedded: isEmbedded(settings)
    });
  },

  HIDE_RELAY: ({ settings }) => hideRelayWindow(settings),

  SHOW_RELAY: ({ msg, settings, providers }) =>
    revealProviderTab(
      providers[msg.providerId] || providers[PROVIDER_ORDER[0]],
      settings,
      'manual'
    ),

  CLOSE_RELAY: async ({ post }) => {
    // Same teardown a stalled request recovers with — including detaching the
    // debugger before the windows go, or the infobar outlives its tab.
    await resetRelay();
    post({ type: 'RELAY_CLOSED' });
  },

  PROBE: async ({ msg, post, providers }) => {
    const provider = providers[msg.providerId];
    const tabId = getRelayTabId(msg.providerId);

    if (!provider || tabId == null) {
      post({ type: 'PROBE_RESULT', providerId: msg.providerId, connected: false });
      return;
    }

    const res = await chrome.tabs
      .sendMessage(tabId, { target: 'adapter', type: 'PROBE' })
      .catch(() => null);

    post({
      type: 'PROBE_RESULT',
      providerId: msg.providerId,
      connected: Boolean(res),
      ...(res || {})
    });
  }
};

/**
 * Bring the user's page forward and run one of the two pickers in it.
 *
 * Shared because the difference between them is a message name: both need a
 * real page, both need it visible (you cannot point at a tab you cannot see),
 * and both have to survive a tab that pre-dates the extension by injecting the
 * content script and asking again.
 *
 * `explicitTabId` is the tab whose chip is showing on the sharing bar, sent by
 * the panel. It wins over "whatever is active" for the same reason it does in
 * `capture.js`: the page the question is about is the one named in the panel,
 * and a picker that opens somewhere else is a picker pointed at the wrong page.
 */
async function runPicker(type, explicitTabId = null) {
  const tab = await pickerTarget(explicitTabId);
  if (!tab) return { ok: false, error: 'No ordinary page is open to point at.' };

  await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  await chrome.tabs.update(tab.id, { active: true }).catch(() => {});

  const result = await chrome.tabs
    .sendMessage(tab.id, { type })
    .catch(async () => {
      // Both halves, always — a tab holding only page-context.js answers the
      // picker and then silently ignores AGENT_SHOT, so the capture animation
      // goes missing on exactly the tabs that needed injecting. See the note in
      // agent/page.js.
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['src/content/page-context.js', 'src/content/agent-page.js']
      });
      return chrome.tabs.sendMessage(tab.id, { type });
    })
    .catch((err) => ({ ok: false, error: String(err?.message || err) }));

  return { ...(result || { ok: false, error: 'Picker failed.' }), tabId: tab.id };
}

/**
 * The page to point at — never a provider page.
 *
 * The relay holds real, ordinary-looking https tabs, and after a worker restart
 * the ids that identify them live in session storage rather than in memory. Ask
 * before they are back and a ChatGPT tab looks exactly like the page you were
 * reading: the picker opens on the provider's own UI, and you end up sending
 * the assistant a photograph of itself. `whenRelayReady()` is what closes that
 * window, and `isRelayOwned` is checked again here because an explicitly named
 * tab skips `resolveUserTab`, which does its own filtering.
 */
async function pickerTarget(explicitTabId) {
  await whenRelayReady();

  if (explicitTabId != null) {
    const named = await chrome.tabs.get(explicitTabId).catch(() => null);
    if (named && !isRelayOwned(named) && isOrdinaryUrl(named.url)) return named;
  }

  const active = await resolveUserTab();
  return active && !isRelayOwned(active) ? active : null;
}

/**
 * Photograph the visible tab and cut the dragged rectangle out of it.
 *
 * `captureVisibleTab` only ever returns the whole viewport, so the crop happens
 * here. The rectangle arrives in CSS pixels and the photograph is in device
 * pixels, hence the `dpr` multiply — miss it and every crop on a HiDPI screen
 * is the top-left quarter of what was selected.
 *
 * `OffscreenCanvas` rather than an `<img>`: there is no DOM in a service
 * worker, and spinning up an offscreen document for one crop would cost more
 * than the capture itself.
 */
async function cropVisibleTab(tabId, rect, dpr = 1) {
  try {
    const tab = await chrome.tabs.get(tabId);

    /**
     * `captureVisibleTab` photographs whatever is ACTIVE in the window it is
     * given — not the tab id you have in your hand. Between the drag ending and
     * this call, an answer arriving can pull a provider tab forward, and the
     * picture then shows the assistant's own UI instead of the page the box was
     * dragged on. So the tab is put back in front and confirmed before the
     * shutter, and refused outright if it will not come forward.
     */
    if (!tab.active) {
      await chrome.tabs.update(tabId, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
      // One paint, so the compositor has actually drawn the tab we asked for.
      await new Promise((r) => setTimeout(r, 120));
    }

    const front = await chrome.tabs.get(tabId);
    if (!front.active || isRelayOwned(front)) return null;

    const shot = await chrome.tabs.captureVisibleTab(front.windowId, {
      format: 'png'
    });

    const bitmap = await createImageBitmap(await (await fetch(shot)).blob());
    const scale = dpr || 1;

    // Clamp to the photograph: a drag that ends past the edge of the window
    // reports coordinates outside it, and `drawImage` silently produces a
    // transparent strip rather than failing.
    const x = Math.max(0, Math.min(rect.x * scale, bitmap.width));
    const y = Math.max(0, Math.min(rect.y * scale, bitmap.height));
    const width = Math.max(1, Math.min(rect.width * scale, bitmap.width - x));
    const height = Math.max(1, Math.min(rect.height * scale, bitmap.height - y));

    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext('2d').drawImage(bitmap, x, y, width, height, 0, 0, width, height);
    bitmap.close();

    const blob = await canvas.convertToBlob({ type: 'image/png' });
    const bytes = new Uint8Array(await blob.arrayBuffer());

    // btoa in chunks: spreading a megapixel array into String.fromCharCode in
    // one call overflows the argument limit and throws.
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    }
    return `data:image/png;base64,${btoa(binary)}`;
  } catch {
    return null;
  }
}

/** Only used by the disconnect path; exported so tests can inspect it. */
export { inflight };
