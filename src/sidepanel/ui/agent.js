import { els, make } from '../core/dom.js';
import { state } from '../core/state.js';
import { send } from '../core/port.js';
import { renderMarkdown } from '../lib/markdown.js';
import { icon } from '../lib/icons.js';
import { emit, EVENTS } from '../core/bus.js';
import { pinnedToBottom, stickToBottom, syncScrollState } from './scroll.js';

/**
 * An agent turn renders as a live timeline rather than a single reply: the
 * whole point is that you can watch what it is about to touch and stop it.
 */
export function agentMessage(turn) {
  const run = turn.agent;

  const el = make('div', 'msg assistant agent');
  el.dataset.turn = turn.id;

  const count = run.steps.length;
  const plural = count === 1 ? 'step' : 'steps';

  const head = make('div', 'msg-head');
  const dot = make('span', 'dot');
  dot.style.background = state.byId[turn.providerIds[0]]?.color || 'var(--accent)';

  if (run.running) {
    el.classList.add('running');
    // Not 'live': thread.css uses that for a streaming assistant message and
    // styles `.msg-head .dot` at a specificity nothing head-scoped can beat.
    head.classList.add('working');
    // The ellipsis is its own element so it can animate without the label
    // reflowing — three dots appearing one at a time inside a text node would
    // shift the text beside them on every frame.
    head.append(dot, make('span', '', 'Agent working'), make('span', 'ellipsis'));
  } else if (run.error) {
    head.append(dot, make('span', '', `Agent stopped after ${count} ${plural}`));
  } else {
    head.classList.add('done');
    /**
     * The finish plays once, on the turn it actually finishes.
     *
     * `patchAgent` rebuilds this node on every repaint and a reopened session
     * rebuilds it again — so an unconditional animation would replay the tick
     * every time the panel redrew, and would celebrate a week-old run on
     * reopening it. Same rule as the step timeline.
     */
    if (!settled.has(turn.id)) {
      settled.add(turn.id);
      head.classList.add('just-done');
    }
    head.append(make('span', 'tick'), make('span', '', `Agent finished · ${count} ${plural}`));

    // The whole run, first step to last. Worth its own number: "12 steps" says
    // nothing about whether that was twenty seconds or four minutes, and four
    // minutes is the thing you would change the task to avoid.
    const total = run.endedAt && run.steps[0]?.at ? run.endedAt - run.steps[0].at : 0;
    if (total > 0) head.append(make('span', 'agent-total', humanMs(total)));
  }

  el.append(head);

  /**
   * Once the run is over the steps are working-out, not the result. They fold
   * away so the answer is what you actually land on — but they stay one click
   * from view, because "what did it click on my behalf?" is a fair question to
   * ask afterwards.
   */
  const finished = !run.running && run.steps.length;
  const shell = finished ? document.createElement('details') : el;
  if (finished) {
    shell.append(
      make('summary', 'agent-steps-toggle', `Show what it did (${count} ${plural})`)
    );
    el.append(shell);
  }

  if (run.steps.length) {
    shell.append(stepList(run.steps, turn.id, run.running, run.phase, run.via, run.endedAt));
  }
  if (run.pendingConfirm) el.append(approvalGate(turn, run.pendingConfirm));

  if (run.answer) {
    const body = make('div', 'body');
    body.innerHTML = renderMarkdown(run.answer);
    el.append(body);
  }

  if (run.error) el.append(make('div', 'status error', run.error));

  return el;
}

/**
 * Which steps have already been on screen, per run.
 *
 * The same asymmetry the thread runs on: `patchAgent` rebuilds this list on
 * every emitted step, so an entry animation on `li` itself would restart every
 * animation in the timeline several times a second — the whole list would
 * strobe — and reopening a finished run would replay a week-old task as if it
 * were happening now. Only a step index this run has not painted before gets
 * `.enter`.
 */
const painted = new Map();

/** Runs whose finish animation has already played. See `just-done`. */
const settled = new Set();

function seenSteps(turnId) {
  let set = painted.get(turnId);
  if (!set) painted.set(turnId, (set = new Set()));
  // A run is bounded by MAX_STEPS, so this cannot grow without limit; the map
  // is keyed on turn id and a session holds few of those.
  return set;
}

/**
 * The state a step is in, which is what its marker colour means.
 *
 * Four are worth distinguishing and the old timeline showed one: everything was
 * a grey dot. A step that FAILED and a step that worked looked identical, which
 * is the thing you most want to spot when scanning what an agent did to your
 * page on your behalf.
 */
/**
 * One icon per kind of action, so a run can be SCANNED, not read.
 *
 * Six "Type…" rows and one "Go to…" row are the same grey dot in a list and
 * two obviously different shapes with these. The kind comes from the worker —
 * deriving it from the description text with a regex would break the moment a
 * description is reworded, and the symptom would be the UI quietly losing
 * track of what the agent did.
 *
 * These are names in `lib/icons.js`, NOT Unicode characters. The first version
 * used ·, ▣, ◇ and friends, and a column of them looked like clip-art: every
 * one of those glyphs comes from a different part of the font with its own
 * optical size, weight and baseline, so nothing lined up and no two were the
 * same visual weight. One 24×24 grid at one stroke width is what makes a set
 * read as a set.
 */
const GLYPH = {
  plan: 'route',
  observe: 'eye',
  screenshot: 'image',
  click: 'crosshair',
  click_at: 'crosshair',
  type: 'caret',
  select: 'chevron',
  scroll: 'scrollY',
  navigate: 'arrowRight',
  open_tab: 'newTab',
  switch_tab: 'swap',
  list_tabs: 'layers',
  use_frame: 'frame',
  back: 'arrowLeft',
  wait: 'clock',
  halted: 'ban',
  finish: 'check'
};

/** Long notes are folded. See `noteBlock`. */
const FOLD_OVER = 220;

function stateOf(step, isLast, running) {
  if (step.risk) return 'risky';
  if (/^(refused|could not|failed|no element|nothing at)/i.test(step.note || '')) return 'failed';
  if (isLast && running) return 'active';
  return 'done';
}

/**
 * Where the walking pointer was last left, per run.
 *
 * The list is rebuilt on every step, so the pointer element does not survive
 * between paints — only the *index* it had reached does. Travel is then
 * "animate from the row we remember to the row that just arrived", which
 * survives a rebuild, a fold opening, and a step whose note is four lines
 * taller than the one before it. Measuring the old element's position instead
 * would mean measuring something that no longer exists.
 */
const walked = new Map();

/**
 * How long something took, at the precision a person cares about.
 *
 * Sub-second gets one decimal because the difference between 0.3s and 0.9s is
 * the difference between "instant" and "noticeable"; past ten seconds the
 * decimal is noise on a number dominated by provider latency.
 */
function humanMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.max(1, Math.round(ms / 100)) / 10}s`;
  if (ms < 10000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  const m = Math.floor(ms / 60000);
  return `${m}m ${String(Math.round((ms % 60000) / 1000)).padStart(2, '0')}s`;
}

/**
 * The running step's clock, ticked in place.
 *
 * NOT by repainting: `patchAgent` rebuilds the whole list, which would restart
 * every entry animation and re-fire the walking pointer once a second. This
 * writes `textContent` on the one node that is counting and touches nothing
 * else. One interval for the whole panel, stopped the moment no live clock is
 * left — a fast interval that never stops is the same mistake the worker's
 * keep-alive is careful to avoid.
 */
let ticker = null;

function tick() {
  const live = document.querySelectorAll('.agent-elapsed[data-since]');
  if (!live.length) {
    clearInterval(ticker);
    ticker = null;
    return;
  }
  const now = Date.now();
  for (const node of live) node.textContent = humanMs(now - Number(node.dataset.since));
}

function startTicking() {
  if (ticker) return;
  ticker = setInterval(tick, 500);
}

/** How long the pointer takes to travel one hop, and how long it rests after. */
const TRAVEL_MS = 340;
const REST_MS = 220;

/**
 * Walk a pointer from the previous step to the one that just arrived.
 *
 * A run is a sequence of things happening in places, and a list of boxes
 * appearing does not say that — it says a list grew. Moving one object from
 * the last row to the new one is the same reason the agent draws a pointer on
 * the page rather than flashing a highlight: the eye follows an object, and
 * following it is what makes the sequence legible as movement rather than as
 * output.
 *
 * Runs after layout, from a rAF: `agentMessage` builds this list detached and
 * the caller inserts it synchronously, so by the next frame `offsetTop` is
 * real. Before that it is 0 for every row and the pointer would sit at the top
 * on every hop.
 */
function walkPointer(list, turnId, toIndex) {
  const rows = list.querySelectorAll('li');
  const target = rows[toIndex];
  if (!target) return;

  const pointer = make('span', 'agent-pointer');
  pointer.innerHTML = icon('cursor', 13);
  pointer.setAttribute('aria-hidden', 'true');
  list.append(pointer);

  const centreOf = (row) => {
    const badge = row?.querySelector('.agent-glyph');
    if (!badge) return null;
    return badge.offsetTop + badge.offsetHeight / 2;
  };

  const to = centreOf(target);
  if (to == null) return;

  const fromIndex = walked.get(turnId);
  const from = fromIndex == null ? null : centreOf(rows[fromIndex]);
  walked.set(turnId, toIndex);

  // No previous row to come from — the first step of a run. Fade in on the
  // spot rather than flying in from an edge it was never at.
  if (from == null || from === to) {
    pointer.style.transform = `translateY(${to}px)`;
    pointer.classList.add('arrive');
    return;
  }

  pointer.style.transform = `translateY(${from}px)`;
  // Force the start position to be committed, or the browser coalesces both
  // writes into one and the transition never runs.
  void pointer.offsetHeight;
  pointer.classList.add('travel');
  pointer.style.transform = `translateY(${to}px)`;

  // The press lands when it arrives, not while it is still moving.
  setTimeout(() => pointer.classList.add('arrive'), TRAVEL_MS);
}

/**
 * What each wait state means, in the user's terms.
 *
 * These are the adapter's own protocol states, and naming them matters: a run
 * parked on `submitted` is waiting for a reply that may never come, while one
 * parked on `connecting` never reached the provider at all. Told nothing, a
 * normal ten-to-forty second provider round trip looks exactly like a hang —
 * which is why people stop runs that were working.
 */
const PHASE = {
  connecting: 'Sending to the provider',
  ready: 'Provider ready — sending the message',
  submitted: 'Message delivered — waiting for the reply',
  streaming: 'Reading the reply'
};

/**
 * The one state where the two transports genuinely differ, said plainly.
 *
 * `ready` used to read "Provider window open, typing the message" whichever
 * road the turn took — and the fast road opens no window at all. So every
 * direct turn announced a popup, which is indistinguishable from one actually
 * appearing and was reported as exactly that. A window IS worth naming when
 * there is one: it is the visible, invasive half of the extension, and knowing
 * a run is on that road is what makes "why has something opened?" answerable.
 */
/**
 * `ready` covers everything between the window being usable and the send being
 * proved, and "typing the message" claimed only the middle of it.
 *
 * The state is posted the moment the adapter is in the page — before a
 * character has been inserted — and it stays up through the insert, the send
 * click and up to four seconds of proving delivery. On the window path that is
 * tens of seconds, during which the panel said the message was being typed and
 * the provider's composer, plainly visible, was empty. Reported as exactly
 * that: "it's showing like typing but nothing is getting typed."
 *
 * A label naming something the user can go and look at has to survive them
 * looking. This one names the phase instead of a keystroke.
 */
const VIA = {
  direct: "Posting straight to the provider's API — no window",
  window: 'Provider window open — handing over the message',
  frame: 'Background frame ready — handing over the message'
};

const phaseText = (phase, via) => (phase === 'ready' && VIA[via]) || PHASE[phase];


function stepList(steps, turnId, running, phase, via, endedAt) {
  const list = make('ol', 'agent-steps');
  const seen = seenSteps(turnId);

  steps.forEach((step, index) => {
    const item = document.createElement('li');
    const status = stateOf(step, index === steps.length - 1, running);
    item.classList.add(status);

    // On arrival, and only on arrival.
    if (!seen.has(index)) {
      seen.add(index);
      item.classList.add('enter');
    }

    const badge = make('span', 'agent-glyph');
    badge.setAttribute('aria-hidden', 'true');
    // `icon()` returns a self-contained <svg> string with no interpolation of
    // anything from the page, so this is markup we authored, not content.
    badge.innerHTML = icon(GLYPH[step.kind] || 'chevron', 13);

    const main = make('div', 'agent-main');
    main.append(make('div', 'agent-what', step.description));
    if (step.thought) main.append(make('div', 'agent-why', step.thought));
    if (step.note) main.append(noteBlock(step.note, step.kind));

    /**
     * How long this step took.
     *
     * A step's span is "until the next one arrived" — there is no end stamp of
     * its own, because the worker reports a step when it has finished and the
     * gap to the next report IS the work plus the provider round trip. The
     * last step of a live run counts up instead, and the last step of a
     * finished one ends at the run's end.
     */
    const next = steps[index + 1];
    const until = next?.at ?? endedAt ?? (running ? null : step.at);
    if (step.at) {
      const el = make('span', 'agent-elapsed');
      if (until == null) {
        el.dataset.since = String(step.at);
        el.textContent = humanMs(Date.now() - step.at);
        el.classList.add('counting');
      } else {
        el.textContent = humanMs(until - step.at);
      }
      item.append(el);
    }

    // Only on the step that is actually running.
    if (status === 'active' && phase && phaseText(phase, via)) {
      const live = make('div', 'agent-phase');
      live.append(
        make('span', 'agent-phase-pip'),
        make('span', 'agent-phase-text', phaseText(phase, via)),
        make('span', 'ellipsis')
      );
      main.append(live);
    }

    item.append(badge, main);
    list.append(item);
  });

  /**
   * Only while the run is live, and only if the setting is on.
   *
   * A pointer walking a finished run is animation for its own sake — there is
   * nothing happening for it to be pointing at — and it would replay every
   * time an old session was reopened.
   */
  if (running && steps.length && state.settings?.agentStepPointer !== false) {
    requestAnimationFrame(() => walkPointer(list, turnId, steps.length - 1));
  } else if (!running) {
    walked.delete(turnId);
  }

  if (list.querySelector('.agent-elapsed[data-since]')) startTicking();

  return list;
}

/**
 * The note, with any quoted value picked out.
 *
 * A step now reads `Typed "3 Years" into "Years of experience"`, and the value
 * is the part being checked — "did it put the right answer in the right box"
 * is the only question a person watching a form fill itself in is actually
 * asking. Left as flat monospace, that answer is buried in the middle of a
 * sentence at 12px.
 *
 * Built with the DOM rather than an HTML string: this text comes from a web
 * page we do not control, by way of the model, and `innerHTML` here would make
 * a field's placeholder into markup in the panel.
 */
/**
 * A note, folded if it is long enough to bury the rest of the run.
 *
 * The plan is the case that forced this: it is a dozen lines of prose, it
 * arrives as step two, and left open it pushes every actual action off the
 * bottom of a 400px panel — so the timeline you are watching is mostly a
 * paragraph you already read. Folded, the run stays scannable and the plan is
 * one click away.
 *
 * `<details>` rather than a class and a click handler: it is the element the
 * platform already made for this, so it opens from the keyboard, it is
 * announced correctly, and Ctrl+F on the page can find text inside it.
 */
function noteBlock(text, kind) {
  const body = kind === 'plan' ? planDoc(text) : noteLine(text);

  if (String(text).length <= FOLD_OVER) return body;

  const box = document.createElement('details');
  box.className = 'agent-fold';
  const head = make('summary', 'agent-fold-head');
  head.append(
    make('span', 'agent-fold-peek', String(text).slice(0, 64).replace(/\s+/g, ' ').trim() + '…'),
    make('span', 'agent-fold-more', '')
  );
  box.append(head, body);
  return box;
}

/**
 * The plan, rendered as the document it is.
 *
 * It comes back as markdown — headings, a numbered route, bold field names —
 * and shown as flat monospace it is a wall you skip. It is also the one note
 * worth reading properly, since everything after it is the model executing it.
 * Same renderer as an assistant answer, which does its own escaping.
 */
function planDoc(text) {
  const doc = make('div', 'agent-doc');
  doc.innerHTML = renderMarkdown(flatten(String(text)));
  return doc;
}

/**
 * Take the indentation out before the markdown renderer sees it.
 *
 * Four leading spaces is a code block, and a model writing a route with hanging
 * indents — which is the natural way to write one — turned every line of the
 * plan into its own grey code card. In a column this narrow those wrap a word
 * at a time, so the single most useful note in the run rendered as a vertical
 * ribbon of single words. The prompt asks for flat markdown now; this is the
 * half that does not depend on the model having complied.
 *
 * Fenced blocks are left exactly as they are — a plan quoting a snippet means
 * it, and this must not reach inside a fence and reflow it.
 */
function flatten(text) {
  let fenced = false;

  return text
    .split('\n')
    .map((line) => {
      if (/^\s*```/.test(line)) {
        fenced = !fenced;
        return line;
      }
      if (fenced) return line;
      // A list marker keeps one level so nesting still reads; everything else
      // goes flat against the margin.
      return /^\s{1,3}[-*+]\s|^\s{1,3}\d+[.)]\s/.test(line) ? line.trimStart() : line.replace(/^\s+/, '');
    })
    .join('\n');
}

function noteLine(text) {
  const line = make('div', 'agent-note');

  // Split on the quoted runs, keeping them. Anything not quoted is plain.
  for (const part of String(text).split(/(“[^”]*”|"[^"]*")/g)) {
    if (!part) continue;
    if (/^[“"]/.test(part)) line.append(make('b', 'agent-value', part.slice(1, -1)));
    else line.append(document.createTextNode(part));
  }

  return line;
}

/**
 * The approval gate. Deliberately spells out the consequence rather than asking
 * a bare "continue?" — the risk is the whole reason we stopped.
 */
function approvalGate(turn, pending) {
  const box = make('div', 'agent-confirm');

  /**
   * A label, because a box of text with two buttons is not self-evidently a
   * question. This is the one thing in the panel that is BLOCKING — the run is
   * stopped until it is answered — and it has to be distinguishable at a glance
   * from the notes and steps it sits among, which look broadly the same.
   */
  const head = make('div', 'agent-confirm-head');
  head.append(
    make('span', 'agent-confirm-pip'),
    make('span', 'agent-confirm-label', pending.risk ? 'Needs your approval' : 'Waiting on you')
  );
  box.append(head);

  box.append(make('div', 'agent-confirm-text', pending.description));

  /**
   * The consequence on its own line, not glued onto the question with a dash.
   *
   * "Click Create Account — this submits the form." reads as one sentence and
   * the half that matters is the half people skim past. It is the reason the
   * run stopped, so it gets its own line and its own colour.
   */
  if (pending.risk) box.append(make('div', 'agent-confirm-risk', `This ${pending.risk}.`));

  /**
   * Values the run needs, drawn as the controls they actually are.
   *
   * A run that stops because it needs a spreadsheet ID and a sheet title is not
   * asking a yes/no question, and answering it into one free-text box makes
   * both sides guess: the user about the format, the model about which half of
   * the sentence was which. A labelled control per value removes both guesses,
   * and a date field beats typing a date into prose every time.
   */
  if (pending.fields?.length) {
    box.append(fieldForm(box, turn, pending.fields));
    return box;
  }

  const row = make('div', 'agent-confirm-row');

  const yes = make('button', 'agent-approve', 'Allow');
  yes.addEventListener('click', () => resolveConfirm(turn, true));

  const no = make('button', 'agent-decline', 'Skip');
  no.addEventListener('click', () => resolveConfirm(turn, false));

  /**
   * The third answer, which is most of them.
   *
   * "Shall I submit — and what values should I use?" cannot be answered by
   * either button, and that is not an unusual question: the model asks it the
   * moment a task leaves something out. With only Allow and Skip the only way
   * to answer was to stop the run, retype the whole task with the missing
   * details, and start again from the top of the page.
   */
  const other = make('button', 'agent-other', 'Other…');
  other.addEventListener('click', () => openReply(box, turn));

  row.append(yes, no, other);
  box.append(row);

  /**
   * Focus the safe one.
   *
   * Enter is the key everyone hits, and the panel's composer is the thing they
   * were just typing in — so the default has to be the choice that does
   * nothing irreversible. Skip declines the step and the run carries on; Allow
   * submits the form.
   */
  requestAnimationFrame(() => no.focus({ preventScroll: true }));

  return box;
}

/**
 * One control per value the agent asked for, plus the two ways out.
 *
 * Built once and never repainted: `patchAgent` rebuilds this node on every
 * emitted step, and a step landing while someone is halfway through typing
 * would wipe what they had entered. Nothing here is kept in the turn's state
 * for the same reason.
 */
function fieldForm(box, turn, fields) {
  const form = make('div', 'agent-fields');
  const inputs = [];

  for (const field of fields) {
    const wrap = make('label', 'agent-field');
    wrap.append(make('span', 'agent-field-label', field.label || field.name));

    let input;
    if (field.type === 'textarea') {
      input = make('textarea', 'agent-field-input');
      input.rows = 3;
    } else if (field.type === 'select' && field.options?.length) {
      input = make('select', 'agent-field-input');
      for (const option of field.options) {
        const node = make('option', '', option);
        node.value = option;
        input.append(node);
      }
    } else {
      input = make('input', 'agent-field-input');
      input.type = field.type === 'select' ? 'text' : field.type;
    }

    if (field.placeholder) input.placeholder = field.placeholder;
    if (field.value) input.value = field.value;

    // Enter submits from any single-line control, the way a form does. Not from
    // the textarea, where it is a line break and always will be.
    if (field.type !== 'textarea') {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          submit();
        }
      });
    }

    wrap.append(input);
    form.append(wrap);
    inputs.push({ field, input });
  }

  const missing = make('div', 'agent-field-missing');
  form.append(missing);

  function submit() {
    const blank = inputs.filter(({ field, input }) => field.required && !input.value.trim());
    if (blank.length) {
      // Named, not counted: "2 fields are required" makes you hunt for them.
      missing.textContent = `Still needed: ${blank.map(({ field }) => field.label).join(', ')}`;
      blank[0].input.focus();
      return;
    }

    /**
     * Sent as `name: value` lines, one per field.
     *
     * The model asked for these by name, so answering by name is the only shape
     * it can read without guessing — and it survives values that contain commas,
     * newlines or colons of their own, which a single sentence does not.
     */
    const reply = inputs
      .map(({ field, input }) => `${field.name}: ${input.value.trim()}`)
      .join('\n');
    resolveConfirm(turn, true, reply);
  }

  const row = make('div', 'agent-confirm-row');
  const send = make('button', 'agent-approve', 'Send');
  send.addEventListener('click', submit);

  const skip = make('button', 'agent-decline', 'Skip');
  skip.addEventListener('click', () => resolveConfirm(turn, false));

  const other = make('button', 'agent-other', 'Other…');
  other.addEventListener('click', () => openReply(box, turn));

  row.append(send, skip, other);
  form.append(row);

  requestAnimationFrame(() => inputs[0]?.input.focus({ preventScroll: true }));
  return form;
}

/**
 * Swap the buttons for a box to type in.
 *
 * Built in place rather than repainted through `patchAgent`, because that
 * rebuilds this node from the turn's state on every emitted step — and a step
 * arriving while someone is halfway through typing would replace the textarea
 * and lose what they had written. Nothing about the open box is stored in the
 * turn for the same reason.
 */
function openReply(box, turn) {
  // Takes the field form with it when there was one — "Other" means "none of
  // these", and leaving half-filled inputs above a free-text box asks the user
  // which of the two the agent is going to read.
  box.querySelector('.agent-fields')?.remove();
  box.querySelector('.agent-confirm-row')?.remove();

  const wrap = make('div', 'agent-reply');
  const field = make('textarea', 'agent-reply-field');
  field.rows = 2;
  field.placeholder = 'Tell the agent what to do…';

  const row = make('div', 'agent-confirm-row');
  const sendIt = make('button', 'agent-approve', 'Send');
  const back = make('button', 'agent-decline', 'Cancel');

  const submit = () => {
    const text = field.value.trim();
    if (!text) return field.focus();
    resolveConfirm(turn, true, text);
  };

  sendIt.addEventListener('click', submit);
  // Enter sends, Shift+Enter breaks the line — the same contract as the
  // composer below it, because this is the same gesture in the same panel.
  field.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  });
  back.addEventListener('click', () => patchAgent(turn.id));

  row.append(sendIt, back);
  wrap.append(field, row);
  box.append(wrap);
  field.focus();
}

function resolveConfirm(turn, approved, reply = '') {
  turn.agent.pendingConfirm = null;
  send({ type: 'AGENT_CONFIRM_RESULT', approved, reply });
  patchAgent(turn.id);
}

/** Repaint one agent turn in place, keeping the reader's scroll position. */
export function patchAgent(turnId) {
  const turn = state.turns.find((t) => t.id === turnId);
  if (!turn?.agent) return;

  const existing = els.thread.querySelector(`.msg.assistant.agent[data-turn="${turnId}"]`);
  if (!existing) {
    emit(EVENTS.RENDER_THREAD);
    return;
  }

  // Shared with the reply path rather than repeating the arithmetic: an agent
  // run repaints this node on every step, and a bare `scrollTop =` here would
  // start a fresh smooth scroll each time (see `stickToBottom`).
  const pinned = pinnedToBottom();
  existing.replaceWith(agentMessage(turn));
  if (pinned) stickToBottom();
  else syncScrollState();
}

export function setAgentMode(on) {
  state.agentMode = on;
  els.btnAgent.setAttribute('aria-pressed', String(on));
  els.agentLabel.textContent = on ? 'Agent Mode ON' : 'Agent Mode';
  els.input.placeholder = on ? 'What should I do?' : 'Ask about this page…';
  // Always visible: it is a setting people go looking for, and a control that
  // only exists once another control is on is a control nobody finds.
  els.agentPolicy.classList.toggle('inactive', !on);
}

export const POLICY_HINT = {
  'confirm-risky': 'It will stop before anything that submits, sends or deletes.',
  'confirm-all': 'It will stop before every single action.',
  auto: 'It will not stop for anything until the task is done — including form submits.'
};
