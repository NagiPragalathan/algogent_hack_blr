import { state } from './state.js';
import { emit, EVENTS } from './bus.js';

/**
 * Which conversation each thing in flight belongs to.
 *
 * The panel used to answer that with "the one on screen", and everything else
 * followed from it: `state.busyReq` and `state.agentRunId` were single slots,
 * every message from the worker was looked up in `state.turns` — which is
 * whichever session happens to be open — and so the panel had to be FROZEN to
 * the running chat or the reply would land in the wrong one, or nowhere.
 *
 * That freeze is what made the agent feel like it had taken the browser over.
 * A run is minutes long; switching to another tab in the middle of one is the
 * most ordinary thing in the world, and the panel answered it by refusing to
 * move — you were shown the agent's chat about a page you were no longer
 * looking at, with a composer locked by a run happening somewhere else.
 *
 * So ownership is recorded when the request starts and read back when its
 * messages arrive. The panel is then free to follow you: a run keeps painting
 * into ITS conversation whether or not that conversation is on screen, and a
 * tab you open gets the blank chat it should have had all along.
 *
 * Nothing here is persisted. A request cannot outlive the panel that started
 * it — the worker's reply goes to a port that no longer exists — so a map that
 * survived a reload would only ever describe requests that can never land.
 */

/** requestId -> { sessionId, kind: 'chat' | 'agent' } */
const owners = new Map();

export function trackRequest(id, sessionId, kind = 'chat') {
  if (id == null) return;
  owners.set(id, { sessionId: sessionId ?? null, kind });
  emit(EVENTS.RUNS_CHANGED);
}

export function forgetRequest(id) {
  if (!owners.delete(id)) return;
  emit(EVENTS.RUNS_CHANGED);
}

/**
 * The session a request belongs to, wherever it currently lives.
 *
 * `state.sessions` holds the same object as `state.session` once it has been
 * saved — `saveThread` assigns the live object into the array rather than a
 * copy — so mutating what this returns mutates the real conversation, on screen
 * or not. That identity is the whole reason this works; replacing it with a
 * clone anywhere would leave streamed text going into a session that gets
 * overwritten by the next save.
 */
export function sessionOf(id) {
  const owner = owners.get(id);
  if (!owner) return null;
  if (state.session?.id === owner.sessionId) return state.session;
  return state.sessions.find((s) => s.id === owner.sessionId) || null;
}

/**
 * The turn a message is about.
 *
 * Falls back to the visible session for an id nobody claimed — a message that
 * arrives after `forgetRequest`, or one from a run this panel did not start.
 * Dropping those silently would lose the only explanation of a failure.
 */
export function requestTurn(id) {
  // A missing id must find nothing. `t.agent?.runId === undefined` is true for
  // every ordinary chat turn, so without this a message that arrived without
  // one would attach itself to an unrelated question and repaint it.
  if (id == null) return null;

  const session = sessionOf(id) || state.session;
  if (!session) return null;
  return session.turns.find((t) => t.id === id || t.agent?.runId === id) || null;
}

/** Is the conversation this request belongs to the one on screen? */
export function isVisible(id) {
  const owner = owners.get(id);
  if (!owner) return true;
  return state.session?.id === owner.sessionId;
}

/**
 * What is in flight in one conversation.
 *
 * Two slots rather than a count, because the composer needs to know WHICH: Stop
 * cancels an agent run and a chat ask through different messages, and sending
 * the wrong one leaves the run going with the panel claiming it stopped.
 */
export function liveIn(sessionId) {
  let chat = null;
  let agent = null;
  for (const [id, owner] of owners) {
    if (owner.sessionId !== sessionId) continue;
    if (owner.kind === 'agent') agent = id;
    else chat = id;
  }
  return { chat, agent };
}

/**
 * Conversations with something running that you are NOT looking at.
 *
 * The price of letting the panel follow you: a run you started is now
 * invisible, and an agent driving tabs with nothing on screen saying so is
 * worse than the freeze it replaced. `ui/running.js` turns this into the one
 * line that says where it went and how to get back.
 */
export function runsElsewhere() {
  const seen = new Set();
  const out = [];

  for (const [id, owner] of owners) {
    if (owner.sessionId == null) continue;
    if (state.session?.id === owner.sessionId) continue;
    if (seen.has(owner.sessionId)) continue;
    seen.add(owner.sessionId);

    const session = state.sessions.find((s) => s.id === owner.sessionId);
    if (!session) continue;
    out.push({ id, kind: owner.kind, session });
  }

  return out;
}
