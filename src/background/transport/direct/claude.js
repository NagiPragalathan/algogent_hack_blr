/**
 * Claude, over claude.ai/api — the endpoint its own web client calls.
 *
 * The odd one of the four. There is no bearer and no XSRF token to scrape: the
 * session cookie is the whole credential, and the browser attaches it. What has
 * to be discovered instead is the ORGANISATION uuid, because every chat path is
 * scoped to one, and a conversation has to be CREATED before anything can be
 * said into it — two extra round trips on the first turn of a thread, none on
 * the turns after it.
 *
 * The completion stream has carried two shapes. The long-standing one is
 * `{"completion": "…"}` per event; the newer one is Anthropic's own block
 * protocol, `content_block_delta` carrying `delta.text`. Both append rather
 * than repeat, which is the opposite of Gemini's framing — so here the fragments
 * are concatenated and the LAST state is the answer.
 *
 * Best-effort throughout, and more so than the other three: claude.ai defends
 * this endpoint and has changed it without notice. Every failure falls back to
 * the relay window, which drives the page exactly as a person would.
 */

import { lines, idleSignal } from './stream.js';

export const id = 'claude';

const ORIGIN = 'https://claude.ai';
const CACHE_KEY = 'directSession:claude';
const TTL_MS = 30 * 60 * 1000;

/** What the web client sends as the parent of a thread's first message. */
const ROOT_MESSAGE = '00000000-0000-4000-8000-000000000000';

export const EMPTY = { conversationId: null, parentId: null };

export const resumable = (thread) => Boolean(thread?.conversationId);

const headers = () => ({
  'Content-Type': 'application/json',
  Accept: 'text/event-stream',
  'anthropic-client-platform': 'web_claude_ai'
});

/* -------------------------------------------------------------------------
 * Session
 * ---------------------------------------------------------------------- */

/**
 * Which organisation to talk to.
 *
 * An account can be in several — a personal one and a team — and only some of
 * them can hold a chat. Picking the first entry blindly lands a personal
 * conversation in a workspace the user never chose, so the one that declares
 * the chat capability wins, and the first is only the fallback for an account
 * whose capability list we do not recognise.
 */
function pickOrg(list) {
  if (!Array.isArray(list) || !list.length) return null;

  const chatty = list.find((org) => Array.isArray(org?.capabilities) && org.capabilities.includes('chat'));
  return (chatty ?? list[0])?.uuid ?? null;
}

async function fetchOrg() {
  const response = await fetch(`${ORIGIN}/api/organizations`, {
    credentials: 'include',
    headers: { Accept: 'application/json' }
  });

  if (response.status === 401 || response.status === 403) {
    return { blocked: 'Not signed in to Claude in this browser profile, or the request was challenged. Open claude.ai, then retry.' };
  }
  if (!response.ok) return { blocked: `Claude returned HTTP ${response.status}.` };

  return { org: pickOrg(await response.json().catch(() => null)) };
}

/**
 * The same request from inside an open claude.ai tab, for the case where the
 * worker's fetch is answered with a bot check rather than JSON. Same-origin,
 * with whatever clearance that tab already has.
 */
async function readFromOpenTab() {
  const [tab] = await chrome.tabs.query({ url: `${ORIGIN}/*` });
  if (!tab?.id) return null;

  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async () => {
        const response = await fetch('/api/organizations', {
          credentials: 'include',
          headers: { Accept: 'application/json' }
        });
        if (!response.ok) return null;
        return response.json().catch(() => null);
      }
    });
    return pickOrg(result?.result);
  } catch {
    return null; // the tab navigated away, or is still loading
  }
}

/**
 * Resolve the session, and say why when it cannot be. `session()` and `probe()`
 * are both built on this so the diagnostic can never drift from the credential
 * the turn actually uses.
 */
async function resolve({ force = false } = {}) {
  if (!force) {
    const { [CACHE_KEY]: cached } = await chrome.storage.session.get(CACHE_KEY);
    if (cached && cached.expiresAt > Date.now()) return { ok: true, session: cached };
  }

  let from;
  try {
    from = await fetchOrg();
  } catch (err) {
    return { ok: false, reason: `Could not reach claude.ai: ${err.message}` };
  }

  // A blocked worker fetch is still worth following with the tab, which has
  // whatever clearance we were refused.
  const org = from?.org || (await readFromOpenTab());

  if (!org) {
    return {
      ok: false,
      reason: from?.blocked ?? 'Signed in, but no organisation was returned — claude.ai changed its shape.'
    };
  }

  const resolved = { org, expiresAt: Date.now() + TTL_MS };
  await chrome.storage.session.set({ [CACHE_KEY]: resolved });
  return { ok: true, session: resolved };
}

export async function session(options = {}) {
  return (await resolve(options)).session ?? null;
}

/** Why this engine can or cannot answer, for the Options page. */
export async function probe() {
  const { ok, reason } = await resolve({ force: true });
  return { ok, reason, detail: null };
}

/* -------------------------------------------------------------------------
 * The thread
 * ---------------------------------------------------------------------- */

/**
 * A conversation exists before anything is said into it.
 *
 * The uuid is ours to choose, which is what lets the caller record the thread
 * even if the turn that opened it then fails — the alternative is a stranded
 * conversation on claude.ai for every failed first message.
 */
async function createConversation(org, signal) {
  const uuid = crypto.randomUUID();

  const response = await fetch(`${ORIGIN}/api/organizations/${org}/chat_conversations`, {
    method: 'POST',
    credentials: 'include',
    headers: { ...headers(), Accept: 'application/json' },
    body: JSON.stringify({ uuid, name: '' }),
    signal
  });

  if (!response.ok) {
    throw Object.assign(new Error(`Claude returned HTTP ${response.status} opening a conversation.`), {
      stale: response.status === 401,
      status: response.status,
      retryAfter: response.headers?.get?.('retry-after') ?? null
    });
  }

  const body = await response.json().catch(() => null);
  return body?.uuid ?? uuid;
}

/* -------------------------------------------------------------------------
 * Reading the reply out of the event stream
 * ---------------------------------------------------------------------- */

/**
 * Both stream shapes, folded into one accumulator.
 *
 * `completion` and `delta.text` are fragments to append; `text` on a
 * `content_block_start` is an opening fragment, not a repeat. Nothing here
 * treats a longer string as a replacement — doing so on an appending protocol
 * loses everything before the longest single fragment.
 */
function fragment(event) {
  if (typeof event?.completion === 'string') return event.completion;
  if (typeof event?.delta?.text === 'string') return event.delta.text;
  if (event?.type === 'content_block_start' && typeof event.content_block?.text === 'string') {
    return event.content_block.text;
  }
  return '';
}

/** The assistant turn's own id, which the next message hangs off. */
function messageId(event) {
  const found = event?.message?.uuid ?? event?.message?.id ?? event?.parent_message_uuid ?? null;
  return typeof found === 'string' ? found : null;
}

/* -------------------------------------------------------------------------
 * The turn
 * ---------------------------------------------------------------------- */

export async function ask({ prompt, thread = EMPTY, signal, onText, timeoutMs = 90000 }) {
  const auth = await session();
  if (!auth) throw new Error('Not signed in to Claude in this browser profile.');

  const guard = idleSignal(signal, timeoutMs);

  try {
    const conversationId = thread.conversationId || (await createConversation(auth.org, guard.signal));

    const response = await fetch(
      `${ORIGIN}/api/organizations/${auth.org}/chat_conversations/${conversationId}/completion`,
      {
        method: 'POST',
        credentials: 'include',
        headers: headers(),
        body: JSON.stringify({
          prompt,
          parent_message_uuid: thread.parentId || ROOT_MESSAGE,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          locale: 'en-US',
          personalized_styles: [],
          tools: [],
          attachments: [],
          files: [],
          sync_sources: [],
          rendering_mode: 'messages'
        }),
        signal: guard.signal
      }
    );

    if (!response.ok) {
      throw Object.assign(new Error(`Claude returned HTTP ${response.status}.`), {
        stale: response.status === 401,
        status: response.status,
        retryAfter: response.headers?.get?.('retry-after') ?? null,
        // The thread is real even though this turn failed, so it is worth
        // handing back rather than orphaning on claude.ai.
        thread: { conversationId, parentId: thread.parentId ?? null }
      });
    }

    let text = '';
    let parentId = thread.parentId ?? null;

    for await (const line of lines(response)) {
      guard.touch();

      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;

      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;

      let event;
      try {
        event = JSON.parse(payload);
      } catch {
        continue; // a keep-alive or a partial line
      }

      parentId = messageId(event) ?? parentId;

      const piece = fragment(event);
      if (!piece) continue;

      text += piece;
      onText?.(text);
    }

    if (!text.trim()) {
      throw Object.assign(new Error('Claude accepted the request but returned no answer text.'), {
        thread: { conversationId, parentId }
      });
    }

    return { text, thread: { conversationId, parentId } };
  } finally {
    guard.done();
  }
}

export async function forget() {
  await chrome.storage.session.remove(CACHE_KEY);
}
