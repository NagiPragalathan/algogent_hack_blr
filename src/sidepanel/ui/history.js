import { els, make } from '../core/dom.js';
import { state } from '../core/state.js';
import { send } from '../core/port.js';
import { icon } from '../lib/icons.js';
import { newSession, saveThread, removeSession, bindCurrentTab } from '../core/sessions.js';
import { renderProviderSheet, renderProviderPill } from './providers.js';
import { renderThread } from './thread.js';
import { syncComposer } from './composer.js';
import { liveIn } from '../core/runs.js';
// Announced rather than called: `ui/running.js` offers the way back into a
// conversation, which is this module's own `loadSession` — importing it here
// would close that ring.
import { emit, EVENTS } from '../core/bus.js';

/** Past chats, newest first, in the full-height drawer. */

function relativeTime(ms) {
  const seconds = Math.round((Date.now() - ms) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ms).toLocaleDateString();
}

export function renderHistory() {
  els.historyList.replaceChildren();

  if (!state.sessions.length) {
    const empty = make('div', 'empty');
    empty.innerHTML =
      '<h2>No saved chats yet</h2><p>Conversations appear here once you ask ' +
      'something. Press ✚ to start a new one.</p>';
    els.historyList.append(empty);
    return;
  }

  for (const session of state.sessions) {
    els.historyList.append(sessionRow(session));
  }
}

function sessionRow(session) {
  const row = make('button', 'session');
  row.setAttribute('aria-current', String(session.id === state.session?.id));

  const main = make('div', 'session-main');
  const title = make('span', 'session-title', session.title || 'Untitled chat');

  const meta = make('div', 'session-meta');
  const dots = make('span', 'session-dots');
  for (const id of session.providerIds || []) {
    const dot = document.createElement('i');
    dot.style.background = state.byId[id]?.color || '#888';
    dot.title = state.byId[id]?.name || id;
    dots.append(dot);
  }

  const count = session.turns.length;
  meta.append(
    dots,
    document.createTextNode(
      `${count} ${count === 1 ? 'question' : 'questions'} · ${relativeTime(session.updatedAt)}`
    )
  );

  main.append(title, meta);

  /**
   * A chat with something still running in it, marked where you go looking.
   *
   * The panel follows the tab you are on, so the conversation an agent is
   * working in is often not the one on screen — and history is the list you
   * open to find it again. A row that looks identical to a finished chat is a
   * run you have to remember the existence of.
   */
  const { chat, agent } = liveIn(session.id);
  if (chat || agent) {
    row.classList.add('live');
    main.append(
      make('span', 'session-live', agent ? 'Agent running' : 'Waiting for a reply')
    );
  }

  const del = make('span', 'session-del');
  del.innerHTML = icon('trash', 14);
  del.title = 'Delete this chat';
  del.addEventListener('click', (e) => {
    e.stopPropagation();
    deleteSession(session.id);
  });

  row.append(main, del);
  row.addEventListener('click', () => loadSession(session.id));
  return row;
}

export function loadSession(id) {
  const session = state.sessions.find((s) => s.id === id);
  if (!session) return;

  state.session = session;
  // The tab now shows this chat, so it has to be bound to it — otherwise the
  // next tab switch swaps back to whatever it was bound to before and the
  // conversation you just opened disappears with nothing to explain it.
  bindCurrentTab(session.id);

  // Point each provider back at the thread this session was using, so the next
  // question continues it instead of opening a fresh chat.
  send({ type: 'SET_CONVERSATIONS', sessionId: session.id, urls: session.conversationUrls || {} });

  if (!state.compare && session.providerIds?.length) {
    if (!session.providerIds.includes(state.active)) state.active = session.providerIds[0];
  }

  els.history.hidden = true;
  /**
   * Both, because this is the one place `state.active` changes behind your back.
   *
   * Opening a chat that was held with another provider switches to it — and only
   * the sheet was repainted, so the composer pill went on naming the provider
   * you had left. It said "Gemini" while the tick in the list, the question that
   * went out and the answer that came back were all ChatGPT's. The pill is the
   * one of the two that is always on screen, so it is the one that was believed.
   */
  renderProviderSheet();
  renderProviderPill();
  renderThread();
  // Every hand-swap of `state.session` has to re-read the composer: opening a
  // chat with a live run in it needs the Stop button back, and opening a
  // finished one needs it gone.
  syncComposer();
  emit(EVENTS.RUNS_CHANGED);
  saveThread();
}

export async function deleteSession(id) {
  const wasCurrent = state.session?.id === id;
  await removeSession(id);

  if (wasCurrent) {
    state.session = newSession();
    bindCurrentTab(state.session.id);
    send({ type: 'SET_CONVERSATIONS', sessionId: state.session.id, urls: {} });
    renderThread();
    syncComposer();
    emit(EVENTS.RUNS_CHANGED);
  }

  renderHistory();
}
