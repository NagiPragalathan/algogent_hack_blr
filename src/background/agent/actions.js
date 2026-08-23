import {
  sendToPage,
  waitForLoad,
  settle,
  captureTab,
  captureFullTab,
  reachFrames,
  frameIdFor,
  retakeControl,
  duringAction,
  setWaitingOnUser
} from './page.js';
import { listShareableTabs, isUserTabId } from '../state/user-tabs.js';
import { AGENT_BEAT_MS } from './limits.js';

/**
 * Carry out one action and describe what happened.
 *
 * The split is between actions the extension performs itself — anything to do
 * with tabs, navigation, screenshots — and actions that happen *inside* a page,
 * which are planned and then executed by the content script. Only the second
 * kind can need the user's approval, because only those touch the page.
 *
 * Every branch returns a `note`: the plain-language result the model reads on
 * its next turn. A failure is a note too, never a thrown error — the loop is
 * supposed to try something else, not stop. It also carries `failed`, because
 * "try something else" is advice the model takes far more often when it can see
 * the page as well as read about it, and that is the loop's call to make.
 */
export async function performAction({
  action,
  step,
  currentTab,
  currentFrame = null,
  lastObservation = null,
  emit,
  confirm,
  policy,
  /**
   * May the MODEL put a question to the user on this run?
   *
   * Decided in `loop.js`, which is the only layer holding the task text — see
   * the `ask` branch below for why this is not simply `policy !== 'auto'`.
   */
  mayAsk = true,
  pacing = false,
  onTabChange,
  onFrameChange,
  /**
   * Is this tab part of the run's working set?
   *
   * See `resolveWorkingTabs` in run.js — the tabs the user named with '@', the
   * page the chat belongs to, and the tabs the run opened itself. Nothing else.
   */
  mayUseTab = null,
  /** False once this provider has refused an upload. See the screenshot branch. */
  canAttachImages = true,
  /**
   * The file the user attached to this run, for `upload`.
   *
   * It travels with the action rather than being fetched by the page, because
   * the content script has no access to the panel's attachment and the bytes
   * are already decoded here. Unlike the provider-side upload this is NOT
   * claimed and spent — a form can legitimately want the same CV in two
   * fields, and a run that could only ever attach once would fail the second.
   */
  upload = null
}) {
  /**
   * `kind` is the action's own verb, passed through rather than guessed at.
   *
   * The panel draws a glyph per step so a run can be scanned instead of read —
   * six "Type…" rows and one "Go to…" row are instantly different shapes. The
   * alternative was matching the description text with a regex in the panel,
   * which breaks the moment a description is reworded, and reads as the UI
   * losing track of what the agent did.
   */
  const report = (description, note, risk) =>
    emit({
      type: 'AGENT_STEP',
      step,
      kind: action.action,
      thought: action.thought || '',
      description,
      note,
      risk
    });

  /**
   * The model asking the user, rather than the policy asking on its behalf.
   *
   * These are two different questions and only one of them existed. The policy
   * gate asks "this looks risky, shall I?" — an assessment the extension makes.
   * Nothing let the *model* ask anything, so a task like "fill it in but check
   * with me before submitting" had exactly one move available: finish with a
   * question in the answer. That reads as a request and IS the end of the run,
   * so answering "yes" has nothing left to continue.
   *
   * Not gated on `policy` DIRECTLY, and that distinction is the whole of it.
   * "Never ask" means "do not stop me for your own risk assessments"; it cannot
   * mean "ignore the instruction I just gave you", so a task that says "check
   * with me before submitting" is still honoured under Never ask — that
   * question is the user's, not the extension's.
   *
   * `mayAsk` is where those two are told apart, and it is decided in `loop.js`
   * because only that layer has the task text. Everything here does is respect
   * the answer.
   */
  if (action.action === 'ask') {
    const question = String(action.question || action.text || action.description || '').trim();

    if (!question) {
      return {
        note:
          'That "ask" carried no question, so nothing was put to the user. ' +
          'Ask again with a "question" field, or carry on.'
      };
    }

    /**
     * Never ask, and the task did not ask to be asked. So do not ask.
     *
     * The model volunteers this question constantly on anything that submits a
     * form — which is the right instinct and exactly what the setting exists to
     * switch off. Leaving it to get through made "Never ask" stop a run dead on
     * a confirmation the user had already said they did not want, which is
     * worse than a setting that does nothing: it looks broken AND it blocks.
     *
     * What goes back has to be an instruction rather than a refusal. A bare
     * "no" invites asking again in a different shape, and a run that spends its
     * steps rephrasing a question nobody will answer never finishes.
     */
    if (!mayAsk) {
      return {
        note:
          `You asked: "${question}" — but the user has set this run to never stop ` +
          'for approval, and their task did not ask to be consulted. Nobody is ' +
          'going to answer. Decide it yourself using the task and what is on the ' +
          'page, and carry on; do not ask again.'
      };
    }

    report(question, 'Waiting for your answer…', action.risk || null);
    const answer = asAnswer(
      await askedOnPage(currentTab, currentFrame, () =>
        confirm({
          description: question,
          risk: action.risk || null,
          // Named values the run needs before it can go on. The panel draws a
          // labelled control per entry rather than one free-text box: "give me
          // the spreadsheet ID and a title" answered into a single textarea is
          // a parsing problem for both of us, and the model then guesses which
          // half of the sentence was which.
          fields: askFields(action.fields)
        })
      )
    );

    report(
      question,
      answer.reply ? `You replied: “${answer.reply}”` : answer.ok ? 'You said yes.' : 'You said no.',
      action.risk || null
    );

    /**
     * The answer is quoted back with the question it answers.
     *
     * A bare "the user approved" is ambiguous in a run that asked two things,
     * which is exactly when it matters. A typed reply goes back verbatim and
     * leads: it is the only part the model could not have predicted, and half
     * the reason people type one is to supply something the task left out.
     */
    if (answer.reply) {
      return {
        note:
          `The user replied to "${question}": ${answer.reply}\n` +
          'Use what they said. If it answers the question, carry on; if it ' +
          'tells you to do something different, do that instead.'
      };
    }

    return {
      note: answer.ok
        ? `The user answered YES to "${question}". Go ahead.`
        : `The user answered NO to "${question}". Do not do it — find another ` +
          'way, or finish and say what you left undone.'
    };
  }

  const handled = await performBrowserAction({
    action,
    report,
    currentTab,
    lastObservation,
    onTabChange,
    onFrameChange,
    mayUseTab,
    canAttachImages
  });
  if (handled) return handled;

  return performPageAction({
    action, report, currentTab, currentFrame, confirm, policy, pacing
  });
}

/**
 * One shape for an answer, whatever the caller sent.
 *
 * `confirm` used to resolve with a boolean and now resolves with
 * `{ ok, reply }`. Tests drive `runAgent` with their own `confirm`, and a
 * harness returning `true` must keep working — a run that wedged on an approval
 * because of a shape change would be a bad trade for a typed reply.
 */
/**
 * The control types a field may ask for, and what an unknown one becomes.
 *
 * Deliberately short. The model picks these, so every name here has to be one
 * it reaches for unprompted, and an unrecognised type must degrade to a plain
 * text box rather than render nothing — a field that does not draw is a run
 * waiting forever on a value the user cannot give it.
 */
const FIELD_TYPES = new Set([
  'text', 'textarea', 'password', 'number', 'date', 'time', 'email', 'url', 'select'
]);

function askFields(raw) {
  if (!Array.isArray(raw) || !raw.length) return null;

  return raw
    .slice(0, 12)
    .map((f) => {
      const name = String(f?.name || f?.label || '').trim();
      if (!name) return null;
      const type = String(f?.type || 'text').toLowerCase();
      const options = Array.isArray(f?.options)
        ? f.options.map((o) => String(o)).slice(0, 20)
        : null;
      return {
        name,
        label: String(f?.label || name).trim(),
        type: FIELD_TYPES.has(type) ? type : 'text',
        placeholder: String(f?.placeholder || '').trim(),
        value: String(f?.value || '').trim(),
        required: f?.required !== false,
        options: type === 'select' ? options : null
      };
    })
    .filter(Boolean);
}

function asAnswer(value) {
  if (value && typeof value === 'object') {
    return { ok: Boolean(value.ok), reply: String(value.reply || '').trim() };
  }
  return { ok: Boolean(value), reply: '' };
}

/**
 * Say on the page that the run is waiting on the user, for as long as it is.
 *
 * The panel holds the actual question, and the panel is where it gets answered
 * — but someone watching their own browser fill a form in is looking at the
 * PAGE, and a run that stops dead there with the pointer still drifting looks
 * like it hung rather than like it is waiting for them. The bubble says the
 * decision is theirs and points at the panel; it deliberately does not repeat
 * the question, or it invites answering in a place that cannot take an answer.
 *
 * The `finally` is the whole point: an approval that is declined, cancelled, or
 * thrown past must still take the bubble down, or the page claims a question is
 * open forever. Both directions are best-effort — a page we cannot reach must
 * never be able to block the approval itself.
 */
async function askedOnPage(tabId, frameId, run) {
  sendToPage(tabId, { type: 'AGENT_ASKING', on: true }, frameId).catch(() => {});
  // And in the tab strip, where someone who has switched away is looking. A
  // group waiting on the user and a group waiting on a provider are otherwise
  // the same three dots, and only one of them will ever finish without them.
  setWaitingOnUser(true);
  try {
    return await run();
  } finally {
    setWaitingOnUser(false);
    sendToPage(tabId, { type: 'AGENT_ASKING', on: false }, frameId).catch(() => {});
  }
}

/** Actions the extension performs itself. Returns null if this is not one. */
async function performBrowserAction({
  action,
  report,
  currentTab,
  lastObservation,
  onTabChange,
  onFrameChange,
  mayUseTab = null,
  canAttachImages = true
}) {
  switch (action.action) {
    case 'observe':
      report('Re-read the page');
      return { note: 'Re-read the page.' };

    /**
     * Step into an embedded document, or back out to the page.
     *
     * An iframe is a separate document: its fields are not in the element list
     * and nothing in it can be clicked from outside. Without a way in, an
     * embedded application form, chat widget or payment box is invisible, and
     * the model reports the page as missing the field it was asked to fill —
     * which is a confident, checkable-sounding lie.
     *
     * Entering is just a change of address. Every later message goes to that
     * frameId, so observe, click and type all land inside it and the ids they
     * use are that document's own.
     */
    case 'use_frame': {
      const index = Number(action.frame ?? action.id ?? action.index);

      if (index === 0) {
        report('Leave the frame', 'Back to the main page.');
        onFrameChange?.(null, null);
        return { frameChanged: true, note: 'Left the frame; back on the main page.' };
      }

      const listed = (lastObservation?.frames || [])[index - 1];
      if (!listed) {
        return {
          failed: true,
          note:
            `There is no frame ${index} in the last observation. Frames are ` +
            'numbered in the FRAMES list; {"action":"use_frame","frame":0} leaves.'
        };
      }

      const frames = await reachFrames(currentTab);
      const frameId = frameIdFor(frames, listed);

      if (frameId == null) {
        return {
          failed: true,
          note:
            `Could not get into frame ${index} ("${listed.name}"). It may be ` +
            'sandboxed or cross-origin in a way Chrome will not let an extension ' +
            'into. Try a screenshot and click_at instead — a coordinate reaches ' +
            'what is drawn there regardless of which document owns it.'
        };
      }

      report(`Enter frame ${index} “${listed.name}”`, 'Reading the embedded document instead of the page around it.');
      onFrameChange?.(frameId, listed);
      return {
        frameChanged: true,
        note:
          `Now inside frame ${index} “${listed.name}”. The elements you are shown ` +
          'next belong to that document. Use {"action":"use_frame","frame":0} to leave.'
      };
    }

    /**
     * Three pictures, one action, because they cost three different amounts.
     *
     * The visible screen is one capture. The whole page is one per screenful
     * with a wait between them for the capture rate limit. "Load it all first"
     * adds a walk to the bottom and back, which on a virtualised feed is
     * seconds. The model picks, and the vocabulary says what each is for —
     * making every screenshot a full one would put four seconds in front of
     * "is the button enabled yet".
     */
    case 'screenshot': {
      /**
       * This provider has already refused a picture, so do not take another.
       *
       * Refused BEFORE the capture, not after: photographing the page and then
       * failing to deliver it costs a tab activation and a paint wait, and the
       * note that came back said "the image is attached" — which is exactly the
       * sentence that had a model inventing `click_at` coordinates for a
       * screenshot it had never been shown. Saying so plainly is the whole
       * point; a bare failure would just be retried.
       */
      if (!canAttachImages) {
        report('Screenshot skipped', 'This provider refused the upload, so pictures cannot reach you.');
        return {
          note:
            'No screenshot was taken: this provider will not accept the upload, ' +
            'so you cannot be shown pictures in this run. You have NOT seen an ' +
            'image — do not describe one, and do not guess click_at coordinates. ' +
            'Work from the numbered element list and the page text, and use ' +
            'scroll and observe to find what you need.'
        };
      }

      const whole = /^(full|whole|page|full_page|fullpage)$/i.test(String(action.scope || ''));
      const load = action.load === true || /^(all|load)$/i.test(String(action.scope || ''));

      if (!whole && !load) {
        report('Take a screenshot');
        // Showing it to the user is `captureTab`'s job now — every capture in
        // a run goes through there, and half are the loop's own idea.
        const image = await captureTab(currentTab, { label: 'Agent screenshot' });
        if (!image) {
          return { failed: true, note: 'Could not capture the screen. Work from the text instead.' };
        }
        return { image, note: 'Captured the visible page. The image is attached.' };
      }

      report(load ? 'Load the whole page, then photograph it' : 'Photograph the whole page');
      const full = await captureFullTab(currentTab, {
        load,
        label: load ? 'Agent screenshot · loaded whole page' : 'Agent screenshot · whole page'
      });

      if (!full) {
        return {
          failed: true,
          note: 'Could not photograph the whole page. Try {"action":"screenshot"} for what is on screen.'
        };
      }

      return {
        image: full.dataUrl,
        note:
          `Captured the whole page as one image — ${full.screenfuls} screenful` +
          `${full.screenfuls === 1 ? '' : 's'}` +
          (load ? ', after scrolling it all into existence' : '') +
          (full.capped
            ? '. The page is longer than that: this is the top of it, so scroll and take another if what you need is below.'
            : '.') +
          ' The image is attached.'
      };
    }

    case 'wait': {
      // Capped hard: `settle` has already waited for the page, so a model
      // asking for another 10 seconds is guessing, not observing.
      const ms = Math.min(Number(action.ms) || 800, 3000);
      report(`Wait ${ms}ms`);
      await new Promise((r) => setTimeout(r, ms));
      return { note: `Waited ${ms}ms.` };
    }

    case 'navigate':
    case 'open_tab': {
      const url = String(action.url || '');
      if (!/^https?:\/\//i.test(url)) {
        report('Navigate', `Refused: “${url}” is not an http(s) URL.`);
        return { failed: true, note: `Refused: “${url}” is not an http(s) URL.` };
      }

      if (action.action === 'open_tab') {
        report(`Open ${url} in a new tab`);
        // Inside the action window, so the tab this creates is recognised as
        // the agent's. Outside it, the group guard would eject the very tab the
        // run just opened and the follower would decline to move to it.
        const tab = await duringAction(() => chrome.tabs.create({ url, active: false }));
        await waitForLoad(tab.id);
        await settle(tab.id, 5000);
        onTabChange(tab.id);
        return { tabId: tab.id, note: `Opened ${url} in a new tab.` };
      }

      report(`Go to ${url}`);
      // A navigation can hand off to a new tab of its own — an OAuth bounce, an
      // interstitial — so it counts as the agent acting for the same reason.
      await duringAction(async () => {
        await chrome.tabs.update(currentTab, { url });
        await waitForLoad(currentTab);
        await settle(currentTab, 5000);
      });
      // The overlay belongs to the document that just went away.
      await retakeControl(currentTab);
      return { note: `Navigated to ${url}.` };
    }

    case 'back': {
      report('Go back');
      await chrome.tabs.goBack(currentTab).catch(() => {});
      await waitForLoad(currentTab);
      await settle(currentTab, 5000);
      await retakeControl(currentTab);
      return { note: 'Went back.' };
    }

    /**
     * The run's OWN tabs, not every tab in the browser.
     *
     * It used to answer with `listShareableTabs()` — everything open — which is
     * an invitation the model takes: asked to fill in one form it would list
     * the browser, find something that looked related, and go and read a page
     * nobody had offered it. The list is now the working set, so "which of my
     * tabs is which" has an answer and "what else is open" does not.
     *
     * It still excludes the relay window through the same path, which matters
     * for a different reason: a provider tab is an ordinary https page, and an
     * agent that switches to one starts typing into the conversation issuing
     * its own instructions.
     */
    case 'list_tabs': {
      report('List the tabs for this task');
      const open = await listShareableTabs();
      const mine = mayUseTab ? open.filter((t) => mayUseTab(t.id)) : open;
      const listed = mine
        .map((t) => `tabId=${t.id}${t.id === currentTab ? ' (here now)' : ''} "${t.title}" ${t.url}`)
        .join('\n');
      return { note: `YOUR TABS:\n${listed || '(none)'}` };
    }

    case 'switch_tab': {
      const id = Number(action.tabId);
      report(`Switch to tab ${id}`);

      /**
       * A tab that was not given to this run is somebody else's work.
       *
       * Checked BEFORE `isUserTabId`, which only asks "is this an ordinary page
       * we could drive" — true of every tab in the browser, their inbox and
       * their bank included. Being able to reach a page is not permission to,
       * and a model that has just failed at something will reach for any
       * plausible-looking tab the vocabulary allows.
       *
       * First also because it gives the better sentence. Asked in the other
       * order, a tab id that does not exist and a tab id belonging to the user
       * both came back as "not available to work on. Use list_tabs" — which
       * reads as a transient failure and invites trying another number.
       */
      if (mayUseTab && !mayUseTab(id)) {
        return {
          failed: true,
          note:
            `Tab ${id} is not part of this task. You can only work on the tabs ` +
            'you were given — list_tabs shows them. If you need another page, ' +
            'open it yourself with open_tab, or ask the user to add it with "@".'
        };
      }

      if (!(await isUserTabId(id))) {
        return { failed: true, note: `Tab ${id} is not available to work on. Use list_tabs.` };
      }

      onTabChange(id);
      return { tabId: id, note: `Switched to tab ${id}.` };
    }

    default:
      return null;
  }
}

/**
 * Clicking, typing, selecting, scrolling — all of it inside the page.
 *
 * Planned first, then executed: the content script describes what the action
 * would do and whether it is risky, which is what the approval prompt needs in
 * order to say something more useful than "continue?".
 */
async function performPageAction({
  action,
  report,
  currentTab,
  currentFrame,
  confirm,
  policy,
  pacing
}) {
  /**
   * Let the pointer be seen arriving before the click lands.
   *
   * Before the action, not after: the point is to watch it travel TO the thing
   * it is about to touch. After the fact it is just a pause.
   */
  if (pacing) await new Promise((r) => setTimeout(r, AGENT_BEAT_MS));

  // Every page message goes to the frame the run is currently inside, so a
  // click planned from an embedded document's element list is dispatched in
  // that same document. `null` is the top frame, which is the ordinary case.
  const planned = await sendToPage(currentTab, { type: 'AGENT_PLAN', action }, currentFrame);
  if (!planned?.ok) {
    report(action.action, planned?.error || 'Could not plan that action.');
    return { failed: true, note: planned?.error || 'Could not plan that action.' };
  }

  const needsApproval =
    policy === 'confirm-all' || (policy === 'confirm-risky' && Boolean(planned.risk));

  if (needsApproval) {
    report(planned.description, 'Waiting for your approval…', planned.risk);
    const verdict = asAnswer(
      await askedOnPage(currentTab, currentFrame, () =>
        confirm({ description: planned.description, risk: planned.risk })
      )
    );

    // A typed reply to a RISK prompt is an instruction, not an approval: they
    // were asked "shall I click this" and answered with something else, so the
    // step does not run and what they said goes back for the model to act on.
    if (verdict.reply) {
      report(planned.description, `You replied: “${verdict.reply}”`);
      return {
        note:
          `The user did not approve that step. They said: ${verdict.reply}\n` +
          'Do what they asked instead.'
      };
    }

    const approved = verdict.ok;
    if (!approved) {
      report(planned.description, 'You declined this step.');
      return { note: 'The user declined that step. Do not retry it; find another way or finish.' };
    }
  } else {
    report(planned.description, '', planned.risk);
  }

  const before = (await chrome.tabs.get(currentTab).catch(() => null))?.url || '';

  /**
   * The click and everything it sets off, marked as the agent acting.
   *
   * This is the window that decides who owns a tab that appears — see
   * `agentOpened` in `page.js`. It has to cover the settle as well as the
   * dispatch: a `target="_blank"` link creates its tab a beat after the click
   * lands, and a window that closed at the dispatch would file the run's own
   * new tab as the user's.
   */
  const done = await duringAction(async () => {
    const result = await sendToPage(
      currentTab,
      {
        type: 'AGENT_ACT',
        // The model names the field; the bytes are ours to supply. It never sees
        // the data URL — a base64 CV in the prompt would be most of a turn.
        action: action.action === 'upload' ? { ...action, file: upload } : action
      },
      currentFrame
    );
    if (!result?.ok) return result;

    // A click can navigate, open a tab or just re-render. `settle` covers all
    // three: it returns the moment the page is quiet, however long that took.
    await settle(currentTab, 6000);
    return result;
  });

  if (!done?.ok) return { failed: true, note: done?.error || 'That action failed.' };

  /**
   * A click that navigated left the overlay behind with the old document.
   *
   * This is the commonest way a page changes under a run — following a search
   * result, a "Continue" button, an employer's apply link — and far more common
   * than the explicit `navigate` action. The tab is still in `controlled`, so
   * nothing re-draws anything: the new page comes up with no border and no
   * pointer, and its clicks are live again. Measured on a run that searched
   * Google mid-task: the results page carried no sign of the agent for the rest
   * of the run.
   *
   * Compared by URL rather than assumed from the action, because most clicks do
   * not navigate and re-sending the overlay on every one would restart its
   * entrance animation over and over.
   */
  const after = (await chrome.tabs.get(currentTab).catch(() => null))?.url || '';
  if (before && after && after !== before) await retakeControl(currentTab);

  // `opened` says the page answered with a list to choose from. It travels up
  // to the loop, which ends the batch there — everything planned after it was
  // planned against a page that did not have the list in it.
  return { note: done.note, opened: Boolean(done.opened) };
}
