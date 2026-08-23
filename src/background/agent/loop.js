import {
  MAX_STEPS,
  OBSERVE_CHARS,
  MAX_AUTO_LOOKS,
  MAX_ERROR_LOOKS,
  MAX_MISREADS,
  MAX_BATCH_ACTIONS,
  DEEP_OBSERVE_CHARS,
  DEEP_OBSERVE_MS
} from './limits.js';
import { systemPrompt, parseAction, renderObservation, closing } from './protocol.js';
import {
  observePage,
  captureTab,
  captureFullTab,
  takeControl,
  watchOpenedTabs,
  waitForLoad,
  settle,
  sendToPage,
  followFocus,
  isControlled
} from './page.js';
import {
  SURVEY_FORMAT,
  announceSurvey,
  emitPlan,
  notesFrom,
  planFrom,
  routeOnly,
  worthPlanning
} from './plan.js';
import { performAction } from './actions.js';
import { readInParts, needsPartReading } from './read.js';

/**
 * The browser-agent loop.
 *
 *   observe the page  ->  ask the provider what to do  ->  do it  ->  repeat
 *
 * Text is the default observation and a picture is the exception, because a
 * screenshot costs a tab activation, a paint wait and a large share of the
 * turn's attention. The exception is not rare, though: the element list stops
 * describing the page often enough — an overlay, a control that moved, a click
 * that silently did nothing — that a run without any vision at all spends its
 * steps repeating itself. So the loop watches for the three shapes of being
 * blind (a failed step, a step that changed nothing, the same step twice) and
 * takes the picture itself, before the observation that goes with it.
 *
 * Run one task to completion.
 *
 * `ask(prompt, image)` sends a message to the provider and resolves with its
 * reply. `emit(event)` reports progress to the panel. `confirm({description,
 * risk})` resolves true/false — the user's call on a step that cannot be undone.
 * `signal.cancelled` is checked between steps.
 */
export async function runAgent({
  task,
  tabId,
  /**
   * Every tab this run may work on, primary first.
   *
   * A task worth giving an agent is very often about more than one page — take
   * the requirements from this ad, check them against my CV, fill in that form
   * — and until this the run was handed exactly one tab and the others arrived
   * as prose it could read but never touch. The list is closed: the model may
   * move between these and the tabs it opens itself, and nothing else. See
   * `resolveWorkingTabs` in run.js.
   */
  tabs = null,
  ask,
  emit,
  confirm,
  signal,
  policy = 'confirm-risky',
  upload = null,
  pacing = false,
  /**
   * The run had no page to start from, so it is sitting on the placeholder.
   *
   * Set by `resolveAgentTab` in run.js when it had to open or navigate to
   * AGENT_START_URL. It matters because the whole survey — the deep read, the
   * stitched picture, the planning round trip — is spent describing a page that
   * has nothing to do with the task. Measured on "find latest jobs in linkedin
   * and apply to at least 5": the run scrolled google.com to the bottom,
   * photographed it because a frame made it look unreadable, and then sat in
   * `Working out a plan` for over two minutes, all before it had been anywhere
   * near LinkedIn. The plan that comes back is a route across google.com, and
   * `closing()` then repeats it as YOUR PLAN on every later turn — so it is not
   * merely slow, it anchors the rest of the run to the wrong page.
   */
  blankStart = false
}) {
  /** The working set as `{id, title, url}`, always containing the start tab. */
  const workingTabs =
    Array.isArray(tabs) && tabs.length ? tabs : [{ id: tabId, title: '', url: '' }];

  /**
   * Two ways a tab becomes the run's: the user named it, or the run made it.
   *
   * `isControlled` is the second half and it is not optional — `open_tab` and a
   * followed popup both produce tabs that were never in the working set, and
   * without this the model could open a page and then be refused permission to
   * go back to it.
   */
  const mayUseTab = (id) => workingTabs.some((t) => t.id === id) || isControlled(id);

  let currentTab = tabId;
  /**
   * The frame the run is reading and acting in; null is the page itself.
   *
   * Held beside `currentTab` because it is the same kind of thing: an address
   * every page message is sent to. It is cleared whenever the page moves — a
   * navigation, a new tab, a followed popup — because a frameId belongs to one
   * loaded document and reusing it after the page changed addresses a frame
   * that is gone, which fails as "could not reach the page" and reads like the
   * tab died.
   */
  let currentFrame = null;
  let frameLabel = null;

  /** The page whose text the model has already been shown, as {url, modal}. */
  let sentTextFor = null;
  /** Image to attach to the next provider turn, if this step produced one. */
  let pendingImage = null;

  /**
   * The file the user attached, waiting for a turn with a free slot.
   *
   * "Fill in this application with my CV" is the whole point of the feature and
   * it used to send the CV nowhere: the chat path attached it, the agent path
   * quietly dropped it, and the run then finished with "I did not invent your
   * details" — correct, and infuriating, because the details were attached.
   *
   * A provider composer takes one attachment, and a photo of a page the DOM
   * cannot describe is the more urgent of the two, so the file goes on the
   * first turn that is not already carrying one. It is sent once: the provider
   * thread keeps it, and re-uploading a CV per step would cost an upload per
   * click.
   */
  let queuedUpload = upload;
  let uploadThisTurn = null;

  /**
   * Take the attachment slot for the user's file, and say so in the message.
   *
   * Called while a message is being built, before `renderObservation` — the
   * model has to be told the file is there in the same turn it arrives, and
   * `image: Boolean(pendingImage)` must keep meaning "a screenshot", because a
   * turn told to look at a picture that is actually a PDF looks at neither.
   */
  const claimUpload = () => {
    if (pendingImage || !queuedUpload) return '';
    uploadThisTurn = queuedUpload;
    queuedUpload = null;
    return (
      `ATTACHED: the user has attached their own file “${uploadThisTurn.name}” ` +
      'to this message. Read it and take any detail a step needs — a name, an ' +
      'address, work history — from it rather than asking for it or inventing ' +
      'it.\n\n'
    );
  };
  /** The page as the model last saw it, for spotting a step that did nothing. */
  let seen = null;
  /** The previous action, to spot the model going round in a circle. */
  let lastKey = null;
  let autoLooks = 0;
  /**
   * Set once a picture has provably failed to reach this provider.
   *
   * Not a per-provider setting, because whether an upload works depends on the
   * provider's current markup rather than on anything we can know up front —
   * the honest answer is "try once, believe the result". See where it is set,
   * below the `ask`.
   */
  let blindProvider = false;
  /** Screenshots spent on a form that keeps refusing what was typed. */
  let errorLooks = 0;
  /** Observations in a row carrying a validator's complaint. */
  let rejected = 0;
  /** Replies in a row that carried no action. */
  let misreads = 0;
  /**
   * The longest prose reply this run produced, kept until the end.
   *
   * `misreads >= MAX_MISREADS` already turns prose into the answer, and it only
   * fires on CONSECUTIVE misreads — `misreads` resets on every action that
   * parses. A run that researches properly never trips it: it answers in prose,
   * gets corrected, does another action, answers again. Measured on "open Google
   * and search for latest AI news": four separate prose replies across 32 steps,
   * none of them consecutive, one of them a complete summary with headlines —
   * and the run ended on "Stopped after 32 steps without finishing", throwing
   * away the answer it had been holding since step fifteen.
   *
   * So the best one is kept regardless of whether the misreads line up. It is
   * only ever used when the run ends with nothing better; a real `finish` wins.
   */
  let bestProse = '';
  /** The page as the model was last shown it, for re-sending after a misread. */
  let lastObservation = null;
  /** Whether anything at all has been done to a page in this run. */
  let acted = false;
  // One push-back per run against a finish that only promised. More than one
  // and a model that genuinely had nothing to do argues about it for the rest
  // of the run; none, and "yes, I got it" ends the task.
  let pushedBack = 0;

  /**
   * Whether to scroll the whole page before the very first decision.
   *
   * The model cannot ask for a deep read before it has seen anything, and by
   * the time it has seen one screenful of a feed it no longer knows there is
   * more — the observation looks complete. So the task decides: "apply to five
   * jobs here" and "list every result" are the exact shapes that are wrong
   * unless the page was read whole, and paying a few seconds of scrolling up
   * front is cheaper than the run that answers about two of twenty-five.
   *
   * Never on the placeholder start page: scrolling a blank page to the bottom
   * buys nothing, and the seconds are paid in front of the run where they are
   * most visible. The deep read is deferred to the real page along with the
   * rest of the survey — see `surveyPending` below.
   */
  const deepFirst = !blankStart && wantsWholePage(task);

  if (deepFirst) {
    emit({
      type: 'AGENT_STEP',
      step: 0,
      kind: 'observe',
      description: 'Reading the whole page',
      note: 'The task is about several items, so the page is scrolled to the bottom first — a list only renders what you have scrolled past.'
    });
  }

  // Before the first read, not before the first click: the deep read below
  // scrolls the user's own tab, and a page moving on its own is exactly the
  // moment they need to know who is moving it.
  await takeControl(currentTab);

  /**
   * Every tab the user handed over is taken at the start, not when it is first
   * used.
   *
   * They are the agent's for the whole run — it will read them, scroll them and
   * very likely type into them — so they get the curtain and the border now,
   * and they join the tab group now. Waiting until the model happens to switch
   * to one would leave a page the user believes they have lent out looking
   * exactly like one they have not, and a click of theirs landing on it halfway
   * through is the race the curtain exists to prevent.
   */
  for (const tab of workingTabs) {
    if (tab.id !== currentTab) await takeControl(tab.id);
  }

  /**
   * A page that opens its own tab hands the run to a page it has never seen.
   *
   * "Continue on the employer's site", an OAuth popup, any `target="_blank"`
   * link: Chrome opens the new tab silently, the old one is left showing a
   * page that has finished its part, and a run with no idea that happened
   * spends the rest of its steps re-reading it. From the panel that is
   * indistinguishable from the agent hanging.
   *
   * Followed, not just noted: the new tab is what the click was *for*. Control
   * is taken on the spot so it is curtained and marked before the next
   * observation, and `pendingTab` is picked up by the loop rather than
   * swapping `currentTab` from under an action that is mid-flight.
   */
  let pendingTab = null;
  /**
   * A tab you opened for yourself is yours, and the run says so once.
   *
   * `ours` is false when the tab appeared in the long wait between actions,
   * which is when a person switches away and opens something else. Following it
   * used to curtain the page they had just gone to and move the run onto it —
   * the single worst thing an agent can do while you are trying to do something
   * else. Now it is left completely alone, and the timeline records that it was
   * a decision rather than an oversight, once, because the note is only useful
   * the first time.
   */
  let saidLeftAlone = false;
  watchOpenedTabs((tab, ours) => {
    if (!ours) {
      if (saidLeftAlone) return;
      saidLeftAlone = true;
      emit({
        type: 'AGENT_STEP',
        step: 0,
        kind: 'open_tab',
        description: 'Left your new tab alone',
        note: 'A tab opened while the agent was waiting rather than acting, so it is yours. The run stays on the page it was working on.'
      });
      return;
    }
    pendingTab = tab.id;
    takeControl(tab.id);
  });

  /** Move to a tab the page opened, once the current action has finished. */
  const followOpenedTab = async () => {
    if (pendingTab == null || pendingTab === currentTab) {
      pendingTab = null;
      return null;
    }

    const id = pendingTab;
    pendingTab = null;

    // It can be gone again already — a popup that closes itself, an
    // interstitial that redirects the opener and dies.
    const tab = await chrome.tabs.get(id).catch(() => null);
    if (!tab) return null;

    currentTab = id;
    currentFrame = null;
    frameLabel = null;
    await waitForLoad(id);
    await settle(id, 5000);
    await takeControl(id);

    emit({
      type: 'AGENT_STEP',
      step: 0,
      kind: 'open_tab',
      description: 'Followed a new tab',
      note: `The page opened ${tab.url || 'a new tab'}, so the agent moved to it and took control there.`
    });

    return id;
  };

  const first = await observePage(currentTab, {
    frameId: currentFrame,
    query: task,
    maxChars: deepFirst ? DEEP_OBSERVE_CHARS : OBSERVE_CHARS,
    deep: deepFirst,
    budgetMs: DEEP_OBSERVE_MS
  });

  if (!first?.ok) {
    emit({ type: 'AGENT_ERROR', error: first?.error || 'Could not read the starting page.' });
    return;
  }

  /**
   * A deep observation is far more than one turn reads carefully, so it is
   * transcribed part by part before any of it reaches a decision. Skipping this
   * would undo the scrolling: the model would be handed all twenty-five jobs
   * and still answer about the first two, because that is what skimming forty
   * thousand characters produces.
   */
  const digest = async (observation, step) => {
    if (!needsPartReading(observation.text)) return;

    const notes = await readInParts({ ask, task, observation, emit, step, signal });
    if (!notes) return;

    observation.text = notes;
    observation.readInParts = true;
  };

  await digest(first.observation, 0);
  if (signal.cancelled) return;

  sentTextFor = textMark(first.observation);
  seen = fingerprint(first.observation);
  lastObservation = first.observation;

  /**
   * A page the DOM cannot describe gets photographed before the first decision.
   *
   * The auto-screenshot below only ever fires *after* a step, which is one turn
   * too late for a run that starts on a chart, a map, a PDF viewer or a canvas
   * app: the model is handed an empty observation, and an empty observation
   * reads as "there is nothing here" rather than "there is plenty here and none
   * of it is text". It then finishes with an apology about a page it never
   * looked at. One capture up front costs a tab activation; the alternative
   * costs the whole run.
   *
   * Not on the placeholder, though. google.com is a handful of frames around a
   * search box, so `unreadableReason` calls it an embedded document with no
   * readable text and is right — it is simply describing a page nobody asked
   * about. The capture that follows costs a tab activation and a paint wait to
   * photograph a search box.
   */
  const opaqueStart = blankStart ? null : unreadableReason(first.observation);
  if (opaqueStart) {
    pendingImage = await captureTab(currentTab, { label: 'Agent is looking' });
    if (pendingImage) {
      autoLooks += 1;
      emit({
        type: 'AGENT_STEP',
        step: 0,
        kind: 'screenshot',
      description: 'Looked at the screen',
        note: `Took a screenshot because ${opaqueStart}.`
      });
    }
  }

  /**
   * Look at the whole page, decide the route, and only then start acting.
   *
   * The picture is a *stitched* one — every screenful, not the viewport — for
   * the same reason the plan exists at all: a route decided from the top of a
   * form does not know there are three more sections and a submit below the
   * fold, and a plan that stops where the fold does is the plan that produces
   * a run finishing halfway with a confident summary.
   *
   * Everything here is best-effort. A capture that fails, a provider turn that
   * errors, a page too tall to stitch — all of them fall through to a run with
   * no plan, which is exactly what this loop did before and still works. A
   * survey is worth a round trip; it is not worth a run.
   */
  let plan = '';

  /**
   * The tail of every message, in one place.
   *
   * `closing()` already exists because the first turn once ended without the
   * format instruction and the run opened with "Reply was not an action" — the
   * two ends drifted apart, and the symptom showed up a layer away from the
   * cause. The working-set list has exactly the same shape of failure available
   * to it (a model that forgets on turn twelve which tab holds the form), so it
   * goes through the same single point rather than being added at four call
   * sites. `plan` and `currentTab` are read live, not captured.
   */
  /**
   * One decision, made once and used in both places it matters.
   *
   * `tail()` tells the model not to bother asking; `performAction` refuses if
   * it does anyway. The instruction is the fix and the refusal is the safety
   * net — the same shape as every other rule that appears in both the prompt
   * and the loop, and for the same reason: a model that has been told still
   * sometimes tries.
   */
  const mayAsk = mayAskUser(policy, task);

  /**
   * True while a survey has been asked for and its reply has not come back.
   *
   * Read live by `tail()`, exactly like `plan` and `currentTab`, because the
   * survey no longer has a turn of its own: the format spec rides on the next
   * ordinary message and comes off again the moment any reply arrives. Any
   * reply — not just one that parsed. A model that wrote the route and
   * fumbled the block gets the format correction, and re-asking for a route
   * it has already written would spend the correction on the wrong half.
   */
  let surveying = false;

  const tail = () =>
    closing(task, plan, {
      tabs: workingTabs,
      currentTab,
      mayAsk,
      survey: surveying ? SURVEY_FORMAT : ''
    });

  /**
   * Is the attached picture the stitched whole page, or just the viewport?
   *
   * They are not the same evidence and the difference decides the plan: a
   * stitched shot can be trusted for "what else is on this page", a viewport
   * one absolutely cannot, and a model told the wrong one plans around a fold
   * it believes it has already seen past.
   */
  let surveyWhole = false;

  /**
   * Arm the survey on the next message. Runs at most once per run.
   *
   * It takes the picture and raises the flag; it does NOT ask anything. The
   * route used to cost a provider round trip of its own that was forbidden
   * from carrying an action — see SURVEY_FORMAT in plan.js for why that is now
   * folded into the turn that acts on it.
   *
   * Extracted rather than left inline because it has two call sites that must
   * not drift apart: here, for a run that starts on a real page, and the
   * deferred one below for a run that started on the placeholder. Two copies
   * of a block that decides whether to spend a stitched capture is exactly the
   * kind of pair that gets fixed on one side only.
   */
  const survey = async (observation, at) => {
    /**
     * The survey picture is the expensive half, so it is earned rather than
     * assumed.
     *
     * It costs a capture per screenful at ~560ms apart, a tab activation, then
     * an upload into the provider's composer with its own probe and settle —
     * several seconds before a single character of the prompt is typed. That
     * is worth paying when the picture tells the model something the text
     * cannot: a form whose back half is below the fold, or a page that is
     * mostly pixels.
     *
     * On a short, text-rich page it tells it nothing it is not already being
     * given, and the seconds are pure latency in front of the run. Measured on
     * a Google homepage: the whole survey was capture, upload and wait for a
     * picture of a search box the element list had already described.
     */
    const needsPicture =
      Boolean(observation.moreBelow) || Boolean(unreadableReason(observation));

    const full = needsPicture
      ? await captureFullTab(currentTab, {
          label: 'Agent is surveying the page'
        }).catch(() => null)
      : null;

    if (signal.cancelled) return;

    /**
     * The picture rides on the turn as an ordinary attachment.
     *
     * There is one slot, and a stitched whole-page shot is strictly better
     * evidence than a viewport one for the question a survey asks — so it wins
     * when both exist, and `surveyWhole` is what makes the message say which
     * of the two arrived. Told the wrong one, a model plans around a fold it
     * believes it has already seen past.
     */
    if (full?.dataUrl) {
      pendingImage = full.dataUrl;
      surveyWhole = true;
    }

    surveying = true;
    announceSurvey(emit, { step: at, image: Boolean(pendingImage) });
  };

  /** Harvest the route out of the reply that also carried the first actions. */
  const harvestPlan = (text, at) => {
    surveying = false;
    surveyWhole = false;

    const found = planFrom(text);
    if (!found) return;

    // The route is what every later turn is handed; the notes below it are
    // for the page, and repeating twenty lines of them into forty prompts
    // buries the two lines that actually matter. See `routeOnly`.
    plan = routeOnly(found);
    emitPlan(emit, { step: at, plan: found });

    /**
     * Hand the page something to say while it waits.
     *
     * The waits are most of a run and there is nothing on screen during them
     * but a drifting pointer. Best effort in every direction: no plan, no
     * notes, and a page that cannot be reached simply does not get them —
     * nothing here is allowed to cost the run a step.
     */
    // Off the FULL reply, not off `plan` — the notes were just cut out of
    // that, and reading them back from it would find nothing.
    const notes = notesFrom(found);
    if (notes.length) {
      sendToPage(currentTab, { type: 'AGENT_NOTES', notes }, currentFrame).catch(() => {});
    }
  };

  /**
   * A run that began on the placeholder surveys the page it navigates TO.
   *
   * Dropping the survey outright would be the cheap fix and the wrong one: the
   * plan is what makes a sixteen-action batch execution rather than guesswork
   * (see MAX_BATCH_ACTIONS), and a job application is exactly the shape that
   * needs one. So it is deferred, not cancelled — held until the run is
   * somewhere that has to do with the task, then spent there.
   */
  let surveyPending = false;

  /**
   * The host the run began on, so the deferred survey can tell "still on the
   * way there" from "arrived". Blank when the start page had no readable URL,
   * in which case any host at all counts as having left it.
   */
  const startHost = hostOf(first.observation.url);
  const leftStartPage = (url) => {
    const host = hostOf(url);
    return Boolean(host) && host !== startHost;
  };

  if (worthPlanning(task)) {
    if (blankStart) surveyPending = true;
    else await survey(first.observation, 0);
    if (signal.cancelled) return;
  }

  let message =
    systemPrompt(task) +
    '\n\n' +
    /**
     * Two different pictures can be on this turn and they mean different
     * things, so only one line may be printed.
     *
     * `surveyWhole` is the stitched survey shot, which is evidence about the
     * whole page. `opaqueStart` is the viewport shot taken because the DOM
     * could not describe the page, which is evidence about this screenful
     * and says the text below is not to be trusted. Printing both — or
     * printing the opaque warning over a survey capture that has replaced
     * that image — tells the model the wrong thing about what it is looking
     * at, which is the failure the survey exists to prevent.
     */
    (surveyWhole
      ? 'A screenshot of the ENTIRE page is attached — every screenful ' +
        'stitched together, so it shows what is below the fold too. Read it ' +
        'alongside the text below.\n\n'
      : pendingImage
        ? `WARNING: ${opaqueStart}, so a screenshot is attached. What this page ` +
          'holds is in the picture, not in the text below.\n\n'
        : '') +
    claimUpload() +
    renderObservation(0, first.observation, { image: Boolean(pendingImage) }) +
    tail();

  /**
   * Steps are actions, and a re-ask is not one.
   *
   * `step` only advances once a reply actually carried an action. A model that
   * fumbles the format twice used to cost two of the run's steps and finish two
   * jobs short of what was asked — punishing the user for a formatting slip
   * that the next turn corrects. Termination does not depend on this counter:
   * `misreads` ends the run on its own after MAX_MISREADS in a row.
   */
  let step = 0;

  while (step < MAX_STEPS) {
    if (signal.cancelled) return;

    const sentImage = Boolean(pendingImage);
    const planningThisTurn = surveying;
    const planStep = step;
    const reply = await ask(message, pendingImage || uploadThisTurn);
    pendingImage = null;
    uploadThisTurn = null;
    if (signal.cancelled) return;

    /**
     * The route comes out before anything is decided about the actions.
     *
     * Before the parse, deliberately: a reply that carried a good route and a
     * malformed block still surveyed the page, and throwing the route away
     * because the JSON was wrong would make the run pay for the survey twice
     * — once in the turn that produced it and again in every later turn that
     * has to re-derive what it said. `harvestPlan` clears `surveying` either
     * way, so the correction that follows asks for the block alone.
     */
    if (planningThisTurn && !reply.error) harvestPlan(reply.text, planStep);

    /**
     * The picture did not arrive, and the model has just been told it did.
     *
     * This is the worst failure mode vision has, because every layer reports
     * success: the capture worked, the turn completed, the reply parsed. Only
     * the provider's composer knows the file was refused — and the message it
     * answered says "a screenshot is attached". So the model reasons about an
     * image it never saw and produces confident nonsense: measured on a Naukri
     * run against Gemini, two undelivered captures and then a `click_at` on
     * coordinates invented for a picture that did not exist.
     *
     * One failure is enough to stop trying. A provider whose uploader we cannot
     * drive will not start working three steps later, and every further attempt
     * costs a tab activation, a paint wait and a wasted turn. The run carries on
     * from text, which is what it would have done with no camera at all — and
     * `blindProvider` makes sure the model is told that rather than left
     * expecting pictures.
     */
    if (sentImage && reply.imageDelivered === false && !blindProvider) {
      blindProvider = true;
      emit({
        type: 'AGENT_STEP',
        step,
        kind: 'screenshot',
        description: 'Screenshots cannot reach this provider',
        note:
          'The picture was refused by the provider\'s composer, so this run ' +
          'works from the page text only. Switching provider is the fix if the ' +
          'task needs vision.'
      });
    }

    if (reply.error) {
      emit({ type: 'AGENT_ERROR', error: reply.error });
      return;
    }

    const { action, actions = [], error, truncated, dropped = 0 } = parseAction(reply.text);
    if (error) {
      misreads += 1;
      const prose = (reply.text || '').trim();
      // Kept whether or not this misread is consecutive — see `bestProse`.
      if (prose.length > bestProse.length) bestProse = prose;

      /**
       * A model that has answered twice in prose is not going to be nudged into
       * JSON by a third identical nudge — it thinks it is finished. Taking the
       * prose as the answer is what the user wanted from the run anyway, and it
       * beats the alternative on both counts: the old behaviour spent every
       * remaining step re-asking and ended on "stopped after N steps", throwing
       * away an answer it had been holding since step two.
       */
      /**
       * Always ends the run — there is no path back into the loop from here.
       * With re-asks no longer consuming a step, `misreads` is the only thing
       * bounding this branch, so it cannot be conditional on the reply being
       * long enough to pass off as an answer.
       */
      if (misreads >= MAX_MISREADS) {
        emit({
          type: 'AGENT_STEP',
          step: step + 1,
          description: prose.length > 60 ? 'Took the reply as the answer' : 'Gave up asking for an action',
          note: `Asked ${MAX_MISREADS} times without getting one. It last said: ${quote(prose)}`
        });

        // Say so, rather than passing a page summary off as work done. A run
        // that never acted and answers "here are the jobs on this page" reads
        // exactly like one that applied to them, and the user has no way to
        // tell the difference from the panel.
        const admission =
          '\n\n_(The assistant replied with this instead of acting, so nothing on ' +
          'the page was clicked, typed or submitted.)_';

        emit({
          type: 'AGENT_DONE',
          answer:
            prose.length > 60
              ? acted
                ? prose
                : prose + admission
              : (truncated
                  ? 'The provider’s replies kept arriving cut off mid-code-block. '
                  : 'The provider answered without ever giving an action. ') +
                'Nothing was done to the page — try again, or ask for one step at a time.',
          steps: step
        });
        return;
      }

      // The reply itself, not just our complaint about it. Without it this step
      // is unfalsifiable from the panel: a refusal, a page summary and a reply
      // truncated mid-code-block all render as the same sentence, and they need
      // three different responses from whoever is watching.
      emit({
        type: 'AGENT_STEP',
        step: step + 1,
        thought: '',
        // Three different things go wrong here and they read identically as
        // "no action". Which one it was is the whole of what someone watching
        // needs — a cut-off reply is a transport problem, an answer written
        // from memory is the model misreading the task, and a format slip is
        // neither.
        description: truncated
          ? 'Reply arrived cut off — asked again'
          : answeredInsteadOfActing(acted, prose)
            ? 'Answered from memory instead of acting — asked again'
            : 'No action in that reply — asked again',
        note: `${error}\n\nIt replied: ${quote(prose)}`
      });

      // A truncated reply needs nothing re-sent. The model chose an action and
      // we failed to read all of it, so its own thread still holds the page —
      // re-explaining the format to a model that got the format right is how a
      // run talks itself into a loop over a transport problem.
      /**
       * Which correction, and they are not interchangeable.
       *
       * A model that got the format wrong needs the format. A model that
       * ANSWERED needs to be told that answering is not the task — sending it
       * the format instead invites it to wrap the same paragraphs in JSON, or to
       * `finish` with them, because from where it is standing the work is done.
       */
      const answered = answeredInsteadOfActing(acted, prose);

      /**
       * The third case, and on a research task it is the common one.
       *
       * `answered` is a run that has done NOTHING and is talking from memory —
       * it gets told to go and use the browser. Everything else fell through to
       * "send the block itself", with an example built from `firstFieldId` or
       * `firstElementId` — a `type` or a `click`. That is the right nudge for a
       * fumbled action and the wrong one for a model that has finished: it has
       * read the pages, it is writing the summary, and it is handed an example
       * pointing at another control. Measured on the Google-news run: it clicked
       * into an article, then a journal abstract, then "Full Text (PDF)", each
       * time after being shown a click example, and never once reached `finish`.
       *
       * A long reply from a run that HAS acted is a report, not a fumble. The
       * correction for it is one line — that is an action too, and here is its
       * shape — rather than the format lecture, which it did not get wrong.
       */
      const reported = acted && !answered && !truncated && prose.length >= READS_AS_A_REPORT;

      const field = firstFieldId(lastObservation);

      // Re-send what it can act on, with an example built from something that is
      // actually on this page. The bare correction left the model with a
      // reminder and nothing to apply it to, several turns after the element
      // list — so it re-explained itself instead of acting. The page text is
      // left out: it is the expensive half and it has not changed.
      const shownAgain = lastObservation
        ? renderObservation(step + 1, { ...lastObservation, text: '' }) + '\n\n'
        : '';

      const example = reported
        ? '{"thought":"I have what the task asked for","action":"finish",' +
          '"answer":"…everything you just wrote, in full…"}'
        : field
          ? `{"thought":"search for what the task asks about","action":"type","id":${field},` +
            '"text":"…","submit":true}'
          : `{"thought":"why","action":"click","id":${firstElementId(lastObservation)}}`;

      message = truncated
        ? error + tail()
        : reported
          ? // No element list here, deliberately. `shownAgain` is what makes a
            // stuck run reach for another control, and this run's problem is
            // that it will not stop reaching. It has the answer; it needs the
            // door, not the page again.
            'That reply IS your answer — but it carried no action, so the run cannot end ' +
            'and the user has not been shown a word of it.\n\n' +
            'Reporting is an action. Send back exactly what you just wrote, inside a ' +
            'finish block. Do not shorten it, do not go and check it again, and do not ' +
            'click anything else:\n\n' +
            '```json\n' +
            example +
            '\n```' +
            tail()
        : error +
          '\n\n' +
          shownAgain +
          (answered
            ? 'You answered from your own knowledge. That is not this task.\n\n' +
              'Nothing has been opened, read or clicked — the browser is still on the page ' +
              'listed above, so every claim in that reply came from memory rather than from ' +
              'anything on screen. This task is to USE THE BROWSER: open pages, read what is ' +
              'actually on them, and build the answer out of what you find there. Do not ' +
              'repeat the analysis, and do not finish yet — there is nothing to finish, ' +
              'because no page has been looked at.\n\n' +
              'Start by getting to the information. Reply with one action and nothing else:\n\n'
            : 'That reply carried no action, so nothing happened and the page has not ' +
              'moved. Send the block itself, like:\n\n') +
          '```json\n' +
          example +
          '\n```' +
          tail();
      continue;
    }

    // A real action: this is the step the run has been counting towards. A
    // batch is one step, not several — the counter bounds provider round trips,
    // which is what a run's cost and its patience are actually made of.
    misreads = 0;
    step += 1;

    if (dropped) {
      emit({
        type: 'AGENT_STEP',
        step,
        description: `Plan trimmed to ${actions.length} actions`,
        note: `${dropped} more were dropped: a plan longer than ${MAX_BATCH_ACTIONS} is planned against a page that will not survive it.`
      });
    }

    if (action.action === 'finish') {
      const answer = action.answer || reply.text || '';

      /**
       * Agreeing is not doing, and it ends the run just as effectively.
       *
       * The failure this catches, measured: asked to write the hardest star
       * pattern, the model answered "Yes, I got it. A 'very hardest' pattern
       * WOULD BE a Swastik, Butterfly, Rangoli…" — acknowledged the task,
       * described the work, changed nothing, finished. From the panel that is
       * indistinguishable from success: a confident paragraph and a green
       * "Agent finished". Three turns went that way in a row.
       *
       * Nothing else in the loop can catch it. The reply parsed, the action was
       * valid, no step failed, no misread fired — `finish` was simply taken at
       * its word. So the test is structural (`acted` is false: not one thing
       * was typed, clicked or submitted all run) AND textual, because a run
       * that only ever had to READ something must still be able to end. The
       * phrases are the promising and acknowledging ones — "I got it", "would
       * be", "I can", "let me" — which is what a description of unstarted work
       * sounds like, and not what a report of finished work sounds like.
       */
      if (!acted && pushedBack < 1 && PROMISED_RATHER_THAN_DID.test(answer)) {
        pushedBack += 1;
        emit({
          type: 'AGENT_STEP',
          step: step + 1,
          description: 'Asked it to actually do it',
          note:
            'It described the work instead of doing it, and nothing on the page ' +
            `had been changed. It said: ${quote(answer)}`
        });

        // Not counted as a step, like any other re-ask: the model gets another
        // go at the same turn rather than the user paying for its mistake.
        message =
          'You have not changed anything on this page — nothing has been typed, ' +
          'clicked or submitted this whole run — and your reply describes what ' +
          'the answer WOULD be rather than reporting what you DID.\n\n' +
          'If the task genuinely only needed an answer, finish again and say ' +
          'plainly that no action was needed. Otherwise do the work now: return ' +
          'the actions that carry it out. Naming the thing, agreeing that you ' +
          'understand, or explaining what such a thing would look like does not ' +
          'count and ends the task without it being done.\n\n' +
          `THE USER'S TASK: ${task}`;
        continue;
      }

      emit({ type: 'AGENT_DONE', answer, steps: step });
      return;
    }

    const batchKey = actions.map(actionKey).join(' | ');
    const repeated = batchKey === lastKey;
    lastKey = batchKey;

    /**
     * Carry out everything this reply asked for, in order, until it stops
     * making sense.
     *
     * A round trip costs ten to forty seconds, so a form that was fully visible
     * in one observation used to cost one of those per field — nearly all of it
     * spent re-deciding what had already been decided when the form was read.
     * When the model can see the whole sequence it sends the whole sequence.
     *
     * The batch is abandoned on the FIRST failure rather than pushed through:
     * every action here was planned against ids from one observation, and the
     * commonest reason one fails is that an earlier one changed the page out
     * from under the rest. Stopping puts a fresh observation — and, when the
     * element list has stopped explaining things, a screenshot — in front of
     * the next decision, which is exactly what a stuck run needs.
     */
    let outcome = null;
    const done = [];
    let abandoned = 0;
    /** Whether the batch stopped because a field opened a list to choose from. */
    let chooserOpen = false;

    for (const [index, act] of actions.entries()) {
      // Reading and looking are not acting — a run that only ever observed has
      // done nothing to the page, whatever it says about it afterwards.
      if (MUTATING.has(act.action)) acted = true;

      if (act.action === 'finish') {
        // The goal is met. Anything the model queued behind this is dropped by
        // the parser; nothing after it runs.
        emit({ type: 'AGENT_DONE', answer: act.answer || reply.text, steps: step });
        return;
      }

      outcome = await performAction({
        action: act, step, currentTab, currentFrame, lastObservation, emit, confirm, policy,
        // Whether the MODEL may put a question to the user — not the same
        // question as whether the POLICY may. Decided once, above.
        mayAsk,
        pacing,
        /**
         * Whether a picture can actually reach the model.
         *
         * False once this provider has refused an upload. The `screenshot`
         * action then declines up front rather than capturing: the alternative
         * is to photograph the page, fail to deliver it, and hand back "the
         * image is attached" — which is the sentence that had the model
         * inventing coordinates for a screenshot it had never seen.
         */
        canAttachImages: !blindProvider,
        // `upload`, not `queuedUpload` — the latter is spent by claimUpload on
        // the first provider message, and a form can want the same CV twice.
        upload,
        onFrameChange: (frameId, listed) => {
          currentFrame = frameId;
          frameLabel = listed?.name || null;
          // The frame is a different document, so everything the model has been
          // shown about the page it came from is stale — including the mark
          // that says "you already have this text".
          sentTextFor = null;
          seen = null;
        },
        onTabChange: (id) => {
          currentTab = id;
          // A different tab is a different document tree; the old frameId
          // means nothing in it.
          currentFrame = null;
          frameLabel = null;
          // A run that navigates or opens a tab lands on a page that has never
          // heard of it. `takeControl` is per-tab and remembers, so the one it
          // came from is still released at the end.
          takeControl(id);
          /**
           * Bring it forward — but only for someone already watching this run.
           *
           * Following an agent that reads one tab and types into another is
           * incomprehensible if the screen never moves: the timeline says
           * "Typed into Full name" and the page in front of you did not change,
           * because it happened somewhere else. `followFocus` is a no-op for
           * anyone who has switched to a tab of their own, which is the same
           * rule the camera obeys — see `userIsWatching` in page.js.
           */
          followFocus(id);
        },
        // The closed working set, so `switch_tab` cannot wander out of it.
        mayUseTab
      });

      if (signal.cancelled) return;

      if (outcome.stop) {
        emit({ type: 'AGENT_DONE', answer: outcome.answer || 'Stopped.', steps: step });
        return;
      }

      done.push(outcome.note || '(no result)');

      if (outcome.failed) {
        abandoned = actions.length - index - 1;
        break;
      }

      /**
       * A chooser just opened, and nothing after it can have been planned.
       *
       * Typing into a combo box filters a list; it does not fill the field in.
       * The rest of a plan written before that list existed is aimed at a page
       * that has not happened yet — and the batch it usually ends with is
       * "submit", which is how a form gets told it is empty five times running.
       */
      if (outcome.opened) {
        abandoned = actions.length - index - 1;
        chooserOpen = true;
        break;
      }

      // Entering or leaving a frame swaps the whole element list for another
      // document's. Anything planned behind it was aimed at numbers that mean
      // something else now, which is worse than aiming at nothing.
      if (outcome.frameChanged) {
        abandoned = actions.length - index - 1;
        break;
      }

      // A step that moved the page invalidates the ids the rest were planned
      // against, so the remainder is re-planned rather than fired blind.
      if (outcome.tabId != null && outcome.tabId !== currentTab) {
        abandoned = actions.length - index - 1;
        break;
      }
    }

    if (abandoned) {
      emit({
        type: 'AGENT_STEP',
        step,
        kind: 'halted',
      description: `Stopped after ${done.length} of ${actions.length} actions`,
        note: chooserOpen
          ? 'That field answers with a list, so the rest of the plan was dropped — the options are on screen now and one of them has to be chosen.'
          : 'The page moved on, so the rest of the plan was dropped and the page is being read again.'
      });
    }

    if (outcome.tabId != null && outcome.tabId !== currentTab) {
      currentTab = outcome.tabId;
      await takeControl(currentTab);
    }

    /**
     * Checked after the batch, not during it: an action mid-flight is talking
     * to a tab id it captured when it started, and swapping that underneath it
     * turns "the link opened a tab" into a message sent to the wrong page. A
     * click that opened a tab has ended its batch anyway — everything queued
     * behind it was planned against the page that is no longer in front.
     */
    if (await followOpenedTab()) {
      sentTextFor = null;
      abandoned = 0;
    }

    // The model asked for a picture itself; that decision is already made.
    if (outcome.image) pendingImage = outcome.image;

    // What the page needs read is decided by the LAST action that actually ran,
    // not the first one planned: a batch that ends in an observe asked for the
    // text, and one that ends in a click did not.
    const ran = actions[done.length - 1] || action;

    // The text goes back in only when the model asked for it, or the page
    // underneath is no longer the one it read — otherwise every step re-pays for
    // a page it already has, which is most of what makes a long run expensive.
    const deep = ran.action === 'observe' && ran.deep === true;

    const request = {
      query: ran.query || task,
      maxChars: deep ? DEEP_OBSERVE_CHARS : OBSERVE_CHARS,
      deep,
      budgetMs: DEEP_OBSERVE_MS,
      sentTextFor: ran.action === 'observe' ? null : sentTextFor
    };

    let next = await observePage(currentTab, { ...request, frameId: currentFrame });

    // Every later read this step is a plain one. Re-scrolling the user's tab to
    // photograph it would cost the seconds twice and move the page out from
    // under the picture we took of it.
    const reread = { ...request, deep: false };
    let blind = '';

    /**
     * How many observations in a row have carried a validator's complaint.
     *
     * Counted here rather than inside `visionReason` because it has to survive
     * between steps: the shape being caught is submit → errors → fiddle →
     * submit → the same errors, and no single step of that looks wrong.
     */
    if (next?.ok) {
      rejected = FORM_REJECTED.test(next.observation.text || '') ? rejected + 1 : 0;
    }

    // `blindProvider`: a picture this provider has already refused once is a tab
    // activation, a paint wait and a wasted turn for something that will not
    // arrive. The loop goes on from text, which is what it did before vision.
    if (next?.ok && !pendingImage && !blindProvider) {
      const reason = visionReason({
        action: ran,
        outcome,
        before: seen,
        after: next.observation,
        repeated,
        rejected
      });

      // A form fight gets its own budget. It starts late — ten steps into a
      // run, when the ordinary allowance is usually gone — and it is the state
      // where a picture is worth most.
      const onErrorBudget = rejected >= 2 && errorLooks < MAX_ERROR_LOOKS;
      const affordable = reason && (autoLooks < MAX_AUTO_LOOKS || onErrorBudget);
      // Named for why, not for what: "Agent is looking" beside a page that has
      // just refused a form is the difference between the user seeing a
      // hiccup and seeing the agent work out what went wrong.
      const image = affordable
        ? await captureTab(currentTab, {
            label: rejected >= 2 ? 'Agent is reading the errors' : 'Agent is looking'
          })
        : null;

      if (image) {
        autoLooks += 1;
        if (onErrorBudget) errorLooks += 1;
        pendingImage = image;
        blind = reason;

        emit({
          type: 'AGENT_STEP',
          step,
          kind: 'screenshot',
      description: 'Looked at the screen',
          note: `Took a screenshot because ${reason}.`
        });

        // Read the page again now the picture exists. Bringing a tab forward can
        // finish painting whatever it was deferring while hidden, and the ids the
        // model acts on have to describe the page in the image it is looking at —
        // an element list from before the capture is a different page.
        const after = await observePage(currentTab, { ...reread, frameId: currentFrame });
        if (after?.ok) next = after;
      }
    }

    if (next?.ok) {
      await digest(next.observation, step);
      if (signal.cancelled) return;

      if (next.observation.text) sentTextFor = textMark(next.observation);
      seen = fingerprint(next.observation);
      lastObservation = next.observation;

      /**
       * The run has arrived somewhere real, so now it is worth surveying.
       *
       * Gated on the HOST changing, not the URL. A run that starts on the
       * placeholder very often searches from it first, and google.com/search is
       * still not the page the task is about — surveying there would spend the
       * round trip on a results list and hand every later turn a route across
       * it. Waiting for a different site is what makes this land on the job
       * board rather than on the way to it.
       *
       * `next.observation` is whatever the last action left on screen, which is
       * the page the plan should describe. It is deliberately not re-read
       * deeply first: `wantsWholePage` already gets its chance through the
       * model's own `{"action":"observe","deep":true}`, and paying a full scroll
       * here would put back most of the latency this exists to remove.
       */
      if (surveyPending && leftStartPage(next.observation.url)) {
        surveyPending = false;
        // Sets `surveying` and may take the picture; the route is asked for on
        // the message built below rather than in a turn of its own.
        await survey(next.observation, step);
        if (signal.cancelled) return;
      }
    }

    /**
     * Every action's result, numbered, not just the last one's.
     *
     * A batch that filled four fields and failed on the fifth reads as a single
     * failure if only the last note goes back — so the model redoes the four
     * that worked. The count in the heading is what tells it where the plan
     * stopped, and the line about the rest being dropped is what stops it
     * assuming they ran.
     */
    const droppedNote = abandoned
      ? '\n(' +
        (chooserOpen
          ? `the remaining ${abandoned} were dropped: that field answers with a ` +
            'list, so nothing after it could have been planned. Its options are ' +
            'in the observation below — CLICK the one you want. The field is ' +
            'empty until you do, whatever you typed into it.'
          : `the remaining ${abandoned} were dropped — the page changed, so the ` +
            'ids they used are gone. Re-plan from the observation below.') +
        ')'
      : '';

    /**
     * The dropped-plan note belongs on both shapes, not just the numbered one.
     * A batch of two that stops after one produces a single-line RESULT, and
     * that branch used to say nothing about the action that never ran — so the
     * model saw "typed into [14]" and no reason its submit had vanished.
     */
    const result = done.length
      ? (done.length === 1
          ? `RESULT: ${done[0]}`
          : `RESULT (${done.length} of ${actions.length} actions):\n` +
            done.map((note, i) => `${i + 1}. ${note}`).join('\n')) +
        droppedNote +
        '\n\n'
      : '';

    message =
      result +
      (blind
        ? `WARNING: ${blind}, so a screenshot is attached. ` +
          (rejected >= 2
            ? 'Read the error text in the picture, fix the exact field it names, ' +
              'and do not press submit again until you have — pressing it again ' +
              'is what produced this message.'
            : outcome?.failed
              ? 'The numbered element did not work for that step. Find the ' +
                'control in the picture and aim at it directly — ' +
                '{"action":"click_at","x":…,"y":…}, or {"action":"type","x":…,' +
                '"y":…,"text":"…"} — rather than sending the same id again.'
              : 'Read it before deciding — and pick a different approach, not ' +
                'the same step again.') +
          '\n\n'
        : '') +
      claimUpload() +
      // The deferred survey takes its picture here, and it is the stitched
      // whole page rather than the viewport — same reason as the first
      // message: a model told the wrong one plans around a fold it thinks it
      // has already seen past.
      (surveyWhole
        ? 'A screenshot of the ENTIRE page is attached — every screenful ' +
          'stitched together, so it shows what is below the fold too.\n\n'
        : '') +
      (next?.ok
        ? renderObservation(step, next.observation, { image: Boolean(pendingImage) })
        : `OBSERVATION FAILED: ${next?.error || 'unknown'}`) +
      (pendingImage && !next?.ok ? '\n\nA screenshot of the page is attached.' : '') +
      tail();
  }

  /**
   * Out of steps — which is not the same as having nothing to say.
   *
   * This used to be the canned sentence unconditionally, and on a research task
   * that is the worst possible ending: the run opened pages, read them, wrote a
   * summary with headlines in it, and the user was shown "Stopped after 32 steps
   * without finishing" over a fold containing all of the work. The summary was
   * sitting in `bestProse` the whole time.
   *
   * Hedged rather than passed off as a finish, because it is not one: the model
   * never said it was done, so the last thing it wrote may well be the middle of
   * the job. Saying so is what separates this from a real `finish`.
   */
  emit({
    type: 'AGENT_DONE',
    answer:
      bestProse.length >= READS_AS_A_REPORT
        ? `${bestProse}\n\n_(Ran out of steps after ${MAX_STEPS}. That was the last thing ` +
          'the assistant wrote rather than a finished answer, so it may be incomplete.)_'
        : `Stopped after ${MAX_STEPS} steps without finishing. Ask again with a narrower task.`,
    steps: MAX_STEPS
  });
}

/**
 * The reply, short enough to sit in a step note.
 *
 * Shown because the three reasons a turn carries no action — a refusal, a page
 * summary, a reply that arrived cut off — are indistinguishable from the panel
 * otherwise, and they call for three different responses from whoever is
 * watching the run.
 */
function quote(text) {
  const line = (text || '').replace(/\s+/g, ' ').trim();
  if (!line) return '(nothing at all)';
  return `“${line.length > 200 ? line.slice(0, 199) + '…' : line}”`;
}

/**
 * Tasks that are wrong unless the whole page was read.
 *
 * "Click the login button" tolerates one screenful; "apply to the first five
 * Easy Apply jobs", "list every result" and "how many of these are remote" do
 * not — those are exactly the tasks where a confident partial answer is
 * indistinguishable from a complete one, and the user has no way to tell.
 *
 * Deliberately not clever. The cost of a false positive is a few seconds of
 * scrolling; the cost of a false negative is the failure this whole path exists
 * to remove.
 */
/** The things a task can ask for several of. Shared by both tests below. */
const ITEM_NOUNS =
  '(?:jobs?|results?|items?|posts?|rows?|links?|emails?|messages?|products?|' +
  'applications?|listings?|comments?|articles?|videos?|files?|entries)';

/**
 * How many, in digits or in words.
 *
 * "apply to the first five jobs here" is the example this whole path is written
 * around — and it matched nothing, because the pattern only ever looked for
 * `\d+`. People type the small numbers as words, and the small numbers are
 * exactly the ones an agent gets asked for.
 */
/**
 * A finish that promises, acknowledges or describes instead of reporting.
 *
 * Deliberately narrow. It only ever gets consulted when the run changed
 * NOTHING, so the job here is to separate "I read the page, here is the fact
 * you asked for" — which must be allowed to end the run — from "yes, I
 * understand, and it would look like this", which must not. Past tense is the
 * tell of real work and is absent from every phrase below.
 */
const PROMISED_RATHER_THAN_DID =
  /\b(?:i (?:will|can|could|shall|should|am going to)|i'?ll|let me|would be|would look|you (?:can|should|could|need to)|shall i|got it|understood|i understand|here'?s (?:what|how)|next step|to do (?:this|that))\b/i;

/**
 * The host of a page, or '' for anything unparseable.
 *
 * `www.` is stripped so a site that redirects between its two spellings mid-run
 * does not read as having moved — the same reason `looksLikeConversation` does
 * it one layer over.
 */
function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

const A_NUMBER =
  '(?:\\d+|a few|several|couple(?: of)?|one|two|three|four|five|six|seven|eight|nine|ten|dozen)';

const WHOLE_PAGE_TASK = new RegExp(
  [
    '\\b(?:all|every|each|list|lists|compare|how many|count|total)\\b',
    '\\b(?:first|top|last|next|at ?least)\\s+' + A_NUMBER + '\\b',
    // "5 jobs", and "5 easy apply jobs" — the words between the number and the
    // noun are where the user says which ones they mean, so they are skipped
    // rather than required.
    '\\b' + A_NUMBER + '\\s+(?:\\w+\\s+){0,3}' + ITEM_NOUNS + '\\b'
  ].join('|'),
  'i'
);

/**
 * The task asking, in the user's own words, to be consulted before something.
 *
 * This is the ONE thing that survives "Never ask", and the distinction is the
 * whole point of the setting. The policy gate is the extension being cautious
 * on the user's behalf, and Never ask switches that off. A question the user
 * WROTE INTO THE TASK is not the extension being cautious — it is the task —
 * and a setting cannot reasonably countermand the sentence typed beside it.
 *
 * Matched against the instruction rather than the whole prompt for the same
 * reason `WHOLE_PAGE_TASK` is: a task is often pasted material with the request
 * at one end, and a CV that happens to contain "confirm" would otherwise switch
 * approvals back on for a run the user had set to unattended.
 */
const WANTS_CONFIRMATION = new RegExp(
  [
    // "ask me", "check with me", "confirm with me", "let me know first"
    /\b(?:ask|check|confirm|clear|verify|consult|notify|tell|let)\s+(?:it\s+)?(?:with\s+)?me\b/,
    // "with my approval", "get my permission", "wait for my ok"
    /\bmy\s+(?:approval|permission|confirmation|consent|go[- ]?ahead|ok|okay|sign[- ]?off)\b/,
    // "before submitting, ask" / "don't submit without asking"
    /\bbefore\s+(?:you\s+)?(?:submit|submitting|send|sending|apply|applying|pay|paying|delete|deleting|post|posting)\b/,
    /\b(?:do\s?n[o']?t|never)\s+(?:submit|send|apply|pay|delete|post)\b/
  ]
    .map((r) => r.source)
    .join('|'),
  'i'
);

/**
 * May the model put its own question to the user?
 *
 * Under any policy that already stops for approvals, yes — the user is watching
 * and one more prompt is what they asked for. Under 'auto' (Never ask), only if
 * the task itself asked to be consulted.
 *
 * Without this, "Never ask" did not mean never ask. The model volunteers a
 * confirmation before anything that submits a form — which is the right
 * instinct, and precisely what the setting exists to switch off — so a run set
 * to unattended stopped dead on "May I click Submit application?" and waited
 * for someone who had already said they did not want to be asked. A setting
 * that silently does nothing is bad; one that does nothing AND blocks the run
 * is worse.
 */
const mayAskUser = (policy, task) => policy !== 'auto' || WANTS_CONFIRMATION.test(instructionOf(task));

/**
 * Actions aimed at ONE thing on the page.
 *
 * These do not need the page scrolled to the bottom and transcribed first: what
 * they run on is the element list, and a form is a form whether or not there
 * are nine hundred more results below it.
 */
const SINGLE_TARGET_TASK =
  /\b(?:fill|fill in|filling|complete|submit|log ?in|sign ?in|sign ?up|register|checkout|book|order|upload|attach|click|press|type|enter|reply|comment|search for)\b/i;

/**
 * …unless the same instruction also asks for a set of things.
 *
 * "fill in all the fields" is one form. "apply to the first five jobs" is five
 * of them, and answering it from the first screenful is the failure the deep
 * read exists for — so an explicit set of ITEMS overrides the veto, while a
 * bare "all" (which every pasted CV contains) does not.
 */
const MULTI_ITEM_TASK = new RegExp(
  [
    '\\b(?:first|top|last|next|at ?least)\\s+' + A_NUMBER + '\\b',
    '\\b(?:all|every|each)\\s+(?:\\w+\\s+){0,3}' + ITEM_NOUNS + '\\b',
    '\\b' + A_NUMBER + '\\s+(?:\\w+\\s+){0,3}' + ITEM_NOUNS + '\\b'
  ].join('|'),
  'i'
);

/**
 * The instruction, without the data pasted around it.
 *
 * A task is often a wall of pasted text with the actual request at one end of
 * it — a CV followed by "fill the form" is the shape that exposed this. Tested
 * whole, that CV supplies "all", "total" and "list" on its own, so the run
 * scrolled LinkedIn to the bottom and spent four provider round trips
 * transcribing 15,000 characters before touching the form it was asked to fill.
 * Instructions live at the ends; pasted material lives in the middle.
 */
const INTENT_CHARS = 220;

function instructionOf(task) {
  const text = (task || '').trim();
  if (text.length <= INTENT_CHARS * 2) return text;
  return text.slice(0, INTENT_CHARS) + ' … ' + text.slice(-INTENT_CHARS);
}

function wantsWholePage(task) {
  const intent = instructionOf(task);
  if (!WHOLE_PAGE_TASK.test(intent)) return false;
  // One target, no set of items named: the deep read would be pure latency.
  if (SINGLE_TARGET_TASK.test(intent) && !MULTI_ITEM_TASK.test(intent)) return false;
  return true;
}

/** Actions meant to change the page. One that leaves it identical went nowhere. */
const MUTATING = new Set([
  'click', 'click_at', 'type', 'select', 'scroll', 'navigate', 'back'
]);

/**
 * Why the next turn needs a picture, or null if the text is enough.
 *
 * Each of these is a state the model cannot reason its way out of from the
 * element list, because the element list is the thing that is wrong. Everything
 * else — a click that worked, a page that changed as expected — stays text-only.
 */
/**
 * A page saying no to what was just typed into it.
 *
 * Deliberately the *sentences* a validator writes, not the word "required" —
 * every form on the web marks its required fields, and matching that would put
 * a screenshot in front of every step of every form.
 */
const FORM_REJECTED =
  /(errors?\s+found|error\s*[:\-–]|is required and must|must have a value|please (?:fix|correct|complete|enter|provide)|fix the following|invalid (?:entry|value|format)|this field is required)/i;

function visionReason({ action, outcome, before, after, repeated, rejected = 0 }) {
  if (outcome.failed) return 'that step failed';
  if (repeated) return 'that was the second try at the same step';

  /**
   * The form has now refused twice running. Text cannot settle this: the
   * element list shows a field with a value in it, and a field with a value in
   * it and a red error under it are the same line. The picture is the only
   * thing that says which one the page is unhappy about.
   */
  if (rejected >= 2) {
    return 'the form has been rejected twice and the element list cannot show which field is in error';
  }

  if (!after.elements.length) return 'the page offered no controls at all';

  const unreadable = unreadableReason(after);
  if (unreadable) return unreadable;

  if (MUTATING.has(action.action) && before && before === fingerprint(after)) {
    return 'the page is identical to before that step';
  }

  return null;
}

/**
 * "The DOM had nothing, and here is why" — or null if reading was enough.
 *
 * Text extraction fails silently. A chart, a map, a slide, a scanned PDF and a
 * canvas app all come back as an observation with almost no text, which is
 * indistinguishable from a page that really is empty — and a model handed that
 * either invents a plausible answer or gives up on a page that was full of what
 * it needed. So the content script counts what it cannot read (`visual`), and a
 * page that is short on characters while heavy on pixels is photographed
 * instead of guessed at.
 *
 * Both halves of the test matter. Characters alone would fire on every page
 * mid-load; pixels alone would fire on every article with a hero image.
 */
const READABLE_CHARS = 220;

function unreadableReason(observation) {
  const visual = observation?.visual;
  if (!visual) return null;
  if ((visual.chars ?? Infinity) >= READABLE_CHARS) return null;

  if (visual.embed) return 'the page is an embedded document or frame with no readable text';
  if (visual.canvas) return 'the page draws itself on a canvas, which has no text to read';
  if (visual.video) return 'the page is a video with no readable text';
  if (visual.image) return 'the page is images with almost no text';

  return null;
}

/**
 * What the model can act on, as one string.
 *
 * Two identical fingerprints across an action mean it achieved nothing visible —
 * the click landed on a decoration, the overlay swallowed it, the button needed a
 * different one first. Comparing the element list rather than the raw DOM keeps
 * this honest: it changes when what the model can *do* changes, and ignores the
 * ads and timers that mutate a page continuously without meaning anything.
 */
function fingerprint(observation) {
  return [observation.url, observation.modal, observation.elements.join('|')].join('\n');
}

/**
 * A number the model can actually see, for the example in a correction.
 *
 * An abstract example is what the system prompt already gave it, and it did not
 * take. A model that has just answered in prose is not confused about JSON
 * syntax — it is confused about being asked to act — so the correction points
 * at a control on the page in front of it.
 */
function firstElementId(observation) {
  const match = observation?.elements?.[0]?.match(/^\[(\d+)\]/);
  return match ? match[1] : '0';
}

/**
 * A field on this page that could be typed into, if there is one.
 *
 * The correction after a misread builds its example from whatever is first in
 * the element list, which is nearly always a nav link — so a run that has not
 * started yet gets shown `click` when what it needs is `type`. On a search page
 * that is the difference between an example it can follow and one that would
 * take it sideways. Returns null rather than a guess: an example naming a field
 * that is not one is worse than no example.
 */
function firstFieldId(observation) {
  const line = (observation?.elements ?? []).find((entry) =>
    /^\[\d+\]\s+(input|textarea|searchbox|combobox|textbox)\b/i.test(entry)
  );
  return line?.match(/^\[(\d+)\]/)?.[1] ?? null;
}

/**
 * Did this reply at least TRY to be an action?
 *
 * The tell is an `action` key, in any of the shapes `parseAction` already
 * forgives — quoted, bare, or after a nested `thought`. Prose does not contain
 * `action:` or `"action":`; a fumbled action contains little else. Matching the
 * bare word would be useless, since a model narrating its intentions says
 * "action" constantly.
 */
const LOOKS_LIKE_AN_ATTEMPT = /["']?\baction["']?\s*[:=]/i;

/**
 * Below this, a reply is too short to be an answer to anything and is far more
 * likely to be a stray sentence. Only a floor — the discriminator is
 * `LOOKS_LIKE_AN_ATTEMPT`, not length.
 */
const TOO_SHORT_TO_BE_AN_ANSWER = 80;

/**
 * Long enough that a run which has ACTED is reporting rather than fumbling.
 *
 * Higher than the floor above, and for a different question. That one asks "is
 * this prose at all"; this one asks "has this run finished and started writing
 * up". A fumbled action is short — a sentence of narration around a malformed
 * block — while a report opens with a heading and lists what it found. Set well
 * above a stray paragraph so an ordinary mid-run stumble still gets the format
 * correction, which is the one it actually needs.
 */
const READS_AS_A_REPORT = 400;

/**
 * A reply that answered the question instead of going to look.
 *
 * Not a format slip. The model has decided the task is a question it already
 * knows the answer to, written it out, and is waiting to be thanked — which is
 * the commonest way a research-shaped task ("find X, compare them, give me a
 * table") ends at zero steps with a fluent answer about pages nobody opened.
 * The generic correction makes it WORSE: told to "send the block itself", a
 * model in this state either wraps the same prose in JSON or reaches for
 * `finish`, because it believes the work is done.
 *
 * This was a length test first and length is the wrong signal. A model that
 * opens with "Here is a deep analysis of the top Free AI Video Generation
 * Platforms in 2026…" and then a table is unmistakably answering, at whatever
 * length it happens to run to — and a reply that gets cut off, or leads with a
 * one-line summary, is under any threshold worth setting. What actually
 * separates the two cases is whether the model was REACHING for an action at
 * all. `acted` still guards it, so a run that has been working and fumbles one
 * turn gets the format correction it needs.
 */
const answeredInsteadOfActing = (acted, prose) =>
  !acted && prose.length >= TOO_SHORT_TO_BE_AN_ANSWER && !LOOKS_LIKE_AN_ATTEMPT.test(prose);

/** The same action again, ignoring the thought it was wrapped in. */
function actionKey(action) {
  const { thought, ...rest } = action;
  return JSON.stringify(rest);
}

/**
 * Which page the text belongs to. A dialog opening replaces everything the page
 * says without changing its URL, so the URL alone is not an identity.
 */
function textMark(observation) {
  return { url: observation.url, modal: observation.modal };
}
