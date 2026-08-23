import { loadState } from './settings.js';

/**
 * Which provider-side thread each provider is currently in.
 *
 * The provider rewrites its URL to a real conversation path once the first
 * message lands. Remembering that per provider means a later session rejoins
 * the same thread — the model keeps its context, and the provider's own history
 * shows one ongoing conversation instead of a pile of one-question chats.
 *
 * ONE thread per provider per panel chat, for questions and for agent runs
 * alike. There used to be two — an `agent` scope beside `chat` — and the reason
 * was real: a run that opens in the thread where the LAST run ended gets
 * answered from that history instead of from the page. Measured: a run asked to
 * fill a sample form, sent into the thread where the previous run had concluded
 * "the submission has reached a security verification step", replied with that
 * same paragraph verbatim, carried no action, and finished at zero steps. Three
 * runs in a row.
 *
 * That is now handled where it belongs — `NEW_TASK_BANNER` in `agent/run.js`
 * tells the model outright that everything above is over — which is the same
 * guard that already let consecutive runs share a thread. Keeping the split as
 * well bought nothing and cost the thing people actually see: one panel
 * conversation appearing twice in the provider's own sidebar, under two
 * unrelated names.
 *
 * What the split did still buy is worth writing down, because it is the price
 * of this: an agent run's JSON turns now sit above the user's next ordinary
 * question in the same thread. If that ever becomes the bigger problem,
 * reinstating an `agent` key here and pointing `run.js` back at it is the whole
 * change.
 */

/**
 * Storage key per scope. An unknown scope is a chat — never a silent no-op,
 * which is also what makes `scope: 'none'` (chat naming, filed nowhere) safe:
 * `inflight.js` refuses to file it before this is ever consulted.
 */
const SCOPES = {
  chat: 'conversationUrls'
};
const keyFor = (scope) => SCOPES[scope] || SCOPES.chat;

/**
 * The same question, asked of the direct transport.
 *
 * `transport/direct` never opens a page, so there is no URL to remember — a
 * provider's own API hands back opaque continuation ids instead (three for
 * Gemini, a pair for ChatGPT and Claude, one for Meta). It is the identical
 * fact in a different currency: which provider-side thread THIS panel chat is
 * in. So it lives here, in the same buckets, evicted by the same rule, rather
 * than in a second store that would drift out of step with this one.
 *
 * Kept in a separate storage key rather than beside the URLs because the two
 * transports file at different moments and a merged record would have half of
 * it overwritten by whichever spoke last.
 */
const THREAD_SCOPES = {
  chat: 'directThreads'
};
const threadKeyFor = (scope) => THREAD_SCOPES[scope] || THREAD_SCOPES.chat;

/**
 * One bucket per panel chat, because one slot per provider was the bug.
 *
 * The store used to be `{providerId: url}` — a single thread per provider for
 * the whole extension — and `run.js` decided whether to resume it by comparing
 * the panel chat against one remembered "owner" id. That works for exactly one
 * conversation. The moment a second is in play, every switch between them fails
 * the comparison, opens a brand new provider thread, and overwrites the slot the
 * other one was using — so going back to the first opens a new thread as well.
 * Alternate between two chats and you get a new provider conversation *per
 * task*, which is what a Gemini sidebar full of "Naukri Profile Assistance",
 * "Update IT Skills…", "Start KBC Quiz" actually is.
 *
 * That got much easier to hit once the panel started following tabs, but the
 * shape was always wrong: "which thread is this chat in" is a question per
 * chat, and it was being stored per browser.
 *
 * Buckets are capped and evicted oldest-first. A provider thread from forty
 * conversations ago is not one anybody is going back to, and this is
 * `storage.local`, which the whole extension shares.
 */
const MAX_BUCKETS = 24;

/** No session id at all — the untracked case, and what `chat` still uses. */
const SHARED = '_';

/**
 * Read the store, upgrading the flat `{providerId: url}` shape as it goes.
 *
 * A profile that ran an earlier build has one, and dropping it would silently
 * detach every provider thread the user currently has open. It becomes the
 * shared bucket, which is where an untracked request looks anyway.
 */
async function load(key) {
  const stored = (await chrome.storage.local.get(key))[key];

  if (!stored || typeof stored !== 'object') return { v: 2, order: [], buckets: {} };
  if (stored.v === 2) return stored;

  return { v: 2, order: [SHARED], buckets: { [SHARED]: stored } };
}

async function save(key, store) {
  // Oldest first, so the tail is what goes.
  while (store.order.length > MAX_BUCKETS) {
    delete store.buckets[store.order.shift()];
  }
  await chrome.storage.local.set({ [key]: store });
}

function touch(store, bucket) {
  const at = store.order.indexOf(bucket);
  if (at >= 0) store.order.splice(at, 1);
  store.order.push(bucket);
  return (store.buckets[bucket] ||= {});
}

export async function getConversationUrls(scope = 'chat', sessionId = null) {
  const store = await load(keyFor(scope));
  return store.buckets[sessionId || SHARED] || {};
}

export async function setConversationUrls(urls, scope = 'chat', sessionId = null) {
  const store = await load(keyFor(scope));
  store.buckets[sessionId || SHARED] = urls || {};
  touch(store, sessionId || SHARED);
  await save(keyFor(scope), store);
}

/**
 * The direct transport's continuation ids for one provider in one chat.
 *
 * Null means "no thread yet", which is what makes the next turn open one.
 */
export async function getThread(providerId, scope = 'chat', sessionId = null) {
  const store = await load(threadKeyFor(scope));
  return store.buckets[sessionId || SHARED]?.[providerId] ?? null;
}

export async function setThread(providerId, thread, scope = 'chat', sessionId = null) {
  const store = await load(threadKeyFor(scope));
  touch(store, sessionId || SHARED)[providerId] = thread;
  await save(threadKeyFor(scope), store);
}

/**
 * Walk away from the direct thread. This IS "new chat" on that transport.
 *
 * There is no page to navigate and no window to reset — the whole of starting
 * over is forgetting the ids, after which the next question carries none and
 * the provider opens a conversation for it. Must be called wherever
 * `forgetConversation` is, or New chat drops the URL, leaves the ids, and the
 * "new" chat carries straight on from the old one.
 */
export async function forgetThread(providerId, scope = 'chat', sessionId = null) {
  const store = await load(threadKeyFor(scope));
  const bucket = store.buckets[sessionId || SHARED];
  if (!bucket || !(providerId in bucket)) return;
  delete bucket[providerId];
  await save(threadKeyFor(scope), store);
}

/** A URL is only worth storing if it points at a specific conversation. */
function looksLikeConversation(url, provider) {
  if (!url) return false;

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  /**
   * Must still be the provider's own site — a redirect to a login or consent
   * page would otherwise be saved as the conversation.
   *
   * `www.` is ignored, because several providers are reachable at both spellings
   * and land on whichever one they prefer. A strict compare rejects the real
   * conversation URL, nothing is ever stored for that provider, and every turn
   * resumes nothing and opens a NEW thread — which is invisible until you look
   * at the provider's own history and find a conversation per question. Meta,
   * Perplexity and Kimi are all declared with a `www.` home and all match both.
   */
  const bare = (h) => h.replace(/^www\./, '');
  const home = new URL(provider.homeUrl);
  if (bare(parsed.hostname) !== bare(home.hostname)) return false;

  // Reject the bare landing pages, which carry no conversation id.
  const strip = (u) => u.replace(/\/+$/, '');
  if (strip(parsed.href) === strip(provider.homeUrl)) return false;
  if (strip(parsed.href) === strip(provider.newChatUrl)) return false;

  // Every provider puts the id in a path segment: /c/<id>, /chat/<uuid>,
  // /app/<id>. A single-segment path is still a landing page.
  return parsed.pathname.split('/').filter(Boolean).length >= 2;
}

/** Returns the stored URL when it was worth keeping, otherwise null. */
export async function rememberConversation(providerId, url, scope = 'chat', sessionId = null) {
  const { providers } = await loadState();
  const provider = providers[providerId];
  if (!provider || !looksLikeConversation(url, provider)) return null;

  const store = await load(keyFor(scope));
  const urls = touch(store, sessionId || SHARED);
  if (urls[providerId] === url) return url;

  urls[providerId] = url;
  await save(keyFor(scope), store);
  return url;
}

/**
 * Does this chat already have a thread with this provider, in this scope?
 *
 * URLs only, deliberately — this answers `fresh` for the WINDOW path, and a
 * direct thread is not something a window can resume. Widening it to count
 * direct threads too was tried and is the wrong shape: it makes `fresh` false
 * for a relay turn that has no URL to resume, and `ensureProviderTab` with a
 * null resume URL reuses the tab exactly as it stands — so the question lands
 * in whatever conversation that tab happened to be left in. The direct path
 * does not need this at all; it reads `getThread` and keys off that.
 */
export async function hasConversation(providerId, scope = 'chat', sessionId = null) {
  const urls = await getConversationUrls(scope, sessionId);
  return Boolean(urls[providerId]);
}

export async function forgetConversation(providerId, scope = 'chat', sessionId = null) {
  const store = await load(keyFor(scope));
  const bucket = store.buckets[sessionId || SHARED];
  if (!bucket || !(providerId in bucket)) return;
  delete bucket[providerId];
  await save(keyFor(scope), store);
}
