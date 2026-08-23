/**
 * The survey turn: look at the whole page once, decide the route, then act.
 *
 * Without it a run is forty independent decisions, each made from one
 * screenful and none of them aware of the others. That is what makes an agent
 * feel slow even when every individual step is right: the model re-derives
 * "this is a job application, there is a form, the form has a submit at the
 * bottom" on every single turn, and pays a full provider round trip — ten to
 * forty seconds — to arrive back where it already was. It also produces the
 * failure mode of doing the reasonable next thing forever without ever
 * finishing, because nothing in the loop holds a view of the whole job.
 *
 * One turn up front changes the shape of the rest. The model is shown a
 * stitched picture of the entire page and its text, and asked for a route
 * before it is allowed to touch anything — so every later turn is *executing*
 * a decision rather than making one, which is exactly the state in which
 * batching several actions into one reply is safe. The plan is not a script
 * and the loop never enforces it: pages lie, and a plan followed off a cliff is
 * worse than no plan. It is context, carried into every turn by `closing()`.
 *
 * The trade is honest and worth stating: this costs one extra round trip and a
 * few seconds of capture at the start of every run. It pays for itself when the
 * run is longer than about three steps, which the real ones are — a form filled
 * from a plan is two or three dense turns instead of eight thin ones.
 */

/** One imperative: a single action, and a survey would dwarf it. */
const TRIVIAL = /^\s*(?:click|press|tap|scroll|open|go to|navigate|close|refresh|reload)\b[^.]{0,60}$/i;

/**
 * A look-up: search, read, answer.
 *
 * This is the shape that was paying for a plan it could not use. "Find the
 * latest version of Python and tell me what's new" has no route to work out,
 * nothing to batch, and no form whose back half needs checking against a
 * picture — so the survey turn is pure latency in front of a task the model
 * would have got right from the first observation. It cost a full-page capture
 * and a whole provider round trip, which on these is most of the run.
 */
const LOOKUP =
  /\b(?:find|search|look ?up|tell me|what(?:'s| is| are)|who(?:'s| is)|when(?:'s| is)|where(?:'s| is)|how (?:much|many|do|does)|check|summar(?:ise|ize)|read|explain|compare|latest|price of)\b/i;

/**
 * …unless it also acts on a form, which is what the survey exists for.
 *
 * "Find the fullstack job and apply for it" reads as a look-up and is not one.
 * An explicit verb opts back in, so the veto above can be generous without
 * taking the plan away from the tasks that were the whole reason for it.
 */
const ACTS_ON_A_FORM =
  /\b(?:fill|filling|apply|applies|applying|submit|register|sign ?up|sign ?in|log ?in|book|order|checkout|upload|attach|complete the form|answer)\b/i;

/**
 * Is this task worth a planning turn?
 *
 * Two vetoes, both about latency the user can feel. A survey costs a stitched
 * capture plus a provider round trip before anything visibly happens, and on a
 * short task that is most of the elapsed time — which is exactly what "even a
 * simple message takes forever" was.
 */
export function worthPlanning(task) {
  const text = (task || '').trim();
  if (!text) return false;
  if (TRIVIAL.test(text)) return false;
  // A question that never touches a form has no route to plan.
  if (LOOKUP.test(text) && !ACTS_ON_A_FORM.test(text)) return false;
  return true;
}

/**
 * The survey is not a turn of its own any more.
 *
 * It used to be: one provider round trip that produced a route and NOTHING
 * ELSE — the prompt said so outright, and an action arriving there was
 * discarded. That bought the route at the price of a whole round trip in front
 * of every run, and it was the most visible wait in the extension: a still
 * panel reading "Working out a plan" for ten to forty seconds while the model
 * sat with the page, the picture and the task already in front of it, forbidden
 * from doing anything with them. Measured on the run that prompted this: 29s of
 * survey before the first click of a seven-step task.
 *
 * The observation the survey reads IS the observation the first acting turn
 * would read, and nothing happens in between — same page, same numbered ids, no
 * state for a second trip to discover. So asking for the route and the first
 * batch in one reply costs nothing and saves a round trip on every planned run.
 * The model still plans before it acts; it is simply no longer asked twice.
 *
 * The order inside the reply is load-bearing, and it is the same reasoning that
 * already put `## Notes` last: a reply that gets cut off loses its tail. The
 * route comes first because it shapes the actions, the action block second
 * because it is the half the run cannot continue without, and the notes last
 * because nobody is blocked on them.
 */
export const SURVEY_FORMAT = [
  'THIS IS YOUR FIRST TURN ON THIS PAGE, so it has three parts, in this order.',
  '',
  /**
   * Markdown, and never an indented line.
   *
   * The route is rendered as a document in the panel, and four leading spaces
   * is a code block in every markdown parser there is — so a route written with
   * hanging indents came out as one grey card per line, inside a column narrow
   * enough to wrap them a word at a time. It read as a rendering bug rather than
   * as a model following the format it was given.
   */
  'FIRST the route, as flat GitHub-flavoured markdown. Never indent a line — a',
  'leading four spaces renders as code. Terse notes, no preamble, no restating',
  'the task: about six lines in total.',
  '',
  '## Route',
  '1. One line each, naming the real buttons and fields by their labels. Group',
  'what can be sent in one turn — six fields is ONE step. Mark a step **alone**',
  'if it replaces the page (a submit, a navigation, opening a dialog, or a field',
  'that answers with a list).',
  '',
  '## Done when',
  'The specific thing on screen that means stop.',
  '',
  '## Missing',
  'Anything the task does not supply that the page will demand, or "nothing".',
  '',
  /**
   * The half that makes this one turn rather than two.
   *
   * Said as plainly as it can be said, because the model has just been asked for
   * a document and the pull is to stop there and wait to be thanked — which is
   * precisely the "answered instead of acting" shape the loop already keeps a
   * push-back for. Saying it here costs nothing; correcting it afterwards costs
   * the round trip this change exists to remove.
   */
  'SECOND, one fenced JSON block with the actions to carry out NOW: step 1 of',
  'the route you have just written, batched exactly as you grouped it. This is a',
  'real turn and what you put in the block happens, so the route is not the',
  'reply — the block is. Do not stop after the route, and do not wait to be told',
  'to begin. If the task is already done, that is',
  '{"action":"finish","answer":"the answer"}.',
  '',
  'THIRD, after the block:',
  '',
  '## Notes',
  'Up to 20 one-line notes about THIS site — what it is, what it is for, what is',
  'on this page, anything a person using it would find worth knowing. One short',
  'sentence each, as a bullet list, no numbering. These are shown to the user',
  'while they wait, so make them genuinely interesting rather than a description',
  'of the layout. Write them LAST: a reply cut off mid-render should lose these',
  'rather than the actions above them.',
  '',
  'A route of "go to the form, fill it in, submit" is worth nothing next turn.',
  'Names, or it is not a plan.'
].join('\n');

/**
 * Say a survey is happening, before the turn that carries it.
 *
 * Emitted ahead of the ask rather than after it, because this is the longest
 * wait in the run and the panel would otherwise show nothing at all for it. The
 * route itself arrives with the reply and lands as `emitPlan` under the same
 * step number, so the two read as one entry in the timeline.
 */
export function announceSurvey(emit, { step = 0, image = false } = {}) {
  emit({
    type: 'AGENT_STEP',
    // Usually 0 — the survey is the first thing a run does. A run that started
    // on the placeholder start page surveys the page it navigates to instead,
    // and a plan pinned to step 0 there would sort itself above the navigation
    // that reached the page it describes.
    step,
    kind: 'plan',
    description: 'Working out a plan',
    note: image
      ? 'Looking at the whole page first, then acting on the route it decides — both in one turn.'
      : 'Reading the whole page first, then acting on the route it decides — both in one turn.'
  });
}

/**
 * The route, out of a reply that also carried the actions.
 *
 * Only the fenced blocks come out. Everything else the model wrote is the
 * document — including `## Notes`, which `notesFrom` reads back off this same
 * string, and including prose around the sections, because a model that ignored
 * the headings still wrote something worth carrying into later turns.
 *
 * Fences are stripped rather than the text being cut at the first one: the notes
 * come AFTER the action block, so keeping only what precedes it would throw them
 * away every single time.
 */
export function planFrom(text) {
  const plan = String(text || '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/~~~[\s\S]*?~~~/g, '')
    // An unterminated fence: the reply was cut off inside the block, and what
    // follows it is not prose either.
    .replace(/```[\s\S]*$/, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  /**
   * A reply with no headings at all is a bare action, not a plan.
   *
   * Keeping its `thought` as "YOUR PLAN" and repeating it every turn for the
   * rest of the run is worse than having no plan: one turn's throwaway
   * reasoning, handed back forty times as the route the model supposedly
   * checked against a picture of the whole page.
   */
  return /^#{1,4}\s/m.test(plan) ? plan : '';
}

/**
 * The plan minus its notes, which is what every later turn is handed.
 *
 * `closing()` repeats YOUR PLAN on every turn — deliberately, because a plan
 * agreed on turn one is a long way up the thread by turn twenty and a plan
 * the model can no longer see is one it has stopped following. The notes are
 * not part of that: they are up to twenty lines of site trivia gathered on
 * the same turn because the page was already in front of the model, and they
 * exist for the bubbles the PAGE shows while the user waits. Repeating them
 * into forty prompts is twenty lines of ballast per turn in front of the two
 * that matter, and it makes the route harder to find in its own block.
 *
 * `notesFrom` still reads the full text, so nothing is lost — the two halves
 * simply go to the two places that want them.
 */
export function routeOnly(plan) {
  const text = String(plan || '');
  const at = text.search(/^#{1,4}\s*notes\b/im);
  return (at === -1 ? text : text.slice(0, at)).trim();
}

/** Show the route in the timeline, once it has actually arrived. */
export function emitPlan(emit, { step = 0, plan }) {
  if (!plan) return;
  emit({
    type: 'AGENT_STEP',
    // The same step as 'Working out a plan' above it — the two are one entry, so
    // they must sort together whether the survey happened at the start of the
    // run or on the page it navigated to.
    step,
    kind: 'plan',
    description: 'Plan ready',
    note: plan
  });
}

/**
 * The notes, pulled out of the plan for the page to show while it waits.
 *
 * Parsed rather than asked for separately, because a second round trip for
 * something decorative is exactly the latency this file spent the last round
 * cutting. Everything here is best effort: no Notes section, or a model that
 * ignored the format, simply means no notes — the route is the part that
 * matters and it is unaffected.
 */
export function notesFrom(plan) {
  const text = String(plan || '');
  const at = text.search(/^#{1,4}\s*notes\b/im);
  if (at === -1) return [];

  return text
    .slice(at)
    .split('\n')
    .slice(1)
    // Stop at the next heading: a model that puts something after the notes
    // should not have it read as one.
    .reduce((out, line) => (out.done || /^#{1,4}\s/.test(line) ? { ...out, done: true } : { ...out, lines: [...out.lines, line] }), { lines: [], done: false })
    .lines.map((line) => line.replace(/^\s*(?:[-*+]|\d+[.)])\s*/, '').trim())
    .filter((line) => line.length > 12 && line.length < 220)
    .slice(0, 20);
}
