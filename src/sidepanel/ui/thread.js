import { els, make } from '../core/dom.js';
import { state } from '../core/state.js';
import { send } from '../core/port.js';
import { icon } from '../lib/icons.js';
import { renderMarkdown } from '../lib/markdown.js';
import { emit, EVENTS } from '../core/bus.js';
import { agentMessage } from './agent.js';
import { greeting } from './greeting.js';
import { pinnedToBottom, stickToBottom, syncScrollState } from './scroll.js';

/**
 * Which messages have already been on screen, so a repaint does not re-animate.
 *
 * Keyed per answer rather than per turn: in compare mode three providers fill
 * one turn at their own pace, and the second to arrive is as new as the first.
 * Reset when the session changes — reopening a conversation from history
 * repaints ten old messages at once, and animating those says "these just
 * happened" about a chat from last week.
 */
const painted = new Set();
let paintedSession = null;

/** True the first time this key is asked about. Records it either way. */
function firstSight(key) {
  if (painted.has(key)) return false;
  painted.add(key);
  return true;
}

export function renderThread() {
  els.convoTitle.textContent = state.session?.title || 'New chat';
  els.thread.replaceChildren();

  const visible = state.turns.filter((turn) =>
    state.compare ? true : turn.providerIds.includes(state.active)
  );

  // A different session (or the first paint of this one) is history, not news.
  const sessionId = state.session?.id ?? null;
  const restoring = sessionId !== paintedSession;
  if (restoring) {
    painted.clear();
    paintedSession = sessionId;
  }
  const isNew = (key) => firstSight(key) && !restoring;

  if (!visible.length) {
    els.thread.append(greeting());
    return;
  }

  for (const turn of visible) {
    els.thread.append(userMessage(turn, isNew(`${turn.id}:q`)));

    if (turn.agent) {
      els.thread.append(agentMessage(turn));
      continue;
    }

    const shown = state.compare
      ? turn.providerIds
      : turn.providerIds.filter((id) => id === state.active);

    for (const providerId of shown) {
      const answer = turn.answers[providerId];
      if (!answer) continue;
      els.thread.append(
        assistantMessage(turn, providerId, answer, isNew(`${turn.id}:${providerId}`))
      );
    }
  }

  stickToBottom();
}

/**
 * Repaint only the affected answer when a delta lands, so streaming does not
 * blow away scroll position or the rest of the thread.
 */
export function patchAnswer(turnId, providerId) {
  const turn = state.turns.find((t) => t.id === turnId);
  if (!turn) return;
  const answer = turn.answers[providerId];
  if (!answer) return;

  if (!state.compare && !turn.providerIds.includes(state.active)) return;
  if (!state.compare && providerId !== state.active) return;

  const existing = els.thread.querySelector(
    `.msg.assistant[data-turn="${turnId}"][data-provider="${providerId}"]`
  );

  const pinned = pinnedToBottom();

  if (!existing) {
    renderThread();
    return;
  }

  // Never `.enter` here: this node is a redraw of one already on screen, and a
  // streamed reply comes through this path once per delta.
  existing.replaceWith(assistantMessage(turn, providerId, answer));
  if (pinned) stickToBottom();
  else syncScrollState();
}

function userMessage(turn, entering = false) {
  const el = make('div', `msg user${entering ? ' enter' : ''}`);

  /**
   * A skill turn shows the command, not the paragraph behind it.
   *
   * `turn.question` is what was sent and stays that way — the thread must not
   * claim a shorter question than the one that was answered — but repeating a
   * preset paragraph in every bubble buries the conversation in boilerplate.
   * The full text is one hover away.
   */
  const body = make('div', 'body');
  if (turn.skill) {
    body.title = turn.question;
    body.append(make('span', 'msg-skill', `/${turn.skill.slug}`));
    if (turn.typed) body.append(document.createTextNode(' ' + turn.typed));
    else body.append(document.createTextNode(' ' + turn.skill.title.toLowerCase()));
  } else {
    body.textContent = turn.question;
  }
  el.append(body);

  const attachments = attachmentChips(turn);
  if (attachments) el.append(attachments);

  if (turn.contextTitle) {
    const meta = make('div', 'status', `📄 ${turn.contextTitle}`);
    meta.style.alignSelf = 'flex-end';
    el.append(meta);
  }
  return el;
}

/**
 * Everything that went with a sent message, one chip each.
 *
 * All of them, not just the uploaded one: a question sent with a CV and two
 * notes files showed a single chip and read as a question sent with a CV. They
 * are listed in the order they were added to the prompt.
 *
 * Only the upload carries a state, and it carries three — `sending` while the
 * adapter is handing it over, `sent` once the provider has it, `failed` when no
 * route worked — because it is the only one that can silently not arrive. A
 * text file is inlined in the prompt itself, so if the question went, it went.
 */
function attachmentChips(turn) {
  const items = [];

  for (const name of turn.attachedFiles || []) {
    items.push({ name, state: 'sent', label: 'in the prompt', glyph: 'file' });
  }

  if (turn.attachedPick) {
    items.push({
      name: turn.attachedPick,
      state: 'sent',
      label: 'in the prompt',
      glyph: 'crosshair'
    });
  }

  if (turn.upload) {
    const state = turn.upload.state || 'sending';
    items.push({
      name: turn.upload.name,
      state,
      glyph: 'folder',
      label:
        state === 'failed' ? 'not delivered' : state === 'sent' ? 'attached' : 'attaching…',
      title:
        state === 'failed'
          ? 'The provider would not take this file, so the answer was written without it.'
          : `${turn.upload.name} was uploaded to ${
              state === 'sent' ? 'the provider' : 'the provider…'
            } with this message.`
    });
  }

  if (!items.length) return null;

  const row = make('div', 'msg-attach-row');
  for (const item of items) {
    const chip = make('div', `msg-attach ${item.state}`);
    chip.innerHTML = icon(item.glyph, 13);
    chip.append(make('span', 'msg-attach-name', item.name));
    chip.append(make('span', 'msg-attach-state', item.label));
    chip.title = item.title || `${item.name} was sent with this message.`;
    row.append(chip);
  }
  return row;
}

/**
 * The three stages a question actually goes through, in order.
 *
 * These are not decoration. `connecting` is posted when the request starts,
 * `ready` when the provider window is open and the adapter is loaded in the
 * page, and `submitted` by the adapter itself once it has PROVED the question
 * was delivered — see the delivery check in `adapters/adapter.js`, which is
 * deliberately not "we clicked send". So a run parked on stage one is a window
 * that will not open, and one parked on stage three is a provider sitting on
 * the question: two different problems that used to look like the same spinner.
 */
const STAGES = [
  { state: 'connecting', doing: 'Opening the provider…' },
  { state: 'ready', doing: 'Sending your question…' },
  { state: 'submitted', doing: 'Waiting for the reply…' }
];

const STATUS_LABEL = {
  connecting: STAGES[0].doing,
  ready: STAGES[1].doing,
  submitted: STAGES[2].doing,
  streaming: '',
  done: '',
  cancelled: 'Stopped.',
  error: '',
  need_login: ''
};

const PENDING = ['connecting', 'ready', 'submitted', 'streaming'];

/**
 * How long each unanswered question has been waiting.
 *
 * A reply that is merely slow and one that is never coming look identical from
 * the panel, and this transport is genuinely slow: a hidden provider tab, a
 * cold thread and a long prompt regularly add up to forty seconds before the
 * first token. A counter is the difference between "it is working" and "it is
 * stuck" — and it is why the wait state says which stage it is at rather than
 * showing three dots that mean nothing in particular.
 */
const waitingSince = new Map();
/** Only after this does a number help rather than fidget. */
const SHOW_ELAPSED_AFTER = 3;
let ticker = null;

function waitedSeconds(key) {
  if (!waitingSince.has(key)) waitingSince.set(key, Date.now());
  return Math.floor((Date.now() - waitingSince.get(key)) / 1000);
}

const elapsedText = (seconds) =>
  seconds < SHOW_ELAPSED_AFTER
    ? ''
    : seconds < 60
      ? `${seconds}s`
      : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;

/**
 * One second tick, shared by every waiting answer on screen and stopped the
 * moment none is left — an interval that outlives what it updates is the panel
 * equivalent of the worker's fast `setInterval`, and just as invisible.
 */
function startTicker() {
  if (ticker) return;
  ticker = setInterval(() => {
    const nodes = els.thread.querySelectorAll('.thinking-elapsed');
    if (!nodes.length) {
      clearInterval(ticker);
      ticker = null;
      return;
    }
    for (const node of nodes) node.textContent = elapsedText(waitedSeconds(node.dataset.key));
  }, 1000);
}

/**
 * The wait, before a single character has arrived.
 *
 * Skeleton lines rather than a spinner: they occupy the shape the answer is
 * about to take, so when the text lands nothing below it jumps. The label above
 * them names the stage — "Opening the provider…" and "Waiting for a reply…" are
 * different problems when they go on too long, and only one of them is worth
 * pressing stop over.
 */
function thinking(answer, key) {
  const el = make('div', 'thinking');

  /**
   * A segment per stage, filled as each one is passed.
   *
   * Three words and a bar rather than three lines of text: the stage that
   * matters is the one it is on, the ones behind it only have to show that
   * progress is being made at all, and the whole thing has to fit above a
   * reply in a 400px panel.
   */
  const at = Math.max(0, STAGES.findIndex((stage) => stage.state === answer.state));
  const track = make('div', 'stage-track');
  track.setAttribute('aria-hidden', 'true');
  STAGES.forEach((_, index) => {
    const seg = make('i');
    if (index < at) seg.className = 'done';
    else if (index === at) seg.className = 'active';
    track.append(seg);
  });

  const label = make('div', 'thinking-label');
  label.append(make('span', '', STATUS_LABEL[answer.state] || 'Working…'));

  const elapsed = make('span', 'thinking-elapsed');
  elapsed.dataset.key = key;
  elapsed.textContent = elapsedText(waitedSeconds(key));
  label.append(elapsed);

  const bars = make('div', 'skeleton');
  bars.append(make('i'), make('i'), make('i'));

  el.append(track, label, bars);
  startTicker();
  return el;
}

function assistantMessage(turn, providerId, answer, entering = false) {
  const provider = state.byId[providerId] || { name: providerId, color: '#888' };

  const el = make('div', 'msg assistant');
  if (entering) el.classList.add('enter');
  // Something is still coming: the head dot pulses for as long as this is set,
  // which is the only sign of life once the skeleton gives way to text.
  if (PENDING.includes(answer.state)) el.classList.add('live');
  el.dataset.turn = turn.id;
  el.dataset.provider = providerId;

  const head = make('div', 'msg-head');
  const dot = make('span', 'dot');
  dot.style.background = provider.color;
  head.append(dot, make('span', '', provider.name));
  el.append(head);

  if (answer.text) {
    const body = make('div', 'body');
    body.innerHTML = renderMarkdown(answer.text);
    if (answer.state === 'streaming') {
      // Inside the last block, not after it: markdown wraps everything in
      // paragraphs and list items, so a caret appended to `.body` lands on a
      // line of its own under the text it is supposed to be writing. A code
      // card is a wrapper around a `pre`, so go one level further in — the
      // caret belongs where the next character will appear, not under the box.
      const tail = body.lastElementChild || body;
      const target = tail.classList?.contains('code-block')
        ? tail.querySelector('code') || tail
        : tail;
      target.append(make('span', 'caret-cursor'));
    }
    el.append(body);
  }

  if (answer.text && answer.state !== 'streaming') {
    el.append(replyActions(turn, answer));
  }

  const key = `${turn.id}:${providerId}`;
  // Nothing is waiting on this one any more, so the next question through the
  // same provider starts its clock from zero rather than from this one's.
  if (!PENDING.includes(answer.state)) waitingSince.delete(key);

  if (answer.state === 'error' || answer.state === 'need_login') {
    el.append(...failure(provider, providerId, answer));
  } else if (!answer.text && PENDING.includes(answer.state)) {
    el.append(thinking(answer, key));
  } else if (!answer.text && STATUS_LABEL[answer.state]) {
    el.append(make('div', 'status', STATUS_LABEL[answer.state]));
  }

  if (answer.truncated) {
    el.append(make('div', 'status warn', 'Response cut off at the timeout.'));
  }

  // Above the answer would be better placed but worse behaved: this is patched
  // in on every delta, and a line that shifts the text down as it streams is
  // read as the reply jumping.
  if (answer.notice) el.append(make('div', 'status warn', answer.notice));

  return el;
}

/** Action row under a finished reply, the way the native panels do it. */
function replyActions(turn, answer) {
  const actions = make('div', 'msg-actions');

  const copy = make('button');
  copy.title = 'Copy';
  copy.innerHTML = icon('copy', 15);
  copy.addEventListener('click', async () => {
    await navigator.clipboard.writeText(answer.text);
    copy.innerHTML = icon('check', 15);
    setTimeout(() => (copy.innerHTML = icon('copy', 15)), 1200);
  });

  const retry = make('button');
  retry.title = 'Ask again';
  retry.innerHTML = icon('refresh', 15);
  retry.addEventListener('click', () => emit(EVENTS.ASK, turn.question));

  actions.append(copy, retry);
  return actions;
}

function failure(provider, providerId, answer) {
  const parts = [];

  parts.push(
    make(
      'div',
      'status error',
      answer.state === 'need_login'
        ? `Not signed in to ${provider.name}.`
        : answer.error || 'Something went wrong.'
    )
  );

  if (answer.state !== 'need_login') return parts;

  const cta = make('button', 'login-cta', `Sign in to ${provider.name}`);
  cta.addEventListener('click', () => send({ type: 'OPEN_LOGIN', providerId }));
  parts.push(cta);

  // In background-frame mode, being signed in is not enough on its own: Lax
  // session cookies are not sent into a cross-site frame. Say so, rather than
  // letting the user log in over and over to no effect.
  const embedded = (state.settings?.providerMode || 'embedded') === 'embedded';
  if (embedded && !state.settings?.relaxCookies) {
    parts.push(
      make(
        'div',
        'status warn',
        'Already signed in? Background frames need "Relax session cookies" turned ' +
          'on in Settings, or switch hosting to "Minimized window".'
      )
    );
  }

  return parts;
}

/** Swap one node for a fresh render without losing the reader's place. */
export function replaceKeepingScroll(existing, replacement) {
  const pinned = pinnedToBottom();
  existing.replaceWith(replacement);
  if (pinned) stickToBottom();
  else syncScrollState();
}
