/**
 * The fast path: one prompt straight to the provider's own API, from the worker.
 *
 * The relay window exists because driving a provider's web UI is the only way
 * to reach every provider. It is also, by a wide margin, the slowest thing this
 * extension does — and almost none of that cost is the model thinking. A cold
 * turn opens a window, loads a single-page app, arms four separate anti-throttle
 * layers (including a debugger attachment), injects an adapter, types into a
 * contenteditable, clicks a button, and then infers the end of the reply by
 * polling the DOM until the text stops changing for `stabilityMs`. Every one of
 * those is overhead paid before and after the answer, and the last one is
 * overhead paid *per reply*: the settle rule cannot know an answer is finished,
 * so it waits to find out.
 *
 * The provider's own site does none of that. It posts to an HTTP endpoint and
 * reads a stream, and the stream ENDS — no polling, no settling, no window, no
 * throttling to fight, and the first words arrive in about a second instead of
 * after the whole answer has been rendered and re-read.
 *
 * So this is tried first, and the relay is what happens when it cannot be. The
 * fallback is not a nicety — every engine here talks to an undocumented,
 * unversioned endpoint that its owner changes without notice, and a provider
 * that breaks must degrade to "slower" rather than to "broken". Which is why
 * nothing in this folder reports a failure to the user: `askDirect` returns
 * null and `askProvider` carries on as it always did.
 *
 * ONE TRANSPORT PER THREAD, and that rule is the whole of the correctness here.
 *
 * A provider-side conversation is either a URL the window is sitting in or a
 * set of opaque ids only an API call can replay, and neither transport can join
 * the other's. So a chat that answers half its turns one way and half the other
 * is two conversations pretending to be one — the model would see a gap it is
 * never told about, and answer confidently across it. Three guards keep that
 * from happening and each one closes a different door:
 *
 *   - a chat the RELAY already owns (a conversation URL is filed for it) is
 *     left alone entirely. That is also what makes an upgrade uneventful: every
 *     chat already in progress carries on exactly as it was, and only new ones
 *     take the fast path.
 *   - `fresh` is IGNORED here, and the stored thread decides instead. The panel
 *     derives `fresh` from `hasConversation`, which reads URLs — and no URL is
 *     ever filed on this path, so honouring it would restart the conversation
 *     on every single turn. A new panel chat gets a new session id, which is
 *     what genuinely opens a new provider thread.
 *   - an agent run does not come here at all. See `allowDirect`.
 *
 * What it deliberately does NOT do:
 *
 *   - attachments. A file goes to the provider through its own uploader, which
 *     is a page-side flow with four routes and a delivery check behind it (see
 *     `adapter.js`). Reimplementing that per engine to save a few seconds would
 *     trade the extension's most carefully-won correctness for latency, so a
 *     turn carrying one takes the relay. The cost is written down at the guard
 *     itself.
 *   - a provider without an engine. Eight of the twelve have none, and they are
 *     unaffected by every line of this.
 */

import { transportFor } from '../../../providers/config.js';
import {
  getThread,
  setThread,
  getConversationUrls,
  forgetConversation,
  forgetThread
} from '../../state/conversations.js';
import {
  gate,
  coolOff,
  coolingFor,
  coolingReason,
  overBudget,
  noteReply,
  hydrate,
  paceStatus
} from './pace.js';
import { asFile, isImage } from './upload.js';
import { inflight, streamKey, startKeepAlive, stopKeepAliveIfIdle } from '../inflight.js';

import * as gemini from './gemini.js';
import * as chatgpt from './chatgpt.js';
import * as claude from './claude.js';
import * as meta from './meta.js';

/**
 * Which providers have an engine.
 *
 * Keyed by provider id, so a provider the user has renamed or re-pointed in
 * Options still matches — and an id with no entry simply takes the relay.
 */
const ENGINES = {
  [gemini.id]: gemini,
  [chatgpt.id]: chatgpt,
  [claude.id]: claude,
  [meta.id]: meta
};

/**
 * Why this transport last handed a provider's question back.
 *
 * A silent fallback is right — the window answers, so there is nothing broken to
 * report — but it makes "why did a window just open?" unanswerable from the
 * screen, and the reasons are all real, all different and all invisible: the
 * provider was stood down after pushing back, the chat is already pinned to a
 * window, the turn carried a file this engine cannot take, the session would not
 * resolve. Guessing between them costs far more than remembering the last one.
 *
 * Worker memory on purpose. It describes the turn that just happened, and a
 * worker that has been asleep since then has nothing left to explain.
 */
const declines = new Map();

/** Record why, and decline. Every `return null` in `askDirect` goes through it. */
const decline = (providerId, reason) => {
  declines.set(providerId, reason);
  return null;
};

/** The last recorded reason, for whoever has to tell the user. */
export const declineReason = (providerId) => declines.get(providerId) ?? null;

/**
 * The engine for this provider, or null when it must not be used.
 *
 * Two switches, and they answer different questions. `directTransport` is the
 * master — "never do this at all" — while `providerTransport` is per provider,
 * because they do not fail together: Meta's newer frontend can leave its engine
 * useless while ChatGPT's is perfect, and one global setting would make ruling
 * out the broken one cost the speed of the other three.
 */
const engineFor = (provider, settings) => {
  const providerId = provider?.id;

  if (!ENGINES[providerId]) {
    return decline(providerId, 'This provider has no direct engine — it is always asked through a window.');
  }
  if ((settings?.directTransport ?? 'auto') === 'off') {
    return decline(providerId, 'Direct API is set to “Always drive the page” in Options.');
  }
  if (transportFor(settings, providerId) !== 'direct') {
    return decline(providerId, 'This provider is set to Popup in Options.');
  }

  // Stood down after pushing back — checked before the session is even
  // resolved, so a provider that asked to be left alone costs nothing at all:
  // no token fetch, no proof of work, no request. See `pace.js`.
  //
  // This is the one that compounds, and it is why it names itself: a single
  // 403 from ChatGPT's sentinel stands the provider down for five minutes, the
  // window answers meanwhile, the adapter files a conversation URL — and from
  // then on this chat is pinned to the window for good, long after the cool-off
  // has expired. Reported as "unavailable" that sequence is unreadable.
  const cooling = coolingFor(providerId);
  if (cooling > 0) {
    const minutes = Math.ceil(cooling / 60000);
    return decline(
      providerId,
      coolingReason(providerId) === 'budget'
        ? `This has asked ${provider?.name ?? providerId} a lot in the last hour, so it is ` +
          `resting for ${minutes} more minute(s). Nothing is wrong — the count rolls forward.`
        : `${provider?.name ?? providerId} asked us to slow down, so it is being left alone for ` +
          `another ${minutes} minute(s).`
    );
  }

  /**
   * The hourly total, checked here rather than in `gate` because it has to be
   * answerable BEFORE any work is done. Waiting longer and longer is the right
   * response to a busy hour; there is a point past which the right response is
   * to stop, and reaching it almost always means something is looping rather
   * than somebody asking.
   */
  if (overBudget(providerId, settings?.safePacing !== false)) {
    return decline(
      providerId,
      `${provider?.name ?? providerId} has been asked a great deal in the last hour. Pausing the ` +
        'direct path until the count rolls forward — this is the extension throttling itself, ' +
        'not the provider refusing.'
    );
  }

  return ENGINES[providerId];
};

/**
 * Is the direct path available for this provider right now?
 *
 * Resolving the session is the whole test — it is the only part that can fail
 * for a reason the user could act on (signed out, region-blocked, a build we do
 * not speak), and it is cached, so asking costs one fetch per twenty minutes.
 */
export async function directReady(provider, settings) {
  await hydrate();
  const engine = engineFor(provider, settings);
  if (!engine) return false;

  try {
    return Boolean(await engine.session());
  } catch {
    return false;
  }
}

/**
 * Warm the session instead of opening a window.
 *
 * `warmProvider` exists to overlap the cost of opening a provider with the cost
 * of reading the page, and on this path there is no window to open — the only
 * thing worth pre-paying is the token fetch, which is a single request and is
 * then good for twenty minutes. Returning true is what tells the caller not to
 * build a relay window it will never use, so it is deliberately only true once
 * the session has actually resolved: a warm-up must never be the reason a run
 * that would have worked ends up with no window and no engine.
 */
export async function warmDirect(provider, settings) {
  return directReady(provider, settings);
}

/**
 * Send one prompt over the provider's own API and stream it back.
 *
 * Emits the same STREAM protocol as the relay path, because the panel's stage
 * track, its pending-state lists and `finishIfIdle` all read it and none of
 * them should have to know which transport answered:
 *
 *   connecting  the request has started
 *   ready       the session resolved — the equivalent of "the app is loaded"
 *   submitted   the provider accepted the turn and is generating
 *   streaming   text so far, on every delta
 *   done        the final text
 *
 * @returns {Promise<object|null>} the settled result, or null to mean "not this
 *   transport" — either it does not apply, or it failed before a single
 *   character reached the panel, and `askProvider` should carry on to the relay.
 */
export async function askDirect({
  reqId,
  provider,
  settings,
  prompt,
  post,
  image = null,
  scope = 'chat',
  sessionId = null,
  allowDirect = true,
  /**
   * What kind of traffic this is, which decides how hard it may lean.
   *
   * A run is thirty to forty back-to-back turns with nobody reading anything in
   * between, so it gets a wider floor than a person typing questions. See
   * `RUN_GAP_MS` in `pace.js` for what that costs.
   */
  intent = 'chat'
}) {
  // Before `engineFor`, which asks synchronously whether this provider is
  // standing down or out of budget — and cannot answer from an empty record.
  await hydrate();

  const engine = engineFor(provider, settings);
  if (!engine) return null; // engineFor has already said why
  if (!allowDirect) {
    return decline(provider?.id, 'An agent run keeps one transport for the whole run — see the note on its first step.');
  }

  /**
   * `scope: 'none'` is housekeeping — naming a chat — and it must leave no
   * trace anywhere.
   *
   * It reads the chat's own thread so the question is one short exchange at the
   * end of a conversation that already exists, and it never writes the thread
   * back. Both halves matter. Without the read, an empty thread is sent, and an
   * empty thread is how every provider is told to START A NEW CONVERSATION —
   * which is precisely the "Name this conversation. Reply with a title of AT
   * MOST 6 words" entry that appeared in the user's own ChatGPT sidebar, one
   * per chat they opened. Without skipping the write, the title exchange
   * becomes the point the next real question continues from, so every
   * conversation would carry an instruction about titles just above it.
   */
  const housekeeping = scope === 'none';
  const threadScope = housekeeping ? 'chat' : scope;

  /**
   * An attachment only goes this way when the engine can actually deliver it —
   * and "an attachment" is two different things.
   *
   * A screenshot is a picture the model LOOKS at; the user's CV is a document
   * it has to READ. They take different upload calls and sit in different parts
   * of the message at ChatGPT, so an engine answers for each separately. The
   * decode is done here as well as in the engine because a shape we cannot read
   * at all must reach the relay rather than the endpoint: the prompt above
   * already says a file is attached, and a message that describes an attachment
   * it does not carry is answered exactly as fluently as one that does.
   */
  if (image) {
    const file = asFile(image);
    if (!file) {
      return decline(provider.id, 'The attachment could not be read here, so the provider’s own uploader is taking it.');
    }
    if (isImage(file) ? !engine.images : !engine.files) {
      return decline(
        provider.id,
        `${provider.name ?? provider.id}'s engine cannot carry ${isImage(file) ? 'a picture' : 'a document'}, ` +
          'so this turn goes through the window — and that pins the rest of this chat to it.'
      );
    }
  }

  /**
   * A thread the window already owns stays with the window: the ids an API call
   * needs cannot be recovered from a page, so joining it is not possible and
   * opening a second one beside it is not honest.
   */
  /**
   * A thread the window already owns.
   *
   * On `auto` it stays there, and it stays there FOREVER — the ids an API call
   * needs cannot be recovered from a page, so there is nothing to join and a
   * second thread beside it would be two conversations pretending to be one.
   * That is correct and it is also the trap: one transient failure (a 403 that
   * stands the provider down for five minutes, a token that aged out) is
   * answered by the window, the adapter files a URL, and every later question
   * in that chat opens a popup long after the cause has cleared. `New chat` is
   * the only way out and nothing on screen says so.
   *
   * Under `strict` the user has already ruled that out, so the choice is not
   * "join or open a window" — it is "walk away from the window's thread, or
   * refuse to answer". Walking away is better, on one condition: it has to be
   * SAID. A conversation quietly restarting is exactly the invisible gap the
   * one-transport-per-thread rule exists to prevent; a conversation that
   * restarts and prints a line saying the earlier turns were answered elsewhere
   * is a fact the reader can work with.
   */
  let unpinned = false;
  const urls = await getConversationUrls(threadScope, sessionId);
  if (urls[provider.id]) {
    if (housekeeping || !directOnly(provider, settings)) {
      return decline(
        provider.id,
        'This chat has already been answered in a window once, so it stays there — the ids an API ' +
          'call needs cannot be recovered from a page. Press New chat to go back to the fast path.'
      );
    }

    /**
     * The URL and ONLY the URL.
     *
     * Forgetting the ids as well — which is what New chat does, and what this
     * did at first — is the difference between leaving the window's thread and
     * throwing away this chat's own. They are two separate records of two
     * separate provider conversations, and this chat may well already have an
     * API thread from before a window ever answered a turn in it. Dropping that
     * opens a THIRD conversation, and the provider's sidebar grows one entry per
     * question — which is exactly the symptom `sessionId` bucketing exists to
     * prevent, reintroduced one layer along.
     */
    await forgetConversation(provider.id, threadScope, sessionId);
    unpinned = true;

    /**
     * Tell the panel, or it puts the URL straight back.
     *
     * `session.conversationUrls` is the panel's own copy, and `SET_CONVERSATIONS`
     * with `navigate: false` seeds it into the store on every tab switch. Seeding
     * merges with the store winning — but this key no longer EXISTS in the store,
     * so "the store wins" resurrects it. The chat is pinned again, unpinned
     * again on the next turn, and with the ids being dropped too that was a new
     * provider conversation per question. Dropping both copies is what makes the
     * unpin stick.
     */
    post({ type: 'CONVERSATION_DROPPED', reqId, providerId: provider.id, sessionId });
  }

  const stored = await getThread(provider.id, threadScope, sessionId);
  const thread = engine.resumable(stored) ? stored : engine.EMPTY;

  /**
   * A restart is only a restart when there was nothing to carry on from. If this
   * chat already had an API thread with this provider, leaving the window's
   * thread loses nothing and saying so would be a warning about a gap that is
   * not there.
   */
  const restarted = unpinned && !engine.resumable(stored);

  /**
   * Housekeeping may only ever JOIN a conversation, never open one.
   *
   * With no thread yet there is nothing to append a title question to, and
   * asking anyway creates an entire provider conversation whose only content is
   * us asking for a title. Decided here, before anything is registered or
   * emitted, so a declined title is indistinguishable from one never asked for.
   * The panel keeps the truncated first question — see TITLE in
   * `channel/panel.js`.
   */
  if (housekeeping && !engine.resumable(stored)) {
    return decline(provider.id, 'Naming a chat may only join a conversation that already exists.');
  }

  const key = streamKey(reqId, provider.id);
  const controller = new AbortController();

  const result = { state: 'error', text: '', error: null };

  /**
   * Which transport answered, carried on every state the panel reads.
   *
   * The stage track was written when there was only one, so `ready` was worded
   * "Provider window open, typing the message" — and this path emits `ready`
   * too, with no window anywhere. The panel therefore announced a popup for
   * every fast turn, which is indistinguishable from one actually opening and
   * was reported as exactly that. A label that names something the user can
   * look for has to be true, or it is worse than no label.
   */
  const emit = (msg) => {
    if (msg.state) result.state = msg.state;
    if (typeof msg.text === 'string') result.text = msg.text;
    post({ type: 'STREAM', reqId, providerId: provider.id, via: 'direct', ...msg });
  };

  /**
   * Registered before the first await so Stop can find it.
   *
   * `direct: true` is read in two places in `inflight.js` and both matter: the
   * heartbeat must not try to tick a page that does not exist, and cancellation
   * has to abort a fetch rather than message an adapter.
   */
  let settled = false;
  let cancelled = false;
  inflight.set(key, {
    post,
    settle: () => {
      settled = true;
    },
    abort: () => {
      cancelled = true;
      controller.abort();
    },
    tabId: null,
    providerId: provider.id,
    direct: true,
    scope,
    sessionId
  });

  emit({ state: 'connecting', text: '' });
  startKeepAlive();

  /**
   * Whether a single character has reached the panel.
   *
   * Declared out here because the catch below is the only reader that matters:
   * it is what decides between falling back silently and owning the failure.
   */
  let started = false;

  try {
    emit({ state: 'ready' });

    // The first delta is also the only honest proof of delivery available on
    // this path: there is no composer to check a message was typed into, so
    // "the provider started answering" is the evidence.
    const onText = (text) => {
      if (settled || cancelled) return;
      started = true;
      emit({ state: 'streaming', text });
    };

    // A jittered gap, widened by how much this hour has already asked and by how
    // long the last answer was. Costs nothing anyone notices — see `pace.js`.
    await gate(provider.id, { intent, safe: settings?.safePacing !== false });

    emit({ state: 'submitted' });

    const answer = await withStaleRetry(engine, {
      prompt,
      thread,
      image,
      signal: controller.signal,
      onText,
      timeoutMs: settings.responseTimeoutMs || 300000
    });

    if (cancelled) return { state: 'cancelled', text: result.text, error: null };

    // Housekeeping does not move the thread on: the next real question then
    // continues from where the user left off rather than from an exchange about
    // what to call the chat.
    if (!housekeeping) await setThread(provider.id, answer.thread, threadScope, sessionId);

    // How much there is to read before a follow-up could plausibly be typed.
    // Feeds the next gap — see READ_MS_PER_CHAR in `pace.js`.
    noteReply(provider.id, answer.text.length);

    /**
     * `attached` is claimed here and nowhere earlier, because here is the first
     * moment it is TRUE — and it is the ENGINE's answer, not our inference.
     *
     * `run.js` reads it off any STREAM event and carries it into the loop as
     * `imageDelivered`. The upload happens inside `engine.ask`, so announcing
     * delivery on `submitted` would be announcing it before it had happened —
     * and a false claim is the one failure this flag exists to prevent. It was
     * being made anyway: `image ? true` says "something was passed in", which
     * stayed true after the engine had quietly failed to read the object it was
     * handed and sent the turn without it. An upload that fails throws instead,
     * which reaches the catch below with no text streamed, hands the turn to
     * the window, and lets the provider's own uploader try. That is a stronger
     * guarantee than the page path can give, where delivery has to be inferred
     * from markup nobody controls.
     */
    emit({
      state: 'done',
      text: answer.text,
      ...(image ? { attached: Boolean(answer.attached) } : {}),
      // Said once, on the turn it happened, because the model can no longer see
      // what came before it — and an answer that has quietly lost its context
      // reads exactly like one that has not.
      ...(restarted
        ? {
            notice:
              `Earlier turns in this chat were answered in a ${provider.name ?? provider.id} window. ` +
              'That thread cannot be continued over the API, so this answer starts a new one — ' +
              'it has not seen the messages above.'
          }
        : {})
    });
    return { state: 'done', text: answer.text, error: null };
  } catch (err) {
    if (cancelled) return { state: 'cancelled', text: result.text, error: null };

    /**
     * A 429 or a 403 is the provider saying it does not want this right now,
     * and the worst available response is the obvious one — try again.
     *
     * So it is stood down and its questions go through the window, which still
     * answers them. The user loses speed on one provider for a few minutes; the
     * alternative is retrying into exactly the pattern that gets an account
     * looked at. `Retry-After` wins when the provider sends one, because
     * guessing shorter than it asked for is the one way to make this worse.
     */
    if (err?.status === 429 || err?.status === 403) {
      coolOff(provider.id, err.retryAfter);
    }

    /**
     * A thread that was opened before the turn failed is still worth recording.
     *
     * Claude creates the conversation in a separate request, so a failure after
     * that point leaves a real, empty conversation on claude.ai. Forgetting it
     * would open another one on the next question, and another after that.
     */
    if (err?.thread && !housekeeping) {
      await setThread(provider.id, err.thread, threadScope, sessionId).catch(() => {});
    }

    /**
     * Nothing reached the panel, so nothing has to be explained: hand the
     * question back and let the relay window answer it. Once text HAS been
     * streamed the fallback would restart a half-written answer under the
     * reader, which is worse than saying what went wrong — so past that point
     * the error is reported and this transport owns the failure.
     */
    if (!started) return decline(provider.id, String(err?.message || err));

    emit({ state: 'error', error: String(err?.message || err) });
    return { state: 'error', text: result.text, error: String(err?.message || err) };
  } finally {
    inflight.delete(key);
    stopKeepAliveIfIdle();
  }
}

/**
 * Ask once, and on a stale credential mint a fresh one and ask exactly once
 * more.
 *
 * This is the single most common failure in ordinary use — the login outlives
 * the twenty-minute cache window — and it is entirely mechanical to recover
 * from, so recovering silently is much better than making the user press
 * anything. Only errors the engine has MARKED stale are retried: a 400 from a
 * changed endpoint shape would otherwise be asked twice and fail twice, at the
 * cost of a second full round trip before the relay is ever reached.
 */
async function withStaleRetry(engine, options) {
  try {
    return await engine.ask(options);
  } catch (err) {
    if (options.signal?.aborted) throw err;

    /**
     * A turn that produced nothing at all is worth exactly one more attempt,
     * WITHOUT touching the session — the credential was fine, the connection
     * was not. Kept distinct from `stale` because forcing a token refresh for a
     * dropped stream costs a round trip to fix something that was never broken.
     *
     * The engine only marks this when the request reached no conversation at
     * all. Retrying past that point would post the user's message a second time,
     * which is worse than the error it is trying to avoid.
     */
    if (err?.retryable) return engine.ask(options);

    if (!err?.stale) throw err;

    await engine.forget();
    return engine.ask(options);
  }
}

/** Throw away every cached session. The Options page's reset. */
export async function forgetDirectSessions() {
  await Promise.all(Object.values(ENGINES).map((engine) => engine.forget().catch(() => {})));
}

/**
 * Which providers can actually answer this way right now, and why not.
 *
 * A fallback is silent by design — the window answers, so there is nothing to
 * report — and the cost of that is a question nobody could answer from the
 * screen: "why did a window open for a provider that is supposed to be fast?"
 * The reasons are all real and all different (signed out, a Cloudflare
 * challenge, a region block, Meta's newer frontend, an endpoint that has
 * changed shape), they are invisible from the panel, and guessing between them
 * wastes far more time than asking. So the Options page can ask.
 *
 * Forced past the cache on purpose: a stale twenty-minute-old success is
 * exactly what a diagnostic must not report.
 */
export async function directStatus(settings, providers = {}) {
  await hydrate();
  const off = (settings?.directTransport ?? 'auto') === 'off';

  return Promise.all(
    Object.entries(ENGINES).map(async ([id, engine]) => {
      const label = providers[id]?.name ?? id;
      if (off) return { id, label, ok: false, reason: 'Direct API is switched off in Options.' };

      // Report the CHOICE before probing. Asking why a window opened for a
      // provider you set to Popup is a question with an answer already — and a
      // provider you never touched needs a different sentence, or the page
      // claims you chose something you did not and hides that the engine is
      // there and one dropdown away.
      if (transportFor(settings, id) !== 'direct') {
        return {
          id,
          label,
          ok: false,
          reason: settings?.providerTransport?.[id]
            ? 'Set to Popup in Options.'
            : 'Popup by default — this engine carries text only. Switch it to No popup above to try it.'
        };
      }

      // Standing down is a state worth NAMING rather than probing past: a
      // silent "unavailable" here would read as broken, when in fact it is
      // working exactly as intended and will come back on its own.
      const pace = paceStatus(id);
      const load = `${pace.inLastHour} request(s) in the last hour`;

      const cooling = coolingFor(id);
      if (cooling > 0) {
        const minutes = Math.ceil(cooling / 60000);
        return {
          id,
          label,
          ok: false,
          detail: load,
          reason:
            pace.reason === 'budget'
              ? `Resting for ${minutes} more minute(s) — this has asked a lot of ${label} in the ` +
                'last hour, so the extension is throttling itself. Nothing is wrong.'
              : `Backing off for ${minutes} more minute(s) — ${label} asked us to slow down` +
                (pace.strikes > 1 ? `, ${pace.strikes} times in a row now` : '') +
                '. Its questions go through the window meanwhile.'
        };
      }

      try {
        const { ok, reason, detail } = await engine.probe();
        // The hour's load rides along on a working provider too — it is the one
        // number that says how exposed this is, and it is otherwise invisible.
        return {
          id,
          label,
          ok,
          reason: reason ?? null,
          detail: [detail, ok ? load : null].filter(Boolean).join(' · ') || null
        };
      } catch (err) {
        return { id, label, ok: false, reason: String(err?.message || err), detail: load };
      }
    })
  );
}

/** The providers with no engine at all, which always use the window. */
export function directProviderIds() {
  return Object.keys(ENGINES);
}

/**
 * May a whole agent run go this way?
 *
 * A run is ONE accumulating conversation in which some turns carry a screenshot
 * and most do not, so the transport has to be decided for the run rather than
 * per turn — answering the text turns directly and the picture turns through
 * the window would split the run's history across two provider threads that
 * cannot see each other, and the model would reason across a gap nobody told it
 * about. That is the "finished · 0 steps" failure this codebase has already
 * paid for once.
 *
 * So the test is whether the engine can deliver a picture at all. ChatGPT and
 * Gemini can, and their runs get the whole speed-up — which matters far more
 * here than in chat, because a run is thirty round trips rather than one.
 * Claude and Meta AI cannot yet, so their runs stay on the window, whole.
 */
export function directRunnable(provider, settings) {
  const engine = engineFor(provider, settings);
  return Boolean(engine?.images);
}

/**
 * Has the user said a window must never open for this provider?
 *
 * The silent fallback is the right default and is written down at the top of
 * this file: every engine here speaks an undocumented endpoint its owner changes
 * without notice, so a break has to degrade to "slower" rather than to "broken".
 * The cost is that the failure is invisible AND it compounds — the window that
 * answers files a conversation URL, and from then on the chat is pinned to it
 * long after whatever went wrong has cleared. Somebody who set a provider to
 * "No popup" and then watched a window open anyway is not being helped by that
 * trade; they would rather be told.
 *
 * So `strict` turns the fallback off for the providers set to No popup, and
 * ONLY for those — a provider on Popup is unaffected, and so is everything with
 * no engine at all. It is not the default, because the failure it produces is a
 * question that does not get answered.
 *
 * An agent run is exempt regardless (`allowDirect`): a run's turns must all land
 * in one thread, most engines cannot carry a screenshot, and refusing to run at
 * all is not a service to anybody.
 */
export function directOnly(provider, settings) {
  if ((settings?.directTransport ?? 'auto') !== 'strict') return false;
  if (!ENGINES[provider?.id]) return false;
  return transportFor(settings, provider?.id) === 'direct';
}
