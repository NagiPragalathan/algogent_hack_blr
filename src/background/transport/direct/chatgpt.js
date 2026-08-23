/**
 * ChatGPT, over chatgpt.com/backend-api — the endpoint its own web client calls.
 *
 * Undocumented, unversioned, and rather more defended than Gemini's: every turn
 * is preceded by a "chat requirements" handshake that issues a one-shot token
 * and, usually, a proof of work to solve (see `sentinel.js`). The answer is a
 * server-sent event stream that has carried two different payload shapes in
 * living memory, so — as in `gemini.js` — the reply is found by scanning every
 * event rather than by trusting a fixed field.
 *
 * Continuity is a pair of ids rather than Gemini's three: `conversation_id`
 * names the thread, `parent_message_id` names the turn to hang the next message
 * off.
 *
 * Two things make the session harder to get than Gemini's. Cloudflare fronts the
 * whole origin and will answer a worker fetch with a challenge page instead of
 * JSON; and the backend expects a stable per-device id on every request. Hence
 * the open-tab fallback, which runs the same request from inside a real ChatGPT
 * tab where that challenge has already been passed.
 */

import { lines, idleSignal } from './stream.js';
import { seedToken, solveProof, solveTurnstile } from './sentinel.js';
import { asFile, isImage } from './upload.js';

export const id = 'chatgpt';

/** This engine can carry a picture, which is what lets an agent run use it. */
export const images = true;
/**
 * …and a document, which is a different upload and a different message shape.
 *
 * Declared separately because the two are not one capability: an engine that
 * can attach a screenshot cannot necessarily attach a CV, and a turn carrying
 * the wrong one has to reach the relay rather than go out half-attached.
 */
export const files = true;

const ORIGIN = 'https://chatgpt.com';
const SESSION_URL = `${ORIGIN}/api/auth/session`;
const REQUIREMENTS_URL = `${ORIGIN}/backend-api/sentinel/chat-requirements`;
const CONVERSATION_URL = `${ORIGIN}/backend-api/conversation`;

const CACHE_KEY = 'directSession:chatgpt';
/**
 * The device id is kept in `storage.local`, not `storage.session`, and that is
 * deliberate: a value that changed on every browser restart would look far more
 * like automation than a browser does.
 */
const DEVICE_KEY = 'directDeviceId:chatgpt';

// The bearer is a JWT that outlives this by a wide margin. The window is about
// not re-fetching on every turn, not about expiry.
const TTL_MS = 20 * 60 * 1000;

export const EMPTY = { conversationId: null, parentId: null };

export const resumable = (thread) => Boolean(thread?.conversationId);

const userAgent = () => globalThis.navigator?.userAgent ?? '';

/* -------------------------------------------------------------------------
 * Session
 * ---------------------------------------------------------------------- */

async function deviceId() {
  const { [DEVICE_KEY]: existing } = await chrome.storage.local.get(DEVICE_KEY);
  if (existing) return existing;

  const fresh = crypto.randomUUID();
  await chrome.storage.local.set({ [DEVICE_KEY]: fresh });
  return fresh;
}

/**
 * Signed out is not an error status here — the endpoint answers 200 with an
 * empty object — so the body decides rather than the code.
 */
function readSession(body) {
  const accessToken = body?.accessToken;
  if (typeof accessToken !== 'string' || !accessToken) return null;
  return { accessToken, email: body?.user?.email ?? null };
}

async function fetchFromWorker() {
  const response = await fetch(SESSION_URL, {
    credentials: 'include',
    headers: { Accept: 'application/json' },
    redirect: 'follow'
  });

  // A 403 with an HTML body is Cloudflare, not OpenAI, and the fix is "open a
  // ChatGPT tab" rather than "sign in again" — worth telling them apart.
  if (response.status === 403) {
    return { blocked: 'Cloudflare challenged the request. Open a chatgpt.com tab, let it load, then retry.' };
  }
  if (!response.ok) return { blocked: `ChatGPT returned HTTP ${response.status}.` };

  try {
    return readSession(await response.json());
  } catch {
    return null; // a challenge page served as 200 — the tab may still work
  }
}

/**
 * The same request, from inside an open ChatGPT tab. Same-origin, with whatever
 * Cloudflare clearance that tab has already earned, so it succeeds in exactly
 * the cases the worker fetch cannot.
 */
async function readFromOpenTab() {
  const [tab] = await chrome.tabs.query({ url: `${ORIGIN}/*` });
  if (!tab?.id) return null;

  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async () => {
        const response = await fetch('/api/auth/session', {
          credentials: 'include',
          headers: { Accept: 'application/json' }
        });
        if (!response.ok) return null;
        return response.json().catch(() => null);
      }
    });
    return readSession(result?.result);
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
    from = await fetchFromWorker();
  } catch (err) {
    return { ok: false, reason: `Could not reach chatgpt.com: ${err.message}` };
  }

  // Even a Cloudflare-blocked worker fetch is worth following with the tab:
  // an open ChatGPT tab has already passed the challenge we were refused.
  const found = from?.accessToken ? from : await readFromOpenTab();

  if (!found) {
    return {
      ok: false,
      reason:
        from?.blocked ??
        'Not signed in to ChatGPT in this browser profile, or the session response was ' +
          'a challenge page. Open chatgpt.com, sign in, then retry.'
    };
  }

  const resolved = { ...found, deviceId: await deviceId(), expiresAt: Date.now() + TTL_MS };
  await chrome.storage.session.set({ [CACHE_KEY]: resolved });
  return { ok: true, session: resolved };
}

export async function session(options = {}) {
  return (await resolve(options)).session ?? null;
}

/** Why this engine can or cannot answer, for the Options page. */
export async function probe() {
  const { ok, reason, session: found } = await resolve({ force: true });
  return { ok, reason, detail: found?.email ?? null };
}

/* -------------------------------------------------------------------------
 * The handshake
 * ---------------------------------------------------------------------- */

function baseHeaders({ accessToken, deviceId: device }) {
  return {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'oai-device-id': device,
    'oai-language': 'en-US'
  };
}

/**
 * The pre-flight the backend requires before it will read a message.
 *
 * The `p` in the body matters: handshakes sent without a proof of their own are
 * the ones that come back demanding a Turnstile challenge.
 */
async function requirements(auth, seedProof, signal) {
  const response = await fetch(REQUIREMENTS_URL, {
    method: 'POST',
    credentials: 'include',
    headers: baseHeaders(auth),
    body: JSON.stringify({ p: seedProof }),
    signal
  });

  if (!response.ok) {
    throw Object.assign(
      new Error(`The chat-requirements handshake returned HTTP ${response.status}.`),
      {
        // 403 here is the sentinel refusing, not a stale bearer. Retrying it
        // with a fresh token asks the same question twice and gets the same
        // answer — `index.js` stands the provider down instead.
        stale: response.status === 401,
        status: response.status,
        retryAfter: response.headers?.get?.('retry-after') ?? null
      }
    );
  }

  const body = await response.json().catch(() => null);
  if (!body?.token) throw new Error('The chat-requirements handshake returned no token.');
  return body;
}

/* -------------------------------------------------------------------------
 * Images
 * ---------------------------------------------------------------------- */

const FILES_URL = `${ORIGIN}/backend-api/files`;

async function postJson(url, headers, body) {
  const response = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers,
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`An upload step returned HTTP ${response.status}.`);
  return response.json().catch(() => null);
}

/**
 * Three hops, none of them optional: ask the backend where to put the bytes,
 * PUT them into the Azure blob it names, then tell the backend they landed.
 * Only after the third is the file id nameable in a message.
 *
 * The middle hop is Azure's protocol rather than OpenAI's — unauthenticated,
 * addressed entirely by the signed URL, and it insists on both of those
 * headers. The third looks like bookkeeping and is not: without it the file id
 * exists but is not attachable, and the message is accepted and answered as if
 * no image had been sent at all.
 *
 * `use_case` is the other thing that is not bookkeeping. A picture and a
 * document are two different objects to this endpoint: `multimodal` files are
 * addressed by an `image_asset_pointer` the model LOOKS at, `my_files` are
 * handed to the file-reading tool. A PDF uploaded as `multimodal` is accepted,
 * given a pointer, and then read by nothing — the turn succeeds, the panel says
 * "attached", and the answer is written as though no CV had been sent.
 */
async function uploadFile({ name, mime, bytes }, headers) {
  const picture = isImage({ mime });

  const created = await postJson(FILES_URL, headers, {
    file_name: name,
    file_size: bytes.length,
    use_case: picture ? 'multimodal' : 'my_files'
  });

  if (!created?.upload_url || !created?.file_id) {
    throw new Error("ChatGPT's upload endpoint returned no upload URL — its shape changed.");
  }

  const put = await fetch(created.upload_url, {
    method: 'PUT',
    headers: {
      'x-ms-blob-type': 'BlockBlob',
      'x-ms-version': '2020-04-08',
      'Content-Type': mime
    },
    body: bytes
  });
  if (!put.ok) throw new Error(`Blob storage rejected ${name} with HTTP ${put.status}.`);

  await postJson(`${FILES_URL}/${created.file_id}/uploaded`, headers, {});

  return { id: created.file_id, name, mime, size: bytes.length, width: 0, height: 0, picture };
}

/**
 * Where an attachment has to appear, which is not the same for the two kinds.
 *
 * A picture needs both: an asset pointer inside the message content, which is
 * what the model reads, and an entry in the metadata, which is what the UI and
 * the moderation pass read. A document needs only the second — its content
 * parts stay plain text, because it is reached through the file tool rather
 * than looked at. Give a document a pointer as well and the message carries a
 * `multimodal_text` part naming a file that is not an image; it is accepted,
 * and the model sees nothing.
 */
function attachmentParts(uploads) {
  return {
    parts: uploads
      .filter((f) => f.picture)
      .map((f) => ({
        content_type: 'image_asset_pointer',
        asset_pointer: `file-service://${f.id}`,
        size_bytes: f.size,
        width: f.width,
        height: f.height
      })),
    metadata: uploads.map((f) => ({
      id: f.id,
      name: f.name,
      mimeType: f.mime,
      size: f.size,
      ...(f.picture ? { width: f.width, height: f.height } : {})
    }))
  };
}

/* -------------------------------------------------------------------------
 * Reading the reply out of the event stream
 * ---------------------------------------------------------------------- */

/**
 * Two shapes to cope with, and a turn may use either.
 *
 * The long-standing one repeats the whole message on every event, so the
 * longest wins. The newer delta protocol sends an opening frame and then bare
 * string fragments to append. Accumulating both and preferring whichever has
 * more text is the same tactic `gemini.js` uses on its frames, for the same
 * reason: the shape is not ours to rely on.
 */
function reader() {
  const state = {
    longest: '',
    delta: '',
    conversationId: null,
    parentId: null,
    /**
     * What arrived, for when nothing readable did.
     *
     * "ChatGPT accepted the request but the stream carried no answer text" names
     * a symptom and nothing else — it is the same sentence whether the endpoint
     * changed shape, the body was not an event stream at all, or the connection
     * produced nothing. Those need three different responses, and telling them
     * apart afterwards is impossible without knowing what came back. So the
     * count and a sample of the top-level keys ride along with the failure.
     */
    events: 0,
    keys: new Set()
  };

  return {
    state,
    /** @returns {boolean} whether the visible text grew */
    absorb(event) {
      if (!event || typeof event !== 'object') return false;
      const before = state.delta.length > state.longest.length ? state.delta : state.longest;

      state.events += 1;
      if (state.keys.size < 12) for (const key of Object.keys(event)) state.keys.add(key);

      // The delta protocol's opening frame nests everything a level deeper, so
      // both placements have to be read or a continued thread silently restarts.
      const conv = event.conversation_id ?? event.v?.conversation_id;
      if (typeof conv === 'string') state.conversationId = conv;

      const message = event.message ?? event.v?.message ?? null;
      if (message) {
        if (typeof message.id === 'string') state.parentId = message.id;

        const parts = message.content?.parts;
        if (Array.isArray(parts)) {
          const text = parts.filter((part) => typeof part === 'string').join('');
          if (text.length > state.longest.length) state.longest = text;
        }
      }

      if (typeof event.v === 'string') state.delta += event.v;
      if (Array.isArray(event.v)) {
        for (const patch of event.v) {
          if (typeof patch?.v === 'string' && String(patch.p ?? '').includes('parts')) {
            state.delta += patch.v;
          }
        }
      }

      const after = state.delta.length > state.longest.length ? state.delta : state.longest;
      return after.length > before.length;
    },
    text() {
      return state.delta.length > state.longest.length ? state.delta : state.longest;
    }
  };
}

/* -------------------------------------------------------------------------
 * Scaffolding the web client would have rendered away
 * ---------------------------------------------------------------------- */

/**
 * The private-use characters ChatGPT wraps its own markup in.
 *
 * The stream carries citations, file references and navigation lists as spans
 * delimited by U+E200–U+E20F, e.g. a `cite` / `turn0search1` pair. The web
 * client turns those into the little source chips you see under an answer, so
 * nobody driving the page ever saw one. Reading the endpoint directly means
 * reading the raw text, and the markers come with it — this is a cost of the
 * fast path that only shows up once a turn does something citation-shaped, which
 * is why it surfaced on a research task and never before.
 *
 * Two ways it goes wrong and neither is cosmetic. In the panel the tokens are
 * printed at the reader as `fileciteturn0file0L5-L8`. In an agent run they
 * are prose in front of the JSON block, so `parseAction` reports "no action" and
 * the run spends its misreads on markup the provider never meant to send.
 */
const SCAFFOLD_SPAN = /\uE200[\s\S]*?\uE201/g;

/**
 * A span the stream has not finished sending yet.
 *
 * Deltas arrive mid-token constantly, and a half-written citation printed to the
 * panel flickers as garbage before the closing delimiter lands. Anything from an
 * opening marker to the end of what we have so far is held back; the next delta
 * either closes it or extends it.
 */
const SCAFFOLD_TAIL = /\uE200[^\uE201]*$/;

/**
 * The same markers with the delimiters already lost.
 *
 * Belt and braces: some paths strip the private-use characters before we see
 * them (a copy through a text node, an encoding that drops them), leaving the
 * payload behind as a bare word. `citeturn0search1` and its siblings are not
 * strings that occur in prose.
 */
const SCAFFOLD_BARE = /(?:file)?(?:cite|navlist|video)turn\d+\w*/g;

/**
 * The form ChatGPT leaves behind when its OWN renderer does not resolve a
 * citation, rather than when we read the stream ahead of it.
 *
 * `:contentReference[oaicite:0]{index=0}` is markup the web client is supposed
 * to turn into a source chip, and it survives every path here: the private-use
 * delimiters the rules above strip are not involved, so `scrub` passed it
 * through untouched and the panel printed it at the reader. Measured on a train
 * fares run — the answer ended
 * "…and another ₹1,046–₹1,931. :contentReference[oaicite:0]{index=0}
 * :contentReference[oaicite:1]{index=1}" — which reads as the extension having
 * broken, not as ChatGPT having sent scaffolding.
 *
 * It is worse than cosmetic in a run: the agent's answer is a JSON string, and
 * this lands INSIDE it, so the user's saved answer carries it too.
 *
 * Written as its own rule rather than folded into SCAFFOLD_BARE because the
 * shapes have nothing in common — that one matches a bare `turn<n>` suffix
 * welded to the previous word, this one is a complete bracketed expression.
 */
const SCAFFOLD_REFERENCE = /:?contentReference\[[^\]]*\]\{[^}]*\}/g;

/**
 * The older bracket citation, e.g. `【oaicite:0†source】` or `【4:1†file.pdf】`.
 *
 * The dagger is what makes this safe to strip: CJK corner brackets appear in
 * ordinary text — quoting Japanese, naming a title — and a rule matching those
 * alone would eat part of a legitimate answer. Nothing but this citation form
 * puts a U+2020 between them.
 */
const SCAFFOLD_BRACKET = /\u3010[^\u3011]*\u2020[^\u3011]*\u3011/g;

/** Answer text as the reader was meant to see it. */
export function scrub(text) {
  return String(text)
    .replace(SCAFFOLD_SPAN, '')
    .replace(SCAFFOLD_TAIL, '')
    .replace(SCAFFOLD_BARE, '')
    .replace(SCAFFOLD_REFERENCE, '')
    .replace(SCAFFOLD_BRACKET, '')
    // Anything left is a marker whose partner never arrived.
    .replace(/[\uE200-\uE20F]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

/**
 * Why a 200 carried no answer, told apart into the three cases that need
 * different responses.
 *
 * NOTHING AT ALL — no events, no body. The request was accepted and produced
 * silence, which is the shape of a dropped connection, and it is worth exactly
 * one more attempt. `retryable` says so, and it is set ONLY here: retrying a
 * turn that reached a conversation would post the user's message twice, which
 * is worse than the error.
 *
 * NOT AN EVENT STREAM — a JSON body instead. That is this endpoint saying
 * something in its own words, and repeating those words is far more use than
 * any sentence written here in advance.
 *
 * A SHAPE WE DO NOT READ — events arrived and none of them had text where this
 * knows to look. That is the endpoint having changed, which the whole folder is
 * written to expect; naming the keys that DID arrive is what makes the next fix
 * a five-minute one instead of a bisect.
 */
function emptyStream(state, stray) {
  if (state.events === 0) {
    const body = stray.trim();

    if (body) {
      let said = null;
      try {
        const parsed = JSON.parse(body);
        said = parsed?.detail ?? parsed?.error?.message ?? parsed?.message ?? null;
        if (said && typeof said !== 'string') said = JSON.stringify(said);
      } catch {
        /* not JSON either — the excerpt below is all there is */
      }

      return Object.assign(
        new Error(
          said
            ? `ChatGPT answered with a message instead of a reply: ${said}`
            : `ChatGPT answered with something that was not an event stream: ${body.slice(0, 200)}`
        ),
        { status: 200 }
      );
    }

    return Object.assign(
      new Error('ChatGPT accepted the request and then sent nothing at all. Asking once more.'),
      { retryable: true }
    );
  }

  const keys = [...state.keys].join(', ') || 'none';
  return new Error(
    `ChatGPT streamed ${state.events} event(s) but none carried answer text — its response shape ` +
      `has most likely changed. Top-level keys seen: ${keys}.`
  );
}

/* -------------------------------------------------------------------------
 * The turn
 * ---------------------------------------------------------------------- */

export async function ask({ prompt, thread = EMPTY, image = null, signal, onText, timeoutMs = 90000 }) {
  const auth = await session();
  if (!auth) {
    throw new Error('Not signed in to ChatGPT in this browser profile.');
  }

  const guard = idleSignal(signal, timeoutMs);

  try {
    // One token, used twice: sent with the handshake, and then as the key the
    // Turnstile answer unmasks against.
    const seedProof = seedToken({ userAgent: userAgent() });
    const required = await requirements(auth, seedProof, guard.signal);

    const headers = {
      ...baseHeaders(auth),
      Accept: 'text/event-stream',
      'openai-sentinel-chat-requirements-token': required.token
    };

    const work = required.proofofwork;
    if (work?.required) {
      const proof = solveProof({
        seed: work.seed,
        difficulty: work.difficulty,
        userAgent: userAgent()
      });
      if (!proof) throw new Error('Could not solve the proof-of-work challenge in time.');
      headers['openai-sentinel-proof-token'] = proof;
    }

    const challenge = required.turnstile;
    if (challenge?.required) {
      const answer = challenge.dx ? solveTurnstile(challenge.dx, seedProof) : null;
      if (!answer) throw new Error('ChatGPT asked for a Turnstile challenge this cannot answer.');
      headers['openai-sentinel-turnstile-token'] = answer;
    }

    /**
     * The picture goes up before the turn, on the headers we have just earned.
     *
     * A failure here is the upload endpoint rather than the chat one, and it
     * surfaces before anything is sent — a turn that claims a screenshot is
     * attached and carries none is answered from an image the model never saw.
     */
    const file = image ? asFile(image, 'screenshot') : null;

    /**
     * An attachment we could not read is a failure, never a turn without one.
     *
     * Carrying on would send a prompt that SAYS a file is attached with nothing
     * behind it, which is the one outcome no layer downstream can detect.
     * Throwing hands the turn to the relay instead, where the provider's own
     * uploader has four routes and a delivery check behind it.
     */
    if (image && !file) {
      throw new Error('The attachment could not be read, so this turn needs the window.');
    }

    const attached = file ? attachmentParts([await uploadFile(file, baseHeaders(auth))]) : null;

    const message = {
      id: crypto.randomUUID(),
      author: { role: 'user' },
      create_time: Date.now() / 1000,
      content: attached?.parts.length
        // Pointers first and the prompt last, which is the order the web client
        // sends and the order the model reads them in. A document adds no part,
        // so a turn carrying only one keeps the plain text shape.
        ? { content_type: 'multimodal_text', parts: [...attached.parts, prompt] }
        : { content_type: 'text', parts: [prompt] }
    };
    if (attached) message.metadata = { attachments: attached.metadata };

    const body = {
      action: 'next',
      messages: [message],
      parent_message_id: thread.parentId ?? crypto.randomUUID(),
      model: 'auto',
      timezone_offset_min: new Date().getTimezoneOffset(),
      history_and_training_disabled: false,
      conversation_mode: { kind: 'primary_assistant' },
      websocket_request_id: crypto.randomUUID()
    };

    // Only on a continuing thread. Sending a null id is not the same as omitting
    // the field — the backend reads the former as a malformed request.
    if (thread.conversationId) body.conversation_id = thread.conversationId;

    const response = await fetch(CONVERSATION_URL, {
      method: 'POST',
      credentials: 'include',
      headers,
      body: JSON.stringify(body),
      signal: guard.signal
    });

    if (!response.ok) {
      // 401 is a stale bearer, which `index.js` retries once with a forced
      // refresh. Anything else is usually the sentinel refusing the proof.
      throw Object.assign(new Error(`ChatGPT returned HTTP ${response.status}.`), {
        stale: response.status === 401,
        status: response.status,
        retryAfter: response.headers?.get?.('retry-after') ?? null
      });
    }

    const events = reader();

    /**
     * Anything that was NOT an event, kept in case none of it was.
     *
     * A 200 whose body is plain JSON rather than an event stream is a real and
     * regular answer from this endpoint — `{"detail": "…"}` when something was
     * refused upstream, for instance. Every line of it fails the `data:` test,
     * the loop finishes having absorbed nothing, and the generic "no answer
     * text" hides a message that says exactly what happened. Bounded, because
     * this is an error path and the body could be anything.
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
        // Scrubbed on the way out, not on the way in: the raw text is what the
        // NEXT delta appends to, and stripping a half-arrived citation from the
        // accumulator would make the closing delimiter land on nothing and the
        // rest of the span leak through as prose.
        if (events.absorb(JSON.parse(payload))) onText?.(scrub(events.text()));
      } catch {
        /* a keep-alive or a partial line — the next one may still parse */
      }
    }

    const text = scrub(events.text());
    if (!text.trim()) throw emptyStream(events.state, stray);

    return {
      text,
      thread: {
        conversationId: events.state.conversationId ?? thread.conversationId ?? null,
        parentId: events.state.parentId ?? thread.parentId ?? null
      },
      // Reported rather than assumed. Every path that fails to deliver the file
      // throws above, so reaching here means the three hops completed and the
      // id was named in the message — which is as close to proof as this
      // endpoint offers.
      attached: Boolean(attached)
    };
  } finally {
    guard.done();
  }
}

export async function forget() {
  await chrome.storage.session.remove(CACHE_KEY);
}
