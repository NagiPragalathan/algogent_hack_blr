/**
 * Meta AI, over its GraphQL endpoint — the one meta.ai calls from its own page.
 *
 * The awkward part is not the authentication, it is the query id. Meta serves
 * PERSISTED queries: the client does not send GraphQL text, it sends a `doc_id`
 * naming a query the server already knows. Those ids rotate with every frontend
 * deploy — far faster than anything on the other three — so `DOC_ID` below is a
 * starting point rather than a constant, and a wrong one fails specifically
 * enough to say so instead of looking like a session problem.
 *
 * To read the current id: open meta.ai, send a message, and in DevTools →
 * Network find the POST to /api/graphql/ whose form data contains
 * `useAbraSendMessageMutation`. Its `doc_id` field is the value.
 *
 * There are also two ways to be signed in here, and they present entirely
 * different credentials:
 *
 *   account  signed in through Facebook or Instagram. The page carries an
 *            fb_dtsg CSRF token, exactly like any other Facebook property.
 *   temp     the default, and the common case. Meta AI hands anyone a throwaway
 *            account, and those pages carry NO fb_dtsg — demanding one reads a
 *            perfectly usable session as signed out. They authenticate with an
 *            access token minted by a mutation, which is what the site itself
 *            does the first time you land on it.
 */

import { lines, idleSignal } from './stream.js';

export const id = 'meta';

const ORIGINS = ['https://www.meta.ai', 'https://meta.ai'];
const ORIGIN = ORIGINS[0];
const GRAPHQL_URL = `${ORIGIN}/api/graphql/`;

const CACHE_KEY = 'directSession:meta';
const TTL_MS = 20 * 60 * 1000;

const SEND_MUTATION = 'useAbraSendMessageMutation';
const DOC_ID = '25786176774163663';

const TOS_MUTATION = 'useAbraAcceptTOSForTempUserMutation';
const TOS_DOC_ID = '7604648749596940';

export const EMPTY = { conversationId: null };

export const resumable = (thread) => Boolean(thread?.conversationId);

/* -------------------------------------------------------------------------
 * Session
 * ---------------------------------------------------------------------- */

/**
 * Meta embeds these in several shapes depending on which of their bundlers
 * rendered the page, and meta.ai does not use the same one as facebook.com.
 * Trying each is far cheaper than being wrong about which.
 */
const DTSG = [
  /"DTSGInitialData",\[\],\{"token":"([^"]+)"/,
  /"DTSGInitData",\[\],\{"token":"([^"]+)"/,
  /"dtsg":\s*\{"token":"([^"]+)"/,
  /name="fb_dtsg"\s+value="([^"]+)"/
];

const LSD = [
  /"LSD",\[\],\{"token":"([^"]+)"/,
  /"lsd":\s*"([^"]+)"/,
  /name="lsd"\s+value="([^"]+)"/
];

const USER = [/"USER_ID":"(\d+)"/, /"userID":"(\d+)"/, /"actorID":"(\d+)"/];

function firstMatch(html, patterns) {
  for (const pattern of patterns) {
    const found = html.match(pattern)?.[1];
    if (found) return found;
  }
  return null;
}

/**
 * Meta has more than one Meta AI, and this engine speaks one of them.
 *
 * Everything here is the "abra" build — fb_dtsg/lsd plus persisted GraphQL
 * mutations. The newer "ecto" one is a different application with its own
 * session cookie (`ecto_1_sess`), its own storage and an API this does not
 * know; its URLs look like `/prompt/<uuid>`. Telling them apart is what makes
 * the difference between a useful answer and a wrong one, because on an ecto
 * build every abra token is legitimately absent — so reporting "signed out"
 * sends the reader off to re-authenticate a session that was never the problem,
 * and leaves them wondering why a window keeps opening for a provider that is
 * supposed to be on the fast path.
 */
function detectFrontend(html) {
  if (/ecto_1_sess|EctoAppSession|ecto-pending-content|"ecto"/i.test(html)) return 'ecto';
  if (/abra|DTSGInitialData|"LSD",\[\]/i.test(html)) return 'abra';
  return 'unknown';
}

function parseTokens(html) {
  const userId = firstMatch(html, USER);
  return {
    fbDtsg: firstMatch(html, DTSG),
    lsd: firstMatch(html, LSD),
    // 0 is what a throwaway account reports, and it is not an id worth keeping.
    userId: userId && userId !== '0' ? userId : null,
    frontend: detectFrontend(html)
  };
}

async function fetchShell() {
  const response = await fetch(`${ORIGIN}/`, { credentials: 'include', redirect: 'follow' });
  if (!response.ok) return { blocked: `Meta AI returned HTTP ${response.status}.` };

  const html = await response.text();

  // Meta AI is not offered everywhere, and the block is served as an ordinary
  // page rather than an error. Worth naming: no amount of signing in fixes it.
  if (/not available in your (country|region)|isn't available yet in your/i.test(html)) {
    return { blocked: 'Meta AI is not available in this region.' };
  }

  return parseTokens(html);
}

async function readFromOpenTab() {
  const tabs = [];
  for (const origin of ORIGINS) {
    tabs.push(...(await chrome.tabs.query({ url: `${origin}/*` })));
  }

  for (const tab of tabs) {
    try {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        func: () => document.documentElement.innerHTML
      });
      const tokens = parseTokens(result?.result ?? '');
      if (tokens.fbDtsg || tokens.lsd) return tokens;
    } catch {
      /* the tab navigated away — try the next */
    }
  }
  return null;
}

/** Mint the access token a throwaway account authenticates with. */
async function mintTempToken(lsd) {
  const response = await fetch(GRAPHQL_URL, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'x-fb-friendly-name': TOS_MUTATION
    },
    body: new URLSearchParams({
      lsd,
      __a: '1',
      fb_api_caller_class: 'RelayModern',
      fb_api_req_friendly_name: TOS_MUTATION,
      doc_id: TOS_DOC_ID,
      variables: JSON.stringify({
        dob: '1990-01-01',
        icebreaker_type: 'TEXT',
        __relay_internal__pv__WebPixelRatiorelayprovider: 1
      })
    })
  });

  if (!response.ok) return null;
  // JSON, sometimes behind Facebook's anti-hijack prefix, so it is read as text.
  return (await response.text()).match(/"access_token":"([^"]+)"/)?.[1] ?? null;
}

/**
 * Resolve the session, and say why when it cannot be.
 *
 * `session()` and `probe()` are both built on this so there is exactly one
 * copy of the logic — a diagnostic that reasons about the credential
 * separately from the code that uses it is a diagnostic that will eventually
 * disagree with reality, which is worse than none.
 */
async function resolve({ force = false } = {}) {
  if (!force) {
    const { [CACHE_KEY]: cached } = await chrome.storage.session.get(CACHE_KEY);
    if (cached && cached.expiresAt > Date.now()) return { ok: true, session: cached };
  }

  let tokens;
  try {
    tokens = await fetchShell();
  } catch (err) {
    return { ok: false, reason: `Could not reach meta.ai: ${err.message}` };
  }

  if (tokens?.blocked) return { ok: false, reason: tokens.blocked };
  if (!tokens?.fbDtsg && !tokens?.lsd) tokens = (await readFromOpenTab()) ?? tokens;

  let resolved = null;

  if (tokens?.fbDtsg) {
    resolved = { kind: 'account', ...tokens, accessToken: null };
  } else if (tokens?.lsd) {
    const accessToken = await mintTempToken(tokens.lsd).catch(() => null);
    if (accessToken) resolved = { kind: 'temp', ...tokens, accessToken };
  }

  if (!resolved) {
    // "Signed in to a build this engine cannot talk to" is not "signed out",
    // and only one of those is something anybody can act on.
    if (tokens?.frontend === 'ecto') {
      return {
        ok: false,
        reason:
          'Your meta.ai is running Meta\'s newer "ecto" frontend (its URLs look like ' +
          '/prompt/…), which uses a different API than this engine speaks. Your ' +
          'session is fine — the engine is. Meta AI will keep using the window.'
      };
    }
    return {
      ok: false,
      reason: 'Could not establish a Meta AI session. Open meta.ai, let it finish loading, then retry.'
    };
  }

  resolved.expiresAt = Date.now() + TTL_MS;
  await chrome.storage.session.set({ [CACHE_KEY]: resolved });
  return { ok: true, session: resolved };
}

export async function session(options = {}) {
  return (await resolve(options)).session ?? null;
}

/** Why this engine can or cannot answer, for the Options page. */
export async function probe() {
  const { ok, reason, session: found } = await resolve({ force: true });
  return { ok, reason, detail: found ? (found.kind === 'temp' ? 'guest account' : found.userId) : null };
}

/* -------------------------------------------------------------------------
 * The turn
 * ---------------------------------------------------------------------- */

/** Meta's threading id is a 19-digit decimal, not a uuid, and is only echoed. */
function offlineThreadingId() {
  const high = BigInt(Math.floor(Math.random() * 0xffffffff));
  const low = BigInt(Math.floor(Math.random() * 0xffffffff));
  return ((high << 32n) | low).toString().slice(0, 19);
}

/**
 * Newline-delimited JSON rather than SSE: one object per line, each carrying
 * the whole answer so far. As on Gemini, the longest snippet wins rather than
 * the last — trailing lines are routinely state-only.
 */
export async function ask({ prompt, thread = EMPTY, signal, onText, timeoutMs = 90000 }) {
  const auth = await session();
  if (!auth) throw new Error('Could not establish a Meta AI session.');

  const conversationId = thread.conversationId ?? crypto.randomUUID();

  const form = new URLSearchParams({
    lsd: auth.lsd ?? '',
    __a: '1',
    __comet_req: '15',
    fb_api_caller_class: 'RelayModern',
    fb_api_req_friendly_name: SEND_MUTATION,
    server_timestamps: 'true',
    doc_id: DOC_ID,
    variables: JSON.stringify({
      message: { sensitive_string_value: prompt },
      externalConversationId: conversationId,
      offlineThreadingId: offlineThreadingId(),
      suggestedPromptIndex: null,
      flashVideoRecapInput: { images: [] },
      flashPreviewInput: null,
      promptPrefix: null,
      entrypoint: 'ABRA__CHAT__TEXT',
      icebreaker_type: 'TEXT',
      __relay_internal__pv__AbraDebugDevOnlyrelayprovider: false,
      __relay_internal__pv__WebPixelRatiorelayprovider: 1
    })
  });

  // The two session kinds present different credentials, and an EMPTY fb_dtsg is
  // not the same as an absent one — the endpoint reads it as a failed CSRF check.
  if (auth.kind === 'temp' && auth.accessToken) {
    form.set('access_token', auth.accessToken);
  } else {
    form.set('fb_dtsg', auth.fbDtsg);
    form.set('av', auth.userId ?? '0');
  }

  const guard = idleSignal(signal, timeoutMs);

  try {
    const response = await fetch(GRAPHQL_URL, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'x-fb-friendly-name': SEND_MUTATION
      },
      body: form,
      signal: guard.signal
    });

    if (!response.ok) {
      throw Object.assign(new Error(`Meta AI returned HTTP ${response.status}.`), {
        stale: response.status === 401,
        status: response.status,
        retryAfter: response.headers?.get?.('retry-after') ?? null
      });
    }

    let text = '';
    let id = null;
    let sawResponse = false;

    for await (const line of lines(response)) {
      guard.touch();

      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) continue;

      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue; // a partial line — the next may still parse
      }

      const node = parsed?.data?.node ?? parsed?.data?.xfb_abra_send_message?.node ?? null;
      const message = node?.bot_response_message ?? null;
      if (!message) continue;
      sawResponse = true;

      if (typeof message.conversation_id === 'string') id = message.conversation_id;

      const snippet = message.snippet;
      if (typeof snippet === 'string' && snippet.length > text.length) {
        text = snippet;
        onText?.(text);
      }
    }

    if (!sawResponse) {
      // A stale doc_id comes back as a 200 carrying an error about the
      // persisted query, which would otherwise read as "no answer text" and
      // send the reader looking in entirely the wrong place.
      throw new Error(
        `Meta AI returned nothing for query id ${DOC_ID}. These rotate with every ` +
          'frontend deploy.'
      );
    }

    if (!text.trim()) throw new Error('Meta AI accepted the request but returned no answer text.');

    return { text, thread: { conversationId: id ?? conversationId } };
  } finally {
    guard.done();
  }
}

export async function forget() {
  await chrome.storage.session.remove(CACHE_KEY);
}
