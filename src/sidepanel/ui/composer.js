import { els } from '../core/dom.js';
import { state, uid } from '../core/state.js';
import { send } from '../core/port.js';
import { saveThread } from '../core/sessions.js';
import {
  trackRequest,
  forgetRequest,
  liveIn,
  requestTurn,
  markStopping,
  isStopping,
  sessionOf
} from '../core/runs.js';
import { setHint } from './hint.js';
import { targetProviders, setProviderBusy } from './providers.js';
import { renderThread } from './thread.js';
import { clearAttachments } from './attachments.js';
import { closeSkillFiles } from './skill-files.js';
import { expandTokens, paintInk } from './composer-ink.js';
import { chargeForSkill } from '../payments/x402.js';
import { settleRun } from '../payments/run-billing.js';

/**
 * The composer: sizing the input, and turning what is in it into a question.
 */

/**
 * One line when empty, growing to a cap.
 *
 * Collapsing to 0 first is the part that matters: measuring `scrollHeight`
 * while the element still carries its previous inline height can report that
 * old height back, and the box then never shrinks again. The explicit floor
 * means even a bad measurement cannot leave the composer standing tall.
 */
const INPUT_MIN_HEIGHT = 30;
const INPUT_MAX_HEIGHT = 120;

export function autosize() {
  const el = els.input;
  el.style.height = '0px';
  const needed = el.scrollHeight;
  el.style.height = Math.max(INPUT_MIN_HEIGHT, Math.min(needed, INPUT_MAX_HEIGHT)) + 'px';
  el.style.overflowY = needed > INPUT_MAX_HEIGHT ? 'auto' : 'hidden';
}

export function setBusy(busy, stopping = false) {
  els.send.hidden = busy;
  els.stop.hidden = !busy;
  /**
   * Stop pressed, worker not finished — a real state, and a different one.
   *
   * Left enabled on purpose. The grace timer in `stopEverything` is the escape
   * from a worker that never answers, and a second press is the faster one; a
   * disabled button in a panel that is not letting go reads as a hang.
   */
  els.stop.classList.toggle('stopping', busy && stopping);
  els.stop.title = busy && stopping ? 'Stopping — press again to let go' : 'Stop';
  // Left editable on purpose: the next question can be typed while this one runs.
  els.input.disabled = false;

  /**
   * A line across the top of the composer for as long as anything is out.
   *
   * The answer it belongs to is often scrolled off, or is one of three in
   * compare mode, so "is it still going?" cannot be answered by looking at the
   * thread. This is the one indicator that is always in view, right where the
   * stop button is.
   */
  els.composer.classList.toggle('busy', busy);
  if (!busy) setAskProgress(null);
}

/**
 * Re-derive the composer from the conversation in front of you.
 *
 * `setBusy` is a switch; this is the single decision that flips it. The panel
 * follows you between tabs now, and a Send button belongs to a CHAT rather than
 * to the panel — so the answer is always "does the conversation on screen have
 * anything of its own in flight", and never "is anything running anywhere".
 *
 * `state.busyReq` and `state.agentRunId` survive as what they always meant to
 * be: what is running in the chat you are looking at, which is what Stop acts
 * on. `core/runs.js` holds the truth for every conversation, including the ones
 * that are not on screen.
 */
export function syncComposer() {
  const { chat, agent } = liveIn(state.session?.id ?? null);
  state.busyReq = chat;
  state.agentRunId = agent;
  setBusy(Boolean(chat || agent), Boolean(agent && isStopping(agent)));
}

/**
 * Turn the line determinate for a deep read.
 *
 * A deep read is six provider round trips for one question — a minute or more
 * of the panel looking identical to a hung one. `null` puts the line back to
 * its indeterminate sweep, which is the honest shape when there is no count.
 */
export function setAskProgress(fraction) {
  els.composer.classList.toggle('measured', fraction != null);
  els.composer.style.setProperty('--progress', fraction == null ? '0' : String(fraction));
}

export function ask(question) {
  const skill = state.skill;

  /**
   * The badges are spelled out before anything leaves the panel.
   *
   * `@[Job ad]` and `/summarise` are how the composer draws an attachment, not
   * something a provider has ever seen — sent raw, the answer talks about the
   * brackets. `expandTokens` turns the mention into the tab's name in quotes,
   * which is the name the model will also find in the TABS list an agent run is
   * given, and removes the command whose body is prepended below.
   */
  const typed = expandTokens(question);

  // A skill on its own is a complete question — that is what makes it worth
  // keeping. Your words go after it, as the specific on top of the general.
  const text = skill ? [skill.body, typed].filter(Boolean).join('\n\n') : typed;
  if (!text) return;

  const providerIds = targetProviders();
  if (!providerIds.length) {
    setHint('No provider is enabled — open Settings to turn one on.', 'error');
    return;
  }

  const turn = {
    id: uid('t'),
    // What was actually sent. The thread must not claim a shorter question was
    // asked than the one the provider answered.
    question: text,
    // …but it is rendered as the command plus your words, because a paragraph
    // of boilerplate repeated in every bubble buries the conversation.
    skill: skill ? { slug: skill.slug, title: skill.title } : null,
    typed,
    contextTitle: null,
    providerIds,
    /**
     * Everything that went with THIS message, kept on the turn so the thread
     * can show it. The composer's row of cards is gone the moment you send, and
     * "did my CV actually go with that question" is not answerable afterwards
     * from anything else on screen.
     *
     * Two lists because they travel two different roads and can fail
     * separately: a text file is inlined in the prompt and therefore always
     * arrives, while an upload is handed to the provider's own uploader and
     * might not. Showing only the second one made a question sent with a CV and
     * three files look like a question sent with a CV.
     */
    upload: state.upload
      ? { name: state.upload.name, size: state.upload.size, state: 'sending' }
      : null,
    attachedFiles: state.files.map((f) => f.name),
    attachedPick: state.picked
      ? state.picked.label || state.picked.title || 'Selected text'
      : state.pickedImage
        ? 'Selected region'
        : null,
    answers: {}
  };

  // Agent mode is a per-question decision, never a background state: only a
  // question asked with the toggle lit is allowed to act on the page. Every
  // other question stays an ordinary chat about the page's content and forms.
  if (state.agentMode) {
    turn.agent = { runId: turn.id, steps: [], running: true, answer: '', error: '' };
  } else {
    for (const id of providerIds) turn.answers[id] = { state: 'connecting', text: '' };
  }

  state.turns.push(turn);

  /**
   * A skill is an agent someone wrote and published, so using one pays them.
   *
   * Deliberately not awaited and deliberately after the turn exists: the
   * question is already going out, and a wallet popup in front of it would mean
   * a panel that cannot answer until a payment clears. A skill nobody has
   * registered is free, an unreachable marketplace is free, and a declined
   * signature is free — see the reasons in payments/x402.js. None of them can
   * stop the question.
   */
  if (skill) chargeForSkill(skill, state.session?.id ?? null);
  // Recorded against the conversation it was asked from, before anything is
  // sent. Every reply that comes back carries this id, which is how it finds
  // its way home even if you have moved to another tab in the meantime.
  trackRequest(turn.id, state.session?.id ?? null, turn.agent ? 'agent' : 'chat');
  renderThread();
  syncComposer();
  setHint('');

  if (turn.agent) startAgentRun(turn, text, providerIds);
  else askProviders(turn, text, providerIds);

  els.input.value = '';
  clearAttachments();
  /**
   * A file picker still open belongs to a question that has gone.
   *
   * Enter sends whatever is in the box, and the sheet does not own that key —
   * so `/resume` plus a sentence can be sent while the list of résumés is still
   * up. Left there, the next thing you ticked would ride on your NEXT question,
   * which reads exactly like the file having gone with the last one.
   */
  closeSkillFiles();
  // The badges went with the text. Repainting an empty layer is what stops the
  // last question's pills hanging in the box behind the placeholder.
  paintInk();
  autosize();
}

function startAgentRun(turn, text, providerIds) {
  send({
    type: 'AGENT_RUN',
    runId: turn.id,
    task: text,
    providerId: providerIds[0],
    /**
     * Which panel chat this run belongs to, so consecutive runs can share one
     * provider thread instead of opening a new one each time.
     *
     * Without it the worker cannot tell "the next task in the conversation you
     * are looking at" from "a brand new chat" — and defaulting to the second
     * left every run starting from nothing, so a follow-up like "now publish
     * it" arrived at a model with no memory of what it had just built.
     */
    sessionId: state.session?.id ?? null,
    /**
     * The tab this conversation belongs to, unless one was picked explicitly.
     *
     * Sending null here used to mean "whatever tab is in front when the run
     * starts" — which is a different tab from the one you were reading the
     * moment you switch away while it thinks. A chat is about a page now, so
     * the run works on that page: this tab, plus any tab it opens itself.
     */
    tabId: state.contextTabs[0]?.id ?? state.tabId ?? null,
    /**
     * Every tab you badged, not just the first.
     *
     * "Take the details from @[Job ad], check them against @[My CV] and fill in
     * @[Application]" is one task across three pages, and the run used to get
     * one of them: `tabId` was `contextTabs[0]` and the rest arrived only as
     * page text, which the model could read and never act on. So it would
     * describe the form it had been asked to fill in.
     *
     * The first is still where the run starts — it is the page the conversation
     * belongs to unless you named another — and the worker resolves the rest
     * into a closed working set it may switch between. See `resolveWorkingTabs`.
     */
    tabIds: state.contextTabs.map((t) => t.id),
    policy: state.agentPolicy,
    // "Fill this application in from my CV" is the whole reason to attach one
    // to an agent run, and it used to go nowhere: the chat path uploaded it,
    // this path dropped it, and the run ended saying it would not invent the
    // details it had been given.
    upload: state.upload
      ? { dataUrl: state.upload.dataUrl, name: state.upload.name, type: state.upload.type }
      : null
  });
}

function askProviders(turn, text, providerIds) {
  providerIds.forEach((id) => setProviderBusy(id, true));
  send({
    type: 'ASK',
    reqId: turn.id,
    providerIds,
    // The chat this question belongs to. The worker files the provider thread
    // under it, so one panel chat keeps one conversation per provider however
    // often you switch tabs — see state/conversations.js.
    sessionId: state.session?.id ?? null,
    question: text,
    includeContext: els.ctxOn.checked,
    contextTabIds: state.contextTabs.map((t) => t.id),
    files: state.files.concat(state.workspace?.files || []),
    picked: state.picked,
    // One attachment slot, because a provider composer has one. An uploaded
    // file wins over a dragged crop: you went and found it.
    image: state.upload
      ? { dataUrl: state.upload.dataUrl, name: state.upload.name, type: state.upload.type }
      : state.pickedImage?.dataUrl || null,
    uploadName: state.upload?.name || null
  });
}

/**
 * Release the composer once every provider on this turn has stopped.
 *
 * Looked up through `requestTurn` rather than in `state.turns`: an answer can
 * settle for a conversation you have since switched away from, and finding
 * nothing there used to leave that chat's request marked live forever — so
 * coming back to it showed a Stop button for a question that had finished.
 */
export function finishIfIdle(turnId) {
  const turn = requestTurn(turnId);
  if (!turn) return;

  const pending = Object.values(turn.answers).some((a) =>
    ['connecting', 'ready', 'submitted', 'streaming'].includes(a.state)
  );
  if (pending) return;

  /**
   * Every provider has answered, so now the question pays for itself.
   *
   * Here rather than in `onStream` because this is the only place that knows
   * a REQUEST is finished rather than one of its answers: compare mode fans
   * one question out to four providers, each of which settles separately,
   * and four wallet prompts for one question is not a thing anybody approves.
   * `noteAnswer` has filed a line per provider by now; this signs them once.
   *
   * Read the owning session BEFORE `forgetRequest`, which is what knows it —
   * and never `state.session`, because the panel follows tabs and an answer
   * routinely lands for a conversation that is no longer on screen.
   *
   * Not awaited, for the reason written across this whole layer: a payment
   * may never hold up an answer, and the answer is already rendered.
   */
  /**
   * `.id`, and the missing `.id` wrote the whole conversation to a chain.
   *
   * `sessionOf` returns the session OBJECT — its own comment says so, because
   * callers mutate what it returns. Passed here as `sessionId` it was
   * serialised into the on-chain note, so the wallet asked the user to approve
   * a payment whose note carried their question, the provider's answer and the
   * conversation URL. Permanent, public, and nothing in the panel would ever
   * have shown it — the only reason it was caught is that Lute prints the note
   * it is about to sign.
   */
  void settleRun(turnId, sessionOf(turnId)?.id ?? state.session?.id ?? null);

  forgetRequest(turnId);
  turn.providerIds.forEach((id) => setProviderBusy(id, false));
  syncComposer();
  saveThread();
}

/**
 * How long the panel waits for the worker to confirm a stop before letting go
 * of the composer itself. Comfortably longer than a run takes to unwind — the
 * step in flight has to end and `pace.js` can hold a retry for a few seconds —
 * and short enough not to read as a hang.
 */
const STOP_GRACE_MS = 10000;

/**
 * The ■ button: stop what is running in THIS conversation.
 *
 * Scoped deliberately. The button sits under one chat's composer and its label
 * is that chat's state, so stopping a run happening in another conversation
 * from here would be a click with no visible cause and no visible effect —
 * whereas the panel's own history is one click away if that is what you meant.
 */
export function stopEverything() {
  if (state.agentRunId) {
    const runId = state.agentRunId;

    /**
     * Asked once already and it has not landed. Let go locally.
     *
     * The worker is the authority on whether a run is over and this is the
     * panel overruling it, so it is deliberately the SECOND press rather than
     * the first: a run that is unwinding normally clears in a few seconds and
     * the honest thing to show meanwhile is that it is stopping. What this
     * exists for is the worker that never answers — killed mid-run, or a loop
     * parked somewhere `signal.cancelled` is not tested — where the alternative
     * is a composer locked until the panel is reloaded.
     */
    if (isStopping(runId)) {
      forgetRequest(runId);
      syncComposer();
      return;
    }

    send({ type: 'AGENT_STOP', runId });
    /**
     * NOT `forgetRequest` — see `markStopping`. The run really is still going
     * for a few seconds after this, and saying otherwise is what produced the
     * "already going / Stop it first" dead end.
     */
    markStopping(runId);

    // The same escape as the second press, for whoever presses once and waits.
    setTimeout(() => {
      if (!isStopping(runId)) return;
      forgetRequest(runId);
      syncComposer();
    }, STOP_GRACE_MS);
  } else if (state.busyReq) {
    send({ type: 'CANCEL', reqId: state.busyReq });
    forgetRequest(state.busyReq);
  }
  syncComposer();
}
