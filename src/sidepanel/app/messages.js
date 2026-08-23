import { els } from '../core/dom.js';
import { state } from '../core/state.js';
import { send } from '../core/port.js';
import {
  saveThread,
  persistSessions,
  openTabSession,
  forgetTabBinding
} from '../core/sessions.js';
import { requestTurn, sessionOf, isVisible, forgetRequest } from '../core/runs.js';
import { emit, EVENTS } from '../core/bus.js';
import { setHint, flashHint } from '../ui/hint.js';
import { renderProviderSheet, renderProviderPill, setProviderBusy } from '../ui/providers.js';
import { renderThread, patchAnswer } from '../ui/thread.js';
import { patchAgent } from '../ui/agent.js';
import { thinkingExcerpt } from '../lib/thinking.js';
import { paintContext } from '../ui/context.js';
import { renderTabPicker } from '../ui/tab-picker.js';
import { renderAttachmentChips } from '../ui/attachments.js';
import { setBusy, finishIfIdle, setAskProgress, syncComposer } from '../ui/composer.js';
import { noteAction, settleRun } from '../payments/run-billing.js';

/**
 * A message landed on a turn. Repaint it, or file it away.
 *
 * Every handler below ends here, and the two branches are the whole point of
 * the change: a conversation you are looking at repaints, and a conversation
 * you have switched away from is written to disk instead. Painting into it
 * regardless is what the old code could not do — it looked the turn up in
 * whatever session was on screen, so it either drew the run's steps into the
 * wrong chat or found nothing and dropped them.
 *
 * Persisting on every delta would be a storage write per streamed character, so
 * only the callers that know something durable happened pass `save`.
 */
function landed(id, paint, save = false) {
  if (isVisible(id)) paint();
  else if (save) persistSessions();
}

/**
 * Everything the service worker says, and what the panel does about it.
 *
 * One switch rather than per-feature listeners: the panel has a single channel,
 * and having one place that lists every message it can receive is worth more
 * than the coupling costs.
 */

const SETTLED = ['done', 'error', 'need_login', 'cancelled'];

export function handlePortMessage(msg) {
  switch (msg.type) {
    case 'INIT_RESULT':
      return onInit(msg);

    case 'ACTIVE_TAB':
      return onActiveTab(msg);

    case 'CONTEXT_RESULT':
      return paintContext(msg);

    case 'CONTEXT_USED':
      return onContextUsed(msg);

    case 'CONTEXT_WARNING':
      return setHint(`Sent without page context — ${msg.error}`, 'warn');

    case 'CONVERSATION': {
      // Record which provider-side thread this session is tied to — the session
      // that ASKED, which is not always the one on screen any more.
      const session = sessionOf(msg.reqId) || state.session;
      if (!session) return;
      session.conversationUrls[msg.providerId] = msg.url;
      if (session === state.session) saveThread();
      else persistSessions();
      return;
    }

    /**
     * The worker has left a provider thread that only a window could resume.
     *
     * Forgetting it in the store is not enough on its own: this copy is seeded
     * back into the store on every tab switch (`SET_CONVERSATIONS`, where the
     * store wins for keys it still has — and it no longer has this one). The URL
     * would reappear, the chat would be treated as window-owned again, and the
     * next turn would leave it again. Both copies go, or neither does.
     */
    case 'CONVERSATION_DROPPED': {
      const session = sessionOf(msg.reqId) || state.session;
      if (!session) return;
      delete session.conversationUrls[msg.providerId];
      if (session === state.session) saveThread();
      else persistSessions();
      return;
    }

    case 'STREAM':
      return onStream(msg);

    case 'ASK_PROGRESS':
      // A deep read is several provider turns for one question. Without this the
      // panel looks stalled for a minute and the natural response is to press
      // stop halfway through. The bar carries the same count as the words, for
      // the glance that does not stop to read them.
      setAskProgress(msg.total ? Math.min(1, (msg.done + 1) / (msg.total + 1)) : null);
      return setHint(
        msg.phase === 'answering'
          ? `Read all ${msg.total} parts — writing the answer…`
          : `Reading the page — part ${msg.done + 1} of ${msg.total}…`
      );

    case 'ASK_RETRY':
      // The worker is closing the provider window and opening a fresh one. Say
      // so: from the panel this is a minute of nothing, and an unexplained
      // pause is exactly when people press stop and ask again by hand.
      return setHint(
        `${state.byId[msg.providerId]?.name || 'The provider'} did not answer — ` +
          `reopening its window and asking again (${msg.attempt} of ${msg.of})…`,
        'warn'
      );

    case 'AGENT_STEP':
      return onAgentStep(msg);

    case 'AGENT_PHASE':
      return onAgentPhase(msg);

    case 'AGENT_ATTACHMENT':
      return onAgentAttachment(msg);

    case 'AGENT_THINKING':
      // The provider is mid-reply. The step itself lands when the action is
      // parsed, but the reasoning is arriving now and is worth showing: this
      // is the ten-to-forty seconds in which nothing else on screen moves, and
      // a run that has misunderstood the task says so here, a full round trip
      // before the action that proves it.
      //
      // Only for the run you are watching: a hint about a run in another
      // conversation would overwrite the one belonging to the chat on screen.
      if (isVisible(msg.runId) && requestTurn(msg.runId)?.agent) {
        setHint(thinkingExcerpt(msg.text) || 'Agent is deciding the next step…');
      }
      return;

    case 'AGENT_CONFIRM':
      return onAgentConfirm(msg);

    case 'AGENT_DONE':
      return onAgentDone(msg);

    case 'AGENT_ERROR':
      return onAgentError(msg);

    case 'AGENT_FINISHED':
      return onAgentFinished(msg);

    case 'TAB_LIST':
      return renderTabPicker(msg.tabs || []);

    case 'HANDOFF':
      return onHandoff(msg.handoff);

    case 'SELECTION_CLEARED':
      // Only the auto-attached one goes. Something you picked deliberately
      // through + > Select from screen is not undone by clicking on the page.
      if (state.picked?.fromSelection) {
        state.picked = null;
        renderAttachmentChips();
      }
      return;

    case 'PICKED':
      return onPicked(msg);

    case 'PICKED_IMAGE':
      return onPickedImage(msg);

    case 'ASK_ERROR':
      // Only shouted at whoever asked. The composer is then re-derived rather
      // than switched off, so a failure in one chat cannot unlock — or lock —
      // the one you have since moved to.
      if (isVisible(msg.reqId)) setHint(msg.error, 'error');
      forgetRequest(msg.reqId);
      syncComposer();
      return;

    /**
     * The name came back. Applied only if the session is still the one that
     * asked — a title landing on whatever conversation happens to be open is
     * worse than no title, and the round trip is long enough that switching
     * tabs or opening a chat from history in the meantime is ordinary.
     */
    case 'TITLE': {
      const session = state.session?.id === msg.sessionId
        ? state.session
        : state.sessions.find((s) => s.id === msg.sessionId);
      if (!session || !msg.title) return;
      session.title = msg.title;
      // saveThread emits SESSIONS_CHANGED itself, which is what repaints the
      // history list. Emitting it here as well would paint it twice — and
      // importing the list directly would close the import ring that event
      // exists to prevent.
      saveThread();
      return;
    }

    case 'NEW_CHAT_DONE':
      return flashHint(
        `Started a fresh ${state.byId[msg.providerId]?.name || ''} conversation.`
      );

    case 'LOGIN_OPENED':
      return setHint('Sign in in the window that just opened, then ask again.');

    case 'RELAY_CLOSED':
      return flashHint('Provider window closed.', 2000);

    case 'FATAL':
      setHint(msg.error, 'error');
      setBusy(false);
      return;

    default:
      return;
  }
}

function onInit(msg) {
  state.providers = msg.providers;
  state.byId = Object.fromEntries(msg.providers.map((p) => [p.id, p]));

  const enabled = msg.providers.filter((p) => p.enabled !== false);
  if (!state.active || !state.byId[state.active]?.enabled) {
    state.active = enabled[0]?.id || null;
  }

  state.settings = msg.settings;
  els.ctxOn.checked = msg.settings.contextOnByDefault;
  els.context.classList.toggle('off', !els.ctxOn.checked);
  els.btnCompare.setAttribute('aria-pressed', String(state.compare));

  renderProviderSheet();
  renderProviderPill();
  renderThread();

  // Last, and only after the thread exists to be replaced: this is what turns
  // the restored placeholder into *this tab's* conversation.
  onActiveTab({ type: 'active', tab: msg.tab });
}

/**
 * The user moved to another tab, so the panel moves with them.
 *
 * A conversation belongs to the page it is about. One shared thread meant
 * asking about a job posting, switching to your inbox, and being shown the
 * job questions above a page they no longer describe — and the next question
 * went to the provider on top of that history.
 *
 * A run in flight pins the panel: swapping the thread underneath a run would
 * leave its steps painting into a conversation nobody is looking at, and its
 * Stop button attached to something else. The switch is simply skipped, and
 * the next tab change after the run ends picks it up.
 */
async function onActiveTab(msg) {
  if (msg.type === 'closed') {
    forgetTabBinding(msg.tabId);
    return;
  }

  /**
   * A run in flight used to pin this, and that was the wrong trade.
   *
   * The reason was real — swapping the thread underneath a run left its steps
   * painting into a conversation nobody was looking at — but the cost was
   * paid by the user for minutes at a time: open a tab mid-run and the panel
   * kept showing the agent's chat about a page you had left, with the composer
   * locked by work happening somewhere else. That is the whole "it takes the
   * browser over" feeling, and it was a panel bug, not an agent one.
   *
   * `core/runs.js` fixes the actual problem instead: every message carries the
   * id of the request that started it, so a run paints into ITS conversation
   * whether or not that conversation is on screen. The panel is then free to
   * follow you, and `ui/running.js` keeps the way back one click away.
   */

  /**
   * The session follows the TAB; only the page context follows what is
   * readable.
   *
   * `msg.tab` is null for a new-tab page, Settings, the Web Store — anything
   * with no text to send. Returning here on that basis was the bug: those are
   * exactly the tabs a user opens expecting a clean slate, and the panel
   * instead kept the previous page's conversation on screen. The tabId is
   * always present, so bind on that and let `state.tab` go null, which is what
   * draws "Page unavailable" on the context chip.
   */
  const tabId = msg.tabId ?? msg.tab?.id ?? null;

  state.tab = msg.tab || null;
  if (tabId == null) return;

  if (await openTabSession(tabId)) {
    renderThread();
    renderAttachmentChips();
    // The composer belongs to the conversation now in front of you: a chat with
    // nothing running gets a live Send button even while a run continues in
    // another one. Without this the new tab's blank chat inherits the previous
    // chat's Stop button and cannot be typed into.
    syncComposer();
    /**
     * Tell the worker which provider threads this chat belongs to.
     *
     * The panel keeps `session.conversationUrls` on disk per conversation, and
     * that record used to be pushed only when you opened something from
     * history. Now that switching tabs swaps the conversation, it has to be
     * pushed here too — otherwise the chat you have just switched to has no
     * thread on record, the next question is treated as a brand new chat, and
     * it opens a provider conversation beside the one this chat already had.
     *
     * `navigate: false` because nothing needs to move yet: `ensureProviderTab`
     * steers the relay tab when the question is actually asked, and doing it on
     * every tab switch would drive the provider window around for nothing.
     */
    send({
      type: 'SET_CONVERSATIONS',
      sessionId: state.session?.id ?? null,
      urls: state.session?.conversationUrls || {},
      navigate: false
    });
    // Nothing started or stopped, but "which runs are somewhere else" is
    // measured against the conversation on screen — and that just changed.
    emit(EVENTS.RUNS_CHANGED);
  }
}

function onContextUsed(msg) {
  const turn = requestTurn(msg.reqId);
  if (!turn) return;
  turn.contextTitle = msg.context.title;
  // The context BAR describes the tab you are on, so it is only repainted for a
  // question asked from the conversation still in front of you — a question
  // from another chat must not relabel the page you have moved to.
  landed(msg.reqId, () => {
    state.pageContext = msg.context;
    paintContext({ ok: true, context: msg.context });
    renderThread();
  }, true);
}

function onStream(msg) {
  const turn = requestTurn(msg.reqId);
  if (!turn) return;

  const answer = turn.answers[msg.providerId] || (turn.answers[msg.providerId] = {});
  answer.state = msg.state;
  if (typeof msg.text === 'string') answer.text = msg.text;
  if (msg.error) answer.error = msg.error;
  if (msg.truncated) answer.truncated = true;
  // Sticky: it arrives with `submitted` and must survive every later delta.
  if (msg.notice) answer.notice = msg.notice;

  /**
   * `submitted` is the adapter saying the question was delivered — which is
   * also the moment it knows whether the file went with it. Repaints the whole
   * thread rather than the answer, because the chip lives on YOUR message and
   * `patchAnswer` cannot reach it. Once per provider per turn.
   */
  if (msg.attached !== undefined && turn.upload) {
    turn.upload.state = msg.attached ? 'sent' : 'failed';
    landed(msg.reqId, renderThread, true);
    return;
  }

  landed(msg.reqId, () => patchAnswer(turn.id, msg.providerId));

  if (SETTLED.includes(msg.state)) {
    // The provider pill is one shared control, so it is released whichever
    // conversation the answer belonged to — a dot left spinning for a chat you
    // cannot see reads as the panel being stuck.
    setProviderBusy(msg.providerId, false);
    finishIfIdle(msg.reqId);
    if (msg.state === 'done') nameTheChat(msg.reqId, msg.providerId);
  }
}

/**
 * Ask the model to name the conversation, once, after its first answer.
 *
 * The fallback title is the first question cut at 80 characters, which is how
 * the history ends up reading "Summarise this page in 5 concise bullet points.
 * Lead with what it is actually ab". A truncation is not a title: the list
 * exists to be scanned, and a column of half-sentences cannot be.
 *
 * After the answer, never before it — nobody waits for this, and a title that
 * arrives a second late costs nothing. `titledByAi` is the guard that keeps it
 * to once per conversation; without it every reply in a long chat would spend a
 * round trip renaming it.
 */
function nameTheChat(reqId, providerId) {
  // The conversation that asked, not the one on screen. They are the same most
  // of the time and the exception is exactly when a wrong title is confusing:
  // you switched tabs mid-answer and the blank chat you moved to got named
  // after a question it never contained.
  const session = sessionOf(reqId) || state.session;
  if (!session || session.titledByAi || session.turns.length !== 1) return;

  // Marked before the round trip, not after: two providers answering the same
  // first question in compare mode both settle, and both would ask.
  session.titledByAi = true;
  send({ type: 'TITLE', sessionId: session.id, providerId });
}

/**
 * Where the current turn is in its round trip.
 *
 * Painted onto the step that is running rather than into the hint bar: the
 * step is what you are looking at, and "is it stuck?" is a question about that
 * row. Cleared when the next step arrives, because by then it describes a turn
 * that is over.
 */
function onAgentPhase(msg) {
  const turn = requestTurn(msg.runId);
  if (!turn?.agent) return;
  const via = msg.via || null;
  if (turn.agent.phase === msg.state && turn.agent.via === via) return;
  turn.agent.phase = msg.state;
  // Which transport answered this turn, so the label can say what is actually
  // happening rather than naming a window that may not exist.
  turn.agent.via = via;
  landed(msg.runId, () => patchAgent(turn.id));
}

function onAgentStep(msg) {
  const turn = requestTurn(msg.runId);
  if (!turn?.agent) return;

  /**
   * Every action the run takes is a registered agent with an owner and a price,
   * so it is recorded here and the whole run is settled once when it finishes.
   *
   * Recorded rather than charged: a wallet prompt per step would mean thirty
   * approvals in a run, and a refusal on the eleventh would strand it halfway
   * paid. `noteAction` drops anything that is not a priced action, so steps
   * that are notes or screenshots cost nothing.
   */
  noteAction(msg.runId, msg);
  // A new step means the last turn's round trip finished.
  turn.agent.phase = null;
  turn.agent.steps.push({
    // Stamped on arrival in the panel, which is a message hop after the worker
    // finished the step — close enough that the difference is invisible, and
    // it keeps the timing in one place instead of threading a clock through
    // every emit site in the loop.
    at: Date.now(),
    kind: msg.kind || '',
    description: msg.description,
    thought: msg.thought,
    note: msg.note,
    risk: msg.risk
  });
  // Saved when it lands off screen: a run you switched away from is exactly the
  // one whose steps you will want to read afterwards, and until this the whole
  // timeline existed only in the panel's memory until the run ended.
  landed(msg.runId, () => patchAgent(turn.id), true);
}

/**
 * The turn that carried the user's file, reporting back.
 *
 * A failure also becomes a step, because the timeline is where someone looks to
 * find out why the agent asked for a detail that was in the CV — the chip on
 * the message says what happened, the step says when.
 */
function onAgentAttachment(msg) {
  const turn = requestTurn(msg.runId);
  if (!turn?.upload) return;

  turn.upload.state = msg.ok ? 'sent' : 'failed';
  if (!msg.ok && msg.notice) {
    turn.agent.steps.push({ description: 'Attachment not delivered', note: msg.notice });
  }
  landed(msg.runId, renderThread, true);
}

function onAgentConfirm(msg) {
  const turn = requestTurn(msg.runId);
  if (!turn?.agent) return;
  turn.agent.pendingConfirm = {
    description: msg.description,
    risk: msg.risk,
    // The values the agent needs before it can carry on — see `ask` in
    // background/agent/protocol.js. Absent for an ordinary yes/no.
    fields: Array.isArray(msg.fields) ? msg.fields : null
  };
  /**
   * The one message a run cannot make progress without.
   *
   * Painted if you are there, and announced by the running bar if you are not —
   * a run blocked on a question in a conversation you have switched away from
   * would otherwise sit there until you happened to come back, looking from the
   * page like the agent had hung.
   */
  landed(msg.runId, () => patchAgent(turn.id), true);
  emit(EVENTS.RUNS_CHANGED);
}

function onAgentDone(msg) {
  const turn = requestTurn(msg.runId);
  if (!turn?.agent) return;
  turn.agent.answer = msg.answer;
  turn.agent.running = false;
  turn.agent.endedAt = Date.now();
  turn.agent.phase = null;
  landed(msg.runId, () => patchAgent(turn.id), true);
}

function onAgentError(msg) {
  // A run that never started has no matching turn yet, so fall back to the
  // newest one in the conversation that started it rather than dropping the
  // only explanation on the floor.
  const owner = sessionOf(msg.runId) || state.session;
  const turn = requestTurn(msg.runId) || owner?.turns[owner.turns.length - 1];
  if (!turn?.agent) {
    if (isVisible(msg.runId)) setHint(msg.error, 'error');
    return;
  }
  turn.agent.error = msg.error;
  turn.agent.endedAt = Date.now();
  turn.agent.phase = null;
  turn.agent.running = false;
  landed(msg.runId, () => patchAgent(turn.id), true);
}

function onAgentFinished(msg) {
  const turn = requestTurn(msg.runId);
  const visible = isVisible(msg.runId);

  if (turn?.agent) {
    turn.agent.running = false;
    turn.agent.pendingConfirm = null;
    if (visible) patchAgent(turn.id);
  }

  /**
   * The run is over, so now it pays — once, for everything it did.
   *
   * Deliberately not awaited. The answer is already on screen and the composer
   * is about to be released; making either wait on a wallet prompt and a chain
   * round trip would hold a finished run open for the length of a payment. The
   * receipt appears under the answer when it settles, and if it never settles
   * the answer is unaffected.
   *
   * Billed against the session that OWNS the run, not the one on screen — the
   * panel follows tabs, and a run can finish while you are looking elsewhere.
   */
  void settleRun(msg.runId, sessionOf(msg.runId) ?? state.session?.id ?? null);

  // Dropped BEFORE the composer is re-read, or `syncComposer` still sees this
  // run as live and leaves the Stop button up on a run that has ended.
  forgetRequest(msg.runId);

  if (visible) {
    setHint('');
    saveThread();
  } else {
    // The run's own conversation is filed; the one you are looking at is left
    // exactly as it is, including whatever you were part way through typing.
    persistSessions();
  }

  syncComposer();
}

/**
 * Something arrived from a page — a right-click, or text you highlighted.
 *
 * A selection becomes an attachment and nothing else: it is context for the
 * question you are about to type, and putting it in the composer instead would
 * overwrite whatever you had already written there.
 */
function onHandoff(handoff) {
  if (!handoff) return;

  if (handoff.type === 'PICKED') {
    onPicked(handoff);
    els.input.focus();
    return;
  }

  // "Ask about this page" — the page is already the context, so there is
  // nothing to attach; just put the caret where the question goes.
  setHint('Ask about this page.');
  els.input.focus();
}

function onPicked(msg) {
  if (msg.ok) {
    state.picked = {
      label: msg.label,
      text: msg.text,
      url: msg.url,
      title: msg.title,
      fromSelection: Boolean(msg.fromSelection)
    };
    // A selection you made in passing should not shout: the chip is the
    // notification, and a hint that says the same thing steals a line from the
    // one the composer actually needs.
    if (!msg.fromSelection) setHint(`Using “${msg.label}” from ${msg.title || 'the page'}.`);
    renderAttachmentChips();
  } else if (!msg.cancelled) {
    setHint(msg.error || 'Could not pick from the page.', 'error');
  } else {
    setHint('');
  }
}

function onPickedImage(msg) {
  if (msg.ok) {
    // One picture per question: the composer pastes it into the provider's own
    // input, and every provider we drive accepts exactly one attachment there.
    state.pickedImage = {
      dataUrl: msg.image,
      width: msg.width,
      height: msg.height,
      url: msg.url,
      title: msg.title
    };
    setHint(`Attached a ${msg.width}×${msg.height} shot of ${msg.title || 'the page'}.`);
    renderAttachmentChips();
  } else if (!msg.cancelled) {
    setHint(msg.error || 'Could not photograph that part of the page.', 'error');
  } else {
    setHint('');
  }
}
