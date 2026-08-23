import { renderObservation } from './protocol.js';

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
 * Survey the page and come back with a route.
 *
 * Returns the plan as text, or null — a run without a plan is the old
 * behaviour, which works, so nothing here is allowed to end a run. `ask` is the
 * loop's own provider call, so the plan lands in the same conversation as the
 * decisions that follow it and the model can refer back to its own reasoning
 * rather than being re-told it every turn.
 */
export async function makePlan({ ask, task, observation, image, whole, emit, step = 0, signal }) {
  if (signal?.cancelled) return null;

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
      ? 'Looking at the whole page first, then deciding the route before touching anything.'
      : 'Reading the whole page first, then deciding the route before touching anything.'
  });

  const reply = await ask(
    [
      'You are about to drive a real browser to carry out the task below. Before',
      'you touch anything, look at the whole page and work out how you will do it.',
      '',
      // Said differently for the two pictures, because they are not the same
      // evidence: a stitched whole-page shot can be trusted for "what else is
      // on this page", a viewport one absolutely cannot, and a model told the
      // wrong thing plans around a fold it thinks it has already seen past.
      whole
        ? 'A screenshot of the ENTIRE page is attached — every screenful stitched' +
          ' together, so it shows what is below the fold too. Read it alongside' +
          ' the text below.'
        : image
          ? 'A screenshot of the VISIBLE part of the page is attached. There may be' +
            ' more below the fold that it does not show — plan for finding out.'
          : 'The page as text is below.',
      '',
      `TASK: ${task}`,
      '',
      renderObservation(0, observation, { image: Boolean(image) }),
      '',
      'Reply with the plan and NOTHING ELSE. No JSON, no actions — nothing is',
      'being carried out yet, and an action here is discarded.',
      '',
      /**
       * Length is latency here, not verbosity.
       *
       * Nothing in the run happens until this reply has finished generating,
       * and the user is watching a still panel for every second of it. Twelve
       * lines of prose was thirty seconds of that, for a route the next turn
       * reads in three. Terse notes carry the same information and generate in
       * a fraction of the time.
       */
      /**
       * Markdown, and never an indented line.
       *
       * The plan is rendered as a document in the panel, and four leading
       * spaces is a code block in every markdown parser there is — so a route
       * written with hanging indents came out as one grey code card per line,
       * inside a column narrow enough to wrap them a word at a time. It was
       * unreadable, and it read as a rendering bug rather than as a model
       * following the format it was given. Ask for flat markdown and the same
       * renderer that draws an ordinary answer draws this properly.
       */
      'Format: GitHub-flavoured markdown, exactly the three sections below, in',
      'this order. Never indent a line — a leading four spaces renders as code.',
      'Terse notes, no prose, no preamble, no restating the task. Nothing runs',
      'until you finish writing this and the user is watching a still panel',
      'meanwhile, so length is delay: about six lines in total.',
      '',
      '## Route',
      '1. One line each, naming the real buttons and fields by their labels.',
      'Group what can be sent in one turn — six fields is ONE step. Mark a step',
      '**alone** if it replaces the page (submit, navigation, opening a dialog,',
      'or a field that answers with a list).',
      '',
      '## Done when',
      'The specific thing on screen that means stop.',
      '',
      '## Missing',
      'Anything the task does not supply that the page will demand, or "nothing".',
      '',
      /**
       * Twenty short facts, gathered here because here is where the page is
       * already in front of the model.
       *
       * They are shown on the page during the waits — and the waits are most of
       * a run. Asking for them in their own turn would cost another full round
       * trip for something nobody is blocked on; asking for them here costs a
       * few hundred tokens on a turn that was happening anyway. They are last
       * in the reply on purpose: the route is what the next turn needs, and a
       * reply truncated mid-render should lose the notes rather than the plan.
       */
      '## Notes',
      'Then up to 20 one-line notes about THIS site — what it is, what it is for,',
      'what is on this page, anything a person using it would find worth knowing.',
      'One short sentence each, as a bullet list, no numbering. These are shown to',
      'the user while they wait, so make them genuinely interesting rather than a',
      'description of the layout. Write them last.',
      '',
      'A route of "go to the form, fill it in, submit" is worth nothing next',
      'turn. Names, or it is not a plan.'
    ].join('\n'),
    image
  );

  if (signal?.cancelled) return null;

  const text = (reply?.text || '').trim();
  if (reply?.error || !text) return null;

  emit({
    type: 'AGENT_STEP',
    // Same step as the 'Working out a plan' above it — the two are one entry in
    // the timeline, so they must sort together whether the survey happened at
    // the start of the run or on the page it navigated to.
    step,
    kind: 'plan',
    description: 'Plan ready',
    note: text
  });

  return text;
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
