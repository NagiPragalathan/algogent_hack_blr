/**
 * notrack.ai, over /api/dispatch — the endpoint its own page posts to.
 *
 * The simplest engine in this folder, and why is worth writing down: there is
 * no credential. No sign-in, no bearer, no device id, no proof of work, no
 * captcha token. The page posts plain JSON and reads an event stream back. So
 * the whole session apparatus the other four need — resolve/cache/forget, the
 * stale-401 retry, ChatGPT's open-tab fallback for a Cloudflare challenge — is
 * ABSENT here rather than omitted. `session()` answers yes without asking
 * anything, and nothing is ever marked `stale`, because there is nothing that
 * can go stale.
 *
 * That moves where the risk lives rather than removing it. With no account
 * behind a request the rate limit is whatever the host applies per address, so
 * `pace.js` is doing MORE work here than anywhere else in this folder, not
 * less: a burst cannot be attributed to an account and throttled politely, it
 * can only be attributed to an address and blocked.
 *
 * Continuity is one id. `chat_id` arrives in the opening `chat_meta` frame and
 * is posted back on the next turn; null means "start a new conversation", which
 * is what the field is for and what the page itself sends on a fresh chat.
 */

import { lines, idleSignal } from './stream.js';

export const id = 'notrack';

/**
 * The request body carries an `attachments: []` array, so an upload flow very
 * likely exists — but it has not been observed, and an engine that CLAIMS an
 * attachment it cannot deliver is the one failure nothing downstream can
 * detect. Until the flow is verified these stay false, which sends any turn
 * carrying a file to the window, exactly as Claude and Meta AI do.
 */
export const images = false;
export const files = false;

const ORIGIN = 'https://notrack.ai';
const DISPATCH_URL = `${ORIGIN}/api/dispatch`;
/** Cheap, side-effect-free, and 200s for anyone — which is all a probe needs. */
const PROBE_URL = `${ORIGIN}/api/chats`;

export const EMPTY = { chatId: null };

export const resumable = (thread) => Boolean(thread?.chatId);

/* -------------------------------------------------------------------------
 * Session — or rather, the absence of one
 * ---------------------------------------------------------------------- */

/**
 * There is no credential to resolve, so this cannot fail for any reason the
 * user could act on. It answers a constant.
 *
 * Deliberately NOT a reachability check: `directReady` calls this on the
 * options page and before warming, and turning "is the direct path available"
 * into a network round trip would make every one of those wait on the host.
 * Reachability is `probe()`'s job, and a host that is down surfaces at ask time
 * as a thrown error and a fall back to the window — the designed behaviour for
 * every engine here.
 */
export async function session() {
  return { anonymous: true };
}

/** Why this engine can or cannot answer, for the Options page. */
export async function probe() {
  try {
    const response = await fetch(PROBE_URL, {
      credentials: 'include',
      headers: { Accept: 'application/json' }
    });
    if (!response.ok) {
      return { ok: false, reason: `notrack.ai returned HTTP ${response.status}.`, detail: null };
    }
    return { ok: true, reason: null, detail: 'No sign-in required' };
  } catch (err) {
    return { ok: false, reason: `Could not reach notrack.ai: ${err.message}`, detail: null };
  }
}

/**
 * Nothing is cached, so there is nothing to forget. Exported because
 * `forgetDirectSessions` calls it on every engine.
 */
export async function forget() {}

/* -------------------------------------------------------------------------
 * Reading the reply out of the event stream
 * ---------------------------------------------------------------------- */

/**
 * Deltas APPEND and `message` REPEATS, and both are keyed by `turn`.
 *
 * `{"type":"delta","turn":1,"chunk":"P"}` is a fragment to concatenate;
 * `{"type":"message","turn":1,"content":"PONG"}` is that whole turn, arriving
 * last. Taking the longer of the two — the tactic `gemini.js` uses on its
 * frames — is wrong here, because the shapes mean different things: a `message`
 * is authoritative for its turn and REPLACES the fragments, while two deltas
 * must be joined.
 *
 * Keyed by turn rather than accumulated flat because the body carries
 * `max_turns` and every frame carries a `speaker`, so a mode other than `usual`
 * can put several turns in one response. Flattening them would interleave two
 * speakers into one paragraph, and preferring a single `message` would silently
 * drop the rest. Turn 0 is the echo of our own question and is skipped —
 * handing the user their own prompt back reads exactly like a working reply.
 */
function reader() {
  const state = { turns: new Map(), chatId: null, events: 0, keys: new Set() };

  const render = () =>
    [...state.turns.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, turn]) => turn.final ?? turn.delta)
      .filter(Boolean)
      .join('\n\n')
      .trim();

  const slot = (turn) => {
    if (!state.turns.has(turn)) state.turns.set(turn, { delta: '', final: null });
    return state.turns.get(turn);
  };

  return {
    state,
    /** @returns {boolean} whether the visible text grew */
    absorb(event) {
      if (!event || typeof event !== 'object') return false;
      const before = render();

      state.events += 1;
      if (state.keys.size < 12) for (const key of Object.keys(event)) state.keys.add(key);

      if (typeof event.chat_id === 'string') state.chatId = event.chat_id;

      const turn = typeof event.turn === 'number' ? event.turn : null;
      // Turn 0 is our own question coming back. Never part of the answer.
      if (turn !== null && turn > 0) {
        if (event.type === 'delta' && typeof event.chunk === 'string') {
          slot(turn).delta += event.chunk;
        }
        if (event.type === 'message' && typeof event.content === 'string') {
          slot(turn).final = event.content;
        }
      }

      return render().length > before.length;
    },
    text: render
  };
}

/**
 * Why a 200 carried no answer, told apart into the three cases that need
 * different responses. Same reasoning as `chatgpt.js` — see the long note
 * there; the shapes differ, the argument does not.
 */
function emptyStream(state, stray) {
  if (state.events === 0) {
    const body = stray.trim();

    if (body) {
      let said = null;
      try {
        const parsed = JSON.parse(body);
        said = parsed?.error ?? parsed?.detail ?? parsed?.message ?? null;
        if (said && typeof said !== 'string') said = JSON.stringify(said);
      } catch {
        /* not JSON either — the excerpt below is all there is */
      }

      return Object.assign(
        new Error(
          said
            ? `notrack.ai answered with a message instead of a reply: ${said}`
            : `notrack.ai answered with something that was not an event stream: ${body.slice(0, 200)}`
        ),
        { status: 200 }
      );
    }

    // Accepted and then silent — the shape of a dropped connection, worth
    // exactly one more attempt. Set ONLY here: past this point a retry would
    // post the user's question a second time.
    return Object.assign(
      new Error('notrack.ai accepted the request and then sent nothing at all. Asking once more.'),
      { retryable: true }
    );
  }

  const keys = [...state.keys].join(', ') || 'none';
  return new Error(
    `notrack.ai streamed ${state.events} event(s) but none carried answer text — its response ` +
      `shape has most likely changed. Top-level keys seen: ${keys}.`
  );
}

/* -------------------------------------------------------------------------
 * The turn
 * ---------------------------------------------------------------------- */

export async function ask({ prompt, thread = EMPTY, image = null, signal, onText, timeoutMs = 90000 }) {
  /**
   * `images` and `files` are both false, so `askDirect` has already sent any
   * turn carrying one to the window. Reaching here with an attachment would
   * mean that gate had been changed without this being updated, and carrying on
   * would send a prompt that SAYS a file is attached with nothing behind it.
   */
  if (image) {
    throw new Error('notrack.ai has no upload flow here yet, so this turn needs the window.');
  }

  const guard = idleSignal(signal, timeoutMs);

  try {
    /**
     * The page's own defaults, read off the wire and copied rather than
     * invented. `persona` is the one the UI exposes (normal / concise /
     * detailed / creative); the rest are fixed on an ordinary chat turn.
     */
    const body = {
      user_input: prompt,
      mode: 'usual',
      model: 'C',
      persona: 'normal',
      max_turns: 6,
      chat_id: thread.chatId ?? null,
      attachments: [],
      regenerate: false,
      edit: false,
      edit_mid: null
    };

    const response = await fetch(DISPATCH_URL, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(body),
      signal: guard.signal
    });

    if (!response.ok) {
      throw Object.assign(new Error(`notrack.ai returned HTTP ${response.status}.`), {
        // Never `stale`: there is no credential here, so forcing a refresh would
        // re-send an identical request and get an identical answer. A 429 or a
        // 403 is handled by `pace.js` standing the provider down instead.
        status: response.status,
        retryAfter: response.headers?.get?.('retry-after') ?? null
      });
    }

    const events = reader();

    /**
     * Anything that was NOT an event, kept in case none of it was. A JSON error
     * body is a real answer from this endpoint and says far more than any
     * sentence written here in advance. Bounded — this is an error path and the
     * body could be anything.
     */
    let stray = '';

    for await (const line of lines(response)) {
      guard.touch();

      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) {
        if (trimmed && stray.length < 4000) stray += trimmed;
        continue;
      }

      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;

      try {
        if (events.absorb(JSON.parse(payload))) onText?.(events.text());
      } catch {
        /* a keep-alive or a partial line — the next one may still parse */
      }
    }

    const text = events.text();
    if (!text.trim()) throw emptyStream(events.state, stray);

    return {
      text,
      thread: { chatId: events.state.chatId ?? thread.chatId ?? null },
      attached: false
    };
  } finally {
    guard.done();
  }
}
