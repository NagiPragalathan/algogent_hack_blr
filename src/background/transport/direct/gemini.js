/**
 * Gemini, over the endpoint gemini.google.com calls from its own page.
 *
 * `StreamGenerate` is Google's batchexecute RPC: undocumented, unversioned, and
 * it has changed its response framing before. Everything here therefore fails
 * loudly and specifically, and degrades by SCANNING rather than by trusting a
 * fixed array index — a break in this file means "Google moved the endpoint",
 * not "the session is bad", and `index.js` falls back to the relay window
 * rather than reporting either.
 *
 * Authentication is the browser's own cookies, attached automatically by the
 * host permission. Nothing here reads, copies or stores a cookie. What a client
 * does have to supply for itself is the per-session XSRF token Google embeds in
 * the app shell:
 *
 *   SNlM0e -> at     the XSRF token, sent with every RPC
 *   cfb2h  -> bl     the frontend build label, which the endpoint checks
 *   FdrFJe -> f.sid  the batchexecute channel's session id
 *
 * Cached in `chrome.storage.session` — memory-backed, gone when the browser
 * closes. Deliberately not `storage.local`, which lands in the profile
 * directory and would outlive the session the token belongs to.
 */

import { lines, idleSignal } from './stream.js';
import { asFile } from './upload.js';

export const id = 'gemini';

/** This engine can carry a picture, which is what lets an agent run use it. */
export const images = true;
/**
 * …and a document, which here is the same call.
 *
 * Unlike ChatGPT, the push host takes bytes and a filename and asks nothing
 * about what they are — the identifier it returns is named in the prompt slot
 * either way. Declared separately all the same, because the two capabilities
 * come apart at the other engines and a turn must be able to ask about the one
 * it actually needs.
 */
export const files = true;

const ORIGIN = 'https://gemini.google.com';
const RPC_URL = `${ORIGIN}/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate`;
const CACHE_KEY = 'directSession:gemini';

/**
 * SNlM0e is tied to the login rather than to a published clock, but
 * __Secure-1PSIDTS rotates every few minutes and refetching the shell renews it
 * as a side effect. Twenty minutes stays comfortably ahead of that.
 */
const TTL_MS = 20 * 60 * 1000;

/** Continuity is three opaque ids the previous reply handed back. */
export const EMPTY = { cid: '', rid: '', rcid: '' };

/** A thread we can resume is one with a conversation id in it. */
export const resumable = (thread) => Boolean(thread?.cid);

/**
 * Google wants a monotonically increasing request id per channel. Seeded
 * randomly so two profiles do not start from the same value.
 */
let reqid = Math.floor(Math.random() * 900000) + 100000;

/* -------------------------------------------------------------------------
 * Session
 * ---------------------------------------------------------------------- */

/**
 * WIZ_global_data is a large object literal inline in the shell HTML. Picking
 * the three keys out individually is far more durable than slicing the whole
 * literal out and parsing it — Google reshapes that blob constantly, but the
 * key names have been stable for years.
 */
function parseTokens(html) {
  const pick = (key) => html.match(new RegExp(`"${key}":"([^"]+)"`))?.[1] ?? null;

  const at = pick('SNlM0e');
  if (!at) return null;

  return { at, bl: pick('cfb2h'), sid: pick('FdrFJe') };
}

/**
 * A signed-out request does not fail. Google 302s to the login page and serves
 * it with a 200, so the status says nothing and the landing URL says everything.
 */
async function fetchShell() {
  const response = await fetch(`${ORIGIN}/app`, { credentials: 'include', redirect: 'follow' });

  if (/accounts\.google\.com|ServiceLogin/.test(response.url)) {
    return { blocked: 'Not signed in to Google in this browser profile.' };
  }
  if (!response.ok) return { blocked: `Gemini returned HTTP ${response.status}.` };

  return parseTokens(await response.text());
}

/**
 * The fallback for when the worker's own fetch comes back as the signed-out
 * shell. Reading WIZ_global_data out of a live Gemini tab is unambiguously
 * first-party, so it works whenever the page itself does — but it needs a tab
 * to already be open, which is why it is not the primary path.
 */
async function readFromOpenTab() {
  const [tab] = await chrome.tabs.query({ url: `${ORIGIN}/*` });
  if (!tab?.id) return null;

  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: () => {
        const data = globalThis.WIZ_global_data;
        if (!data?.SNlM0e) return null;
        return { at: data.SNlM0e, bl: data.cfb2h ?? null, sid: data.FdrFJe ?? null };
      }
    });
    return result?.result ?? null;
  } catch {
    return null; // the tab navigated away, or is still loading
  }
}

/**
 * Resolve the session, from cache when it is still warm, and say why when it
 * cannot be.
 *
 * `session()` and `probe()` are both built on this, so there is exactly one
 * copy of the logic. A diagnostic that reasons about a credential separately
 * from the code that uses it will eventually disagree with reality, which is
 * worse than no diagnostic at all.
 */
async function resolve({ force = false } = {}) {
  if (!force) {
    const { [CACHE_KEY]: cached } = await chrome.storage.session.get(CACHE_KEY);
    if (cached && cached.expiresAt > Date.now()) return { ok: true, session: cached };
  }

  let found;
  try {
    found = await fetchShell();
  } catch (err) {
    return { ok: false, reason: `Could not reach gemini.google.com: ${err.message}` };
  }

  // The live-page fallback is worth trying even on a blocked shell: a tab that
  // is already open has whatever the worker's own request was refused.
  const tokens = found?.at ? found : await readFromOpenTab();

  if (!tokens) {
    return {
      ok: false,
      reason:
        found?.blocked ??
        'Signed in, but no SNlM0e token was found in the app shell — Google most ' +
          'likely changed its layout. Open a Gemini tab and retry to use the live-page fallback.'
    };
  }

  const resolved = { ...tokens, expiresAt: Date.now() + TTL_MS };
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
 * Reading the reply out of the frames
 * ---------------------------------------------------------------------- */

/**
 * One line of the response, turned into whatever payload frames it carries.
 *
 * The body is `)]}'` followed by repeated `<byte-length>\n<json>` frames. Rather
 * than trusting that framing, every parseable line is scanned for `wrb.fr`
 * envelopes — a length prefix simply fails to parse and is skipped.
 */
function framesIn(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('[')) return [];

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return []; // a length prefix, or a frame the server split oddly
  }

  const out = [];
  for (const entry of parsed) {
    if (Array.isArray(entry) && entry[0] === 'wrb.fr' && typeof entry[2] === 'string') {
      try {
        out.push(JSON.parse(entry[2]));
      } catch {
        /* not the payload frame */
      }
    }
  }
  return out;
}

/**
 * Known layout: body[1] = [conversation_id, response_id], body[4] = candidates,
 * each candidate = [choice_id, [text], …]. Both indices have moved between
 * revisions, so the shape is verified before it is trusted.
 */
function readCandidates(body) {
  if (Array.isArray(body?.[4]) && body[4].length) return body[4];

  for (const field of body ?? []) {
    const looksRight =
      Array.isArray(field) &&
      field.length &&
      Array.isArray(field[0]) &&
      typeof field[0][0] === 'string' &&
      Array.isArray(field[0][1]);
    if (looksRight) return field;
  }
  return null;
}

function readText(candidate) {
  const slot = candidate?.[1];
  if (typeof slot === 'string') return slot;
  if (Array.isArray(slot) && typeof slot[0] === 'string') return slot[0];

  // Last resort: the longest string anywhere in the candidate, which in
  // practice is the answer body.
  let best = '';
  const walk = (node, depth) => {
    if (depth > 8) return;
    if (typeof node === 'string') {
      if (node.length > best.length) best = node;
      return;
    }
    if (Array.isArray(node)) node.forEach((child) => walk(child, depth + 1));
  };
  walk(candidate, 0);
  return best;
}

/* -------------------------------------------------------------------------
 * Images
 * ---------------------------------------------------------------------- */

/**
 * Gemini's web client does not put image bytes in the chat request. It POSTs
 * the file to Google's push-upload host, gets back an opaque identifier, and
 * names that identifier in the prompt slot of the StreamGenerate payload. This
 * is the first half; `promptSlot` below is the second.
 *
 * `credentials: 'omit'` is not an oversight — this host has no session to speak
 * of, and the upload is addressed entirely by the push id, which is the web
 * client's own and selects a bucket rather than identifying anybody.
 */
const UPLOAD_URL = 'https://content-push.googleapis.com/upload/';
const PUSH_ID = 'feeds/mcudyrk2a4khkz';

async function uploadFileToPush({ name, mime, bytes }) {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: mime }), name);

  const response = await fetch(UPLOAD_URL, {
    method: 'POST',
    credentials: 'omit',
    headers: { 'Push-ID': PUSH_ID },
    body: form
  });

  if (!response.ok) throw new Error(`Gemini's upload endpoint returned HTTP ${response.status}.`);

  const identifier = (await response.text()).trim();

  // Success is a bare opaque token. Anything with markup in it is an error page
  // served as a 200, which is worth catching here rather than as a baffling
  // chat failure one step later.
  if (!identifier || identifier.includes('<') || identifier.length > 4096) {
    throw new Error("Gemini's upload endpoint returned something unexpected.");
  }

  return identifier;
}

/**
 * Attachments ride in the PROMPT slot rather than a field of their own:
 * `[prompt, 0, null, [[[identifier, 1], filename], …]]`. The two constants are
 * the web client's own — a mode flag and a per-image source marker. A text-only
 * turn keeps the shorter one-element form the endpoint has always accepted,
 * because that is the shape with the most mileage on it.
 */
const promptSlot = (prompt, uploaded) =>
  uploaded.length ? [prompt, 0, null, uploaded.map(({ id: ref, name }) => [[ref, 1], name])] : [prompt];

/* -------------------------------------------------------------------------
 * The turn
 * ---------------------------------------------------------------------- */

/**
 * Send one prompt and stream the reply back through `onText`.
 *
 * `rt=c` makes the endpoint stream, and each frame repeats the WHOLE answer so
 * far rather than appending to it — which is why the longest frame wins rather
 * than the last. Length is the reliable proxy for completeness here and
 * position is not: trailing frames are routinely metadata or a short follow-up
 * suggestion, and taking the first match instead yields "Hello! How" in place of
 * the paragraph.
 *
 * @returns {Promise<{ text: string, thread: object }>}
 */
export async function ask({ prompt, thread = EMPTY, image = null, signal, onText, timeoutMs = 90000 }) {
  const tokens = await session();
  if (!tokens) throw new Error('Not signed in to Google in this browser profile.');

  /**
   * The picture goes up first, and separately.
   *
   * A failure here is the upload host, not the chat endpoint, and surfacing it
   * before the turn is sent is what keeps a half-attached message from being
   * answered — the model would be told a screenshot is attached and would
   * reason about one it never saw, which is the most expensive failure in this
   * whole codebase.
   */
  const file = image ? asFile(image, 'screenshot') : null;

  /**
   * An attachment we could not read is a failure, never a turn without one.
   *
   * The prompt above already SAYS a file is attached, so carrying on sends a
   * message describing something that is not there — and nothing downstream can
   * tell that from a message that arrived intact. Throwing hands the turn to
   * the relay, where the provider's own uploader tries instead.
   */
  if (image && !file) {
    throw new Error('The attachment could not be read, so this turn needs the window.');
  }

  const uploaded = [];
  if (file) uploaded.push({ id: await uploadFileToPush(file), name: file.name });

  const query = new URLSearchParams({ rt: 'c', _reqid: String((reqid += 100000)) });
  if (tokens.bl) query.set('bl', tokens.bl);
  if (tokens.sid) query.set('f.sid', tokens.sid);

  const inner = [promptSlot(prompt, uploaded), null, [thread.cid, thread.rid, thread.rcid]];
  const body = new URLSearchParams({
    'f.req': JSON.stringify([null, JSON.stringify(inner)]),
    at: tokens.at
  });

  const guard = idleSignal(signal, timeoutMs);

  try {
    const response = await fetch(`${RPC_URL}?${query}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body,
      signal: guard.signal
    });

    if (!response.ok) {
      // A 400 here is nearly always a stale `at`: the session outlived the
      // cache window. `index.js` mints a fresh one and asks exactly once more.
      throw Object.assign(new Error(`Gemini returned HTTP ${response.status}.`), {
        stale: response.status === 400 || response.status === 401,
        status: response.status,
        retryAfter: response.headers?.get?.('retry-after') ?? null
      });
    }

    let text = '';
    let ids = { ...thread };
    let winner = null;

    for await (const line of lines(response)) {
      guard.touch();

      for (const frame of framesIn(line)) {
        // Ids can arrive on a different frame than the longest text, so every
        // frame is swept rather than only the winning one.
        const meta = Array.isArray(frame?.[1]) ? frame[1] : null;
        if (typeof meta?.[0] === 'string') ids.cid = meta[0];
        if (typeof meta?.[1] === 'string') ids.rid = meta[1];

        const candidates = readCandidates(frame);
        if (!candidates) continue;

        const found = readText(candidates[0]);
        if (found.length <= text.length) continue;

        text = found;
        winner = candidates[0];
        onText?.(text);
      }
    }

    if (!text.trim()) throw new Error('Gemini accepted the request but returned no answer text.');

    return {
      text,
      thread: {
        cid: ids.cid || thread.cid,
        rid: ids.rid || thread.rid,
        rcid: typeof winner?.[0] === 'string' ? winner[0] : thread.rcid
      },
      // Reported rather than assumed: the upload throws on every failure path,
      // so reaching here means the push host took the bytes and its identifier
      // went out in the prompt slot.
      attached: uploaded.length > 0
    };
  } finally {
    guard.done();
  }
}

export async function forget() {
  await chrome.storage.session.remove(CACHE_KEY);
}
