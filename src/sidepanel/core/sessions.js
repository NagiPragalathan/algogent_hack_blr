import { state, uid } from './state.js';
import { emit, EVENTS } from './bus.js';

/**
 * Sessions on disk.
 *
 * Everything lives in `chrome.storage.local` under three keys: the session
 * list, which one is current, and the handful of panel preferences worth
 * remembering. Both caps below exist so a long-running profile cannot grow this
 * without bound — storage.local is a few megabytes, and a chat history that
 * fills it takes the extension down with it.
 */

const MAX_SESSIONS = 50;
const MAX_TURNS_PER_SESSION = 60;

export function newSession() {
  return {
    id: uid('s'),
    title: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    providerIds: [],
    turns: [],
    /** Which provider-side thread each answer went to, for resuming later. */
    conversationUrls: {}
  };
}

/**
 * Which conversation belongs to which tab.
 *
 * In `chrome.storage.session`, deliberately, while the conversations
 * themselves stay in `storage.local`. Chrome hands out tab ids from zero again
 * after a restart, so a binding kept on disk would sooner or later give a
 * brand new tab somebody else's chat — the same id, a different page, a
 * history that makes no sense and cannot be explained. Session storage is
 * wiped when the browser closes, which is exactly the lifetime a tab id has.
 * The chats survive; only the binding expires.
 */
let boundToTab = {};

export async function restoreTabBindings() {
  const stored = await chrome.storage.session.get('tabSessions').catch(() => ({}));
  boundToTab = stored?.tabSessions || {};
}

async function persistBindings() {
  await chrome.storage.session.set({ tabSessions: boundToTab }).catch(() => {});
}

/**
 * Show the conversation that belongs to `tabId`, saving the one on screen.
 *
 * Returns whether anything changed, because the caller repaints on that and a
 * repaint of the same thread on every navigation event would restart every
 * entry animation in it.
 */
export async function openTabSession(tabId) {
  if (tabId == null || tabId === state.tabId) return false;

  await saveThread();

  state.tabId = tabId;
  const bound = boundToTab[tabId];
  const existing = bound && state.sessions.find((s) => s.id === bound);

  state.session = existing || newSession();
  boundToTab[tabId] = state.session.id;
  await persistBindings();

  return true;
}

/** A tab closed: its chat stays in history, its claim on that id does not. */
export async function forgetTabBinding(tabId) {
  if (boundToTab[tabId] == null) return;
  delete boundToTab[tabId];
  await persistBindings();
}

/**
 * Point the current tab at a different conversation.
 *
 * Reopening one from history has to move the binding too, or the next tab
 * switch swaps back to whatever the tab was bound to before and the chat you
 * just opened vanishes with no explanation.
 */
export async function bindCurrentTab(sessionId) {
  if (state.tabId == null || !sessionId) return;
  boundToTab[state.tabId] = sessionId;
  await persistBindings();
}

export async function saveThread() {
  const session = state.session;
  if (!session) return;

  session.updatedAt = Date.now();
  session.turns = session.turns.slice(-MAX_TURNS_PER_SESSION);
  if (!session.title && session.turns.length) {
    session.title = session.turns[0].question.slice(0, 80);
  }
  session.providerIds = [...new Set(session.turns.flatMap((t) => t.providerIds))];

  const index = state.sessions.findIndex((s) => s.id === session.id);
  if (session.turns.length) {
    if (index >= 0) state.sessions[index] = session;
    else state.sessions.unshift(session);
  } else if (index >= 0) {
    // An empty session is not worth a history entry.
    state.sessions.splice(index, 1);
  }

  state.sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  state.sessions = state.sessions.slice(0, MAX_SESSIONS);

  await chrome.storage.local.set({
    sessions: state.sessions,
    currentSessionId: session.id,
    panelPrefs: {
      active: state.active,
      compare: state.compare,
      agentPolicy: state.agentPolicy
    }
  });

  emit(EVENTS.SESSIONS_CHANGED);
}

/**
 * Write the session list back without touching which one is current.
 *
 * `saveThread` is about the conversation on screen: it titles it, files it and
 * records it as current. That is exactly wrong for a run painting into a chat
 * you have switched away from — it would keep declaring that chat current and
 * fight the tab you are actually on. This is the other half: the steps landed,
 * the answer landed, put it on disk and leave the cursor where the user left it.
 */
export async function persistSessions() {
  state.sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  state.sessions = state.sessions.slice(0, MAX_SESSIONS);
  await chrome.storage.local.set({ sessions: state.sessions });
  emit(EVENTS.SESSIONS_CHANGED);
}

export async function restoreThread() {
  const [stored] = await Promise.all([
    chrome.storage.local.get(['sessions', 'currentSessionId', 'panelPrefs']),
    restoreTabBindings()
  ]);

  state.sessions = stored.sessions || [];

  const prefs = stored.panelPrefs || {};
  if (prefs.active) state.active = prefs.active;
  state.compare = Boolean(prefs.compare);
  if (prefs.agentPolicy) state.agentPolicy = prefs.agentPolicy;

  /**
   * A placeholder until INIT says which tab this panel is on.
   *
   * `currentSessionId` is no longer the answer — conversations belong to tabs
   * now — but it is still the right fallback for a panel opened where there is
   * no ordinary tab to bind to at all (over chrome://extensions, say), which
   * would otherwise be a chat that cannot be saved or found again.
   */
  state.session =
    state.sessions.find((s) => s.id === stored.currentSessionId) || newSession();
}

export async function forgetAllSessions() {
  state.sessions = [];
  state.session = newSession();
  await chrome.storage.local.set({ sessions: [] });
}

export async function removeSession(id) {
  state.sessions = state.sessions.filter((s) => s.id !== id);
  await chrome.storage.local.set({ sessions: state.sessions });
}
