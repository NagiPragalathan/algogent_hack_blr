import { PROVIDER_ORDER } from '../../providers/config.js';
import {
  resolveUserTab,
  focusedUserTab,
  isOrdinaryUrl,
  createUserTab
} from '../state/user-tabs.js';
import { askProvider, warmProvider } from '../transport/ask-provider.js';
import { directRunnable, directTextRunnable } from '../transport/direct/index.js';
import { holdKeepAlive, releaseKeepAlive } from '../transport/inflight.js';
import { waitForLoad, settle, releaseControl, startTabSession } from './page.js';
import { hasConversation } from '../state/conversations.js';
import { runAgent } from './index.js';

/**
 * One agent run at a time, per panel.
 *
 * Two runs would fight over the same provider conversation and the same tab,
 * and the second would read the first's replies as its own — the whole point of
 * the loop is that each observation belongs to exactly one decision.
 */
let agentRun = null;

/**
 * There used to be a single "which chat owns the agent thread" slot here.
 *
 * It was `chrome.storage.session[agentThreadSession]`, one id for the whole
 * browser, and `sameSession` compared the incoming run against it. That works
 * for exactly one conversation: with two in play every switch fails the compare,
 * opens a brand new provider thread and overwrites the slot the other one was
 * using — so going back to the first opens a new thread as well. Alternating
 * between chats produced a new provider conversation *per task*, and a Gemini
 * sidebar with one entry per thing the user had ever asked.
 *
 * The store is keyed by panel chat now (`state/conversations.js`), so the
 * question "have I got a thread here already?" answers itself and there is
 * nothing global left to get out of step.
 */

export const isAgentRunning = () => agentRun !== null;

/** How long a new run waits for one that has already been told to stop. */
const HANDOVER_MS = 8000;

/**
 * Wait out a run that is on its way down, then take the slot from it.
 *
 * A cancelled run is not a live one. `cancel()` sets `signal.cancelled` and
 * everything the loop does from that point is a no-op — but the slot is only
 * given up by the `finally`, which is several seconds away, because the step in
 * flight is a provider round trip and `signal.cancelled` is only tested between
 * steps. The panel meanwhile released the composer the instant Stop was
 * pressed, so that window is one in which typing is invited and then refused:
 * the next question came back "An agent run is already going. Stop it first.",
 * naming a button that is not on screen, in a chat that shows nothing running.
 * Measured from the report — the curtain still up on the old page, the panel on
 * a brand new chat, and no way out but reloading the extension.
 *
 * So the two cases are separated. A LIVE run still refuses: that is the guard
 * doing its job, and two of them would fight over one provider conversation. A
 * STOPPING one is waited for and then taken over whether or not it has finished
 * unwinding, because nothing it has left to do can affect anything.
 * `startAgentRun` stamps the slot with its own run object and the `finally`
 * only clears what it still owns, so the old loop cannot pull the new one's
 * slot out from under it.
 */
async function waitForStoppingRun() {
  if (!agentRun?.cancelled) return false;

  const until = Date.now() + HANDOVER_MS;
  while (agentRun && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return true;
}

/** Enough of the task to recognise which run is meant, on one line. */
const firstLine = (task) => {
  const line = String(task || '').trim().split('\n')[0];
  return line.length > 60 ? `${line.slice(0, 57)}…` : line;
};

/**
 * The answer, which is not always yes or no.
 *
 * A question like "shall I submit — and what should I put in these fields?"
 * cannot be answered with a button, and the model asks exactly that kind of
 * question the moment a task leaves anything out. So a reply can carry text,
 * and everything downstream takes `{ ok, reply }` rather than a boolean.
 */
export const resolveAgentConfirm = (approved, reply = '') =>
  agentRun?.resolveConfirm({ ok: Boolean(approved), reply: String(reply || '') });
export const cancelAgentRun = () => agentRun?.cancel();

export async function startAgentRun({ msg, settings, providers, post }) {
  /**
   * Give up before the run starts.
   *
   * AGENT_FINISHED is what releases the composer, and only the `finally` below
   * sends it — so every one of these preflight refusals would otherwise leave
   * the panel spinning on a run that never began, with no way back but a reload.
   */
  const refuse = (error) => {
    // The slot is claimed below, before any of the awaits these refusals come
    // from — so every one of them has to hand it back or the next run queues
    // behind a run that never started.
    release();
    post({ type: 'AGENT_ERROR', runId: msg.runId, error });
    post({ type: 'AGENT_FINISHED', runId: msg.runId });
  };

  /**
   * Deliberately not `refuse` — that releases the slot, and this run never
   * held it. See `waitForStoppingRun` for why a stopping run is taken over.
   */
  if (agentRun && !(await waitForStoppingRun())) {
    const what = agentRun.task ? ` — “${firstLine(agentRun.task)}”` : '';
    post({
      type: 'AGENT_ERROR',
      runId: msg.runId,
      error:
        `An agent run is already going${what}. Open the chat it belongs to from ` +
        '⏱ Recent chats and press ■ there, or wait for it to finish.'
    });
    post({ type: 'AGENT_FINISHED', runId: msg.runId });
    return;
  }

  /**
   * The slot, claimed before the first await rather than beside the loop.
   *
   * `agentRun` used to be assigned three awaits below this check, and one of
   * those is `resolveAgentTab`, which can navigate a tab and then wait five
   * seconds for it to settle. Two AGENT_RUNs arriving inside that window both
   * passed the check and both ran; the first to finish nulled the slot and
   * posted AGENT_FINISHED — releasing the panel — while the second was still
   * driving the page. Claimed here, the check and the claim are one synchronous
   * step and nothing can land between them.
   */
  const signal = { cancelled: false };
  let approve = null;
  const run = {
    // Named in the refusal above, so "which run?" is answerable from the chat
    // that is refusing rather than only from the one that is running.
    task: msg.task || '',
    cancelled: false,
    signal,
    resolveConfirm: (answer) => approve?.(answer),
    cancel() {
      run.cancelled = true;
      signal.cancelled = true;
      approve?.({ ok: false, reply: '' });
      /**
       * Their page back NOW, not when the loop unwinds.
       *
       * `releaseControl` is in the `finally`, which is a provider round trip
       * away — so for all of those seconds the curtain stayed up on a run the
       * user had already stopped, which is indistinguishable from Stop not
       * working. It is idempotent (see `page.js`), so the `finally` calling it
       * again costs nothing.
       */
      releaseControl().catch(() => {});
    }
  };
  agentRun = run;

  /** Let the slot go, but only if it is still ours. See the `finally`. */
  const release = () => {
    if (agentRun === run) agentRun = null;
  };

  const provider = providers[msg.providerId] || providers[PROVIDER_ORDER[0]];
  if (!provider) {
    refuse('No provider is enabled.');
    return;
  }

  /**
   * A greeting is not a task, and a run started on one never ends.
   *
   * Typed with Agent Mode still on from the last question, "hyy" took over the
   * browser: a start page was opened, the page was photographed, and the model
   * — handed a browser and told to act — did the only thing the vocabulary
   * allows and searched Google for "hyy". Measured: four steps and forty
   * seconds in, with a curtain over the page and nothing that could ever count
   * as finishing, because there is no goal to meet. It runs to MAX_STEPS.
   *
   * Answered rather than refused, and BEFORE `resolveAgentTab`, which navigates
   * a tab and waits up to five seconds for it to settle. A red error over a
   * greeting reads as a fault; what the person needs is the sentence that says
   * what to type instead, and their page left alone.
   *
   * Deliberately narrow — one short token, nothing else. "hi, open my gmail" is
   * a task with a greeting on the front and must still run, which is why this
   * tests the WHOLE input rather than searching it.
   */
  if (isNotATask(msg.task)) {
    release();
    post({
      type: 'AGENT_DONE',
      runId: msg.runId,
      /**
       * One line, because it is answering a greeting.
       *
       * The first version was two paragraphs with three worked examples in it —
       * a lecture, delivered every time, and delivered TWICE in a row to
       * somebody who typed "hyy" twice. The refusal is right; its volume was
       * not. Whatever is wrong here the user already knows: Agent Mode is lit,
       * they can see it, and the only thing they need is the nudge.
       */
      answer:
        'Agent Mode is on, so tell me what to do on this page — or turn it off ' +
        'to just chat.',
      steps: 0
    });
    post({ type: 'AGENT_FINISHED', runId: msg.runId });
    return;
  }

  const target = await resolveAgentTab(msg.tabId);
  if (target.error) {
    refuse(target.error);
    return;
  }

  const tab = target.tab;

  /**
   * Every tab the user handed over with '@', not just the first.
   *
   * "Take the details from @[Job ad], check them against @[My CV] and fill in
   * @[Application]" is three tabs and one task, and the run used to get exactly
   * one of them — `tabId` was `contextTabs[0]` and the rest were quietly
   * dropped into the prompt as page text, which the model could read but never
   * act on. So it read three pages and could only ever type into one.
   *
   * Resolved here, next to the primary tab, because the same rules apply: a tab
   * that has been closed since it was mentioned is staleness and is skipped, a
   * tab that cannot be driven is worth saying out loud rather than silently
   * working around. The primary stays first — it is the page the conversation
   * belongs to and where the run starts.
   */
  const working = await resolveWorkingTabs(tab, msg.tabIds);

  if (working.length > 1) {
    post({
      type: 'AGENT_STEP',
      runId: msg.runId,
      step: 0,
      kind: 'list_tabs',
      description: `Working across ${working.length} tabs`,
      note: working
        .map((t, i) => `${i + 1}. ${t.title || t.url}${i === 0 ? ' — starting here' : ''}`)
        .join('\n')
    });
  }

  // Say so in the timeline. A tab appearing in the user's window with no
  // explanation is the kind of thing that makes an agent feel out of control.
  if (target.opened) {
    post({
      type: 'AGENT_STEP',
      runId: msg.runId,
      step: 0,
      description: 'Opened a starting page',
      note: `Nothing readable was open, so the run starts from ${tab.url || AGENT_START_URL}.`
    });
  }

  // Held for the whole run, not just each provider call — the gaps between
  // steps (page settling, waiting on your approval) are worker-idle too.
  holdKeepAlive();

  let stepId = 0;

  /**
   * ONE provider conversation per panel chat. Runs join it; they never open
   * another.
   *
   * This has moved twice and it is worth knowing why, because the obvious
   * version is wrong in both directions.
   *
   * It began as "every run starts a new thread", written for a real failure: a
   * model shown its own closing paragraph above an unrelated task repeats it
   * rather than acting, which is the "finished · 0 steps" run with a confident
   * answer about a page it never looked at. Measured three times running. But
   * that also threw away the history WITHIN a conversation, so "now publish it"
   * reached a model with no idea what "it" was.
   *
   * The fix was `sameSession` — runs in one panel chat share a thread — plus
   * `NEW_TASK_BANNER` to stop the repeating. That worked, and left one thing:
   * the AGENT thread was still separate from the CHAT thread, so a single panel
   * conversation showed up in the provider's sidebar twice. Ask a question, then
   * give the same chat a task, and Gemini has "Naukri Profile Resume
   * Optimization" and "Profile Update and Skill Addition" as two unrelated
   * conversations — which is not what one chat means to anybody looking at it.
   *
   * So the scope is `chat` for both now: whatever thread this panel chat is
   * already using, a run continues it. What makes that safe is the banner
   * below, which is the same guard that already let consecutive runs share a
   * thread — the model just also sees ordinary questions above the task now
   * rather than only earlier tasks.
   *
   * Asked of the STORE rather than a remembered owner id, and per PROVIDER as
   * well as per chat: asking Gemini something in a chat whose earlier turns went
   * to ChatGPT has no Gemini thread to resume, and must not be told it has one.
   */
  const sameSession = await hasConversation(provider.id, 'chat', msg.sessionId);

  /**
   * Start opening the provider now, not when the first prompt is ready.
   *
   * A run's first prompt is several seconds away at this point — the loop still
   * has to read the page, scroll it if the task wants the whole thing, and
   * stitch a screenful-at-a-time survey picture — and every one of those seconds
   * used to pass with the provider window still shut, after which the run paid
   * for opening it as well. The two have nothing to say to each other, so they
   * run at the same time. Deliberately not awaited: see `warmProvider`.
   */
  /**
   * One transport for the whole run, decided here, once.
   *
   * A run is one accumulating conversation, and some of its turns carry a
   * screenshot. Deciding per turn would answer the text turns directly and the
   * picture turns through the window, splitting the run's history across two
   * provider threads that cannot see each other — so the model reasons across a
   * gap nothing told it about. `directRunnable` therefore asks the only
   * question that matters: can this engine deliver a picture? ChatGPT and
   * Gemini can, and a run is where the speed-up is worth most — thirty round
   * trips rather than one.
   */
  let allowDirect = directRunnable(provider, settings);

  /**
   * This provider has an engine but no uploader, so a run may go direct only if
   * it will never want a picture. The loop decides that from the page and the
   * task, once, before the first turn — see `decideTransport` below.
   */
  const blindDirectPossible = !allowDirect && directTextRunnable(provider, settings);

  /**
   * This chat belongs to the window, and so will every turn of this run.
   *
   * `hasConversation` is URL-only by design, and only the relay ever files a
   * URL — so `sameSession` being true means some earlier turn here was answered
   * through the window, which pins the whole conversation to it: the ids an API
   * call needs cannot be recovered from a page, so joining that thread the fast
   * way is not possible and opening a second one beside it would not be honest.
   *
   * Said out loud because the alternative is the question that produced this
   * comment. A run that has been fast all week opens a window on a follow-up
   * task, nothing anywhere mentions it, and the only available reading is that
   * the extension has started doing something it was told not to. The cause is
   * real, it is one turn old, and there is a way out of it — so all three are
   * worth one line in the timeline.
   */
  if (allowDirect && sameSession) {
    post({
      type: 'AGENT_STEP',
      runId: msg.runId,
      step: 0,
      description: `Using the ${provider.name} window for this chat`,
      note:
        `An earlier turn in this chat was answered through the ${provider.name} ` +
        'window, which is where that conversation now lives — its thread cannot ' +
        'be picked up over the API, and starting a second one beside it would ' +
        'split this chat in two. So this run stays on the window. Press New chat ' +
        'to start one that can use the fast path.'
    });
  }

  /**
   * Build the window while the page is being read — unless we do not yet know
   * whether one is needed.
   *
   * Warming a provider that then answers over its own API puts a window and
   * Chrome's "started debugging this browser" bar on screen for a request that
   * never uses either, which is the same complaint `strict` had to fix. So when
   * `blindDirectPossible` is open, warming waits for `decideTransport` and
   * happens there, on the branch that actually wants a page.
   */
  const warm = () =>
    warmProvider(provider, settings, {
      scope: 'chat',
      sessionId: msg.sessionId ?? null,
      fresh: !sameSession,
      allowDirect
    });

  if (!blindDirectPossible) warm();

  /**
   * One transport for the whole run, chosen before the first turn.
   *
   * Still once — that is the invariant, and it is what keeps a run's history in
   * one provider thread. What changed is only WHEN: an engine that cannot carry
   * a picture used to lose the whole run to the window on the strength of the
   * screenshots most runs never take. The loop knows whether this one will,
   * because it has just read the page and been given the task, so it answers
   * here and the answer is fixed from that moment.
   */
  const decideTransport = ({ needsVision }) => {
    if (allowDirect) return { direct: true, blind: false };

    if (!blindDirectPossible || needsVision) {
      // The window it is. Start building it now rather than at ask time — the
      // prompt still has an observation to be rendered into it.
      if (blindDirectPossible) warm();
      return { direct: false, blind: false };
    }

    allowDirect = true;
    return { direct: true, blind: true };
  };

  /**
   * The model can see the whole of this conversation above the task. Say so.
   *
   * Without it the history reads as unfinished work and the run carries on with
   * whatever was above instead of the task it was given — the exact "0 steps"
   * failure the always-fresh rule was avoiding, moved one layer along. It rides
   * on the first prompt rather than living in `loop.js` because only this layer
   * knows a thread was reused.
   *
   * Worded for BOTH kinds of history now that the two threads are one: what sits
   * above may be an earlier task or an ordinary question the user asked, and a
   * banner that only named tasks left the second case unexplained — which is the
   * case that produces "Would you like me to format your Key Projects next?"
   * where an action should have been.
   */
  const NEW_TASK_BANNER =
    'NEW TASK — and it is a BROWSER TASK, not a question to answer in prose. ' +
    'Everything above in this conversation is already over: earlier tasks, and ' +
    'ordinary questions the user asked in this same chat. Keep what you learned ' +
    'from it about this site and the user, and do NOT continue, repeat, ' +
    're-answer or offer to extend any of it. Ignore any question left open up ' +
    'there. The task below is the only thing that matters now, and your reply ' +
    'must be a single JSON action.\n\n';

  /**
   * Did the picture we sent with the last turn actually reach the provider?
   *
   * Captured from the adapter's `submitted` event, which is the only layer that
   * knows. It has to travel back to the loop: a run whose screenshots are being
   * silently dropped is far worse than a run with no screenshots at all,
   * because the model is TOLD a picture is attached and reasons from one it
   * never saw. Measured on a Naukri run against Gemini: two captures, both
   * undelivered, and the model then produced `click_at (194, 301)` — coordinates
   * invented for an imaginary screenshot, which landed on the wrong control.
   */
  let deliveredImage = null;

  /** One provider round trip. Streaming is forwarded so the panel shows life. */
  const ask = async (prompt, image = null) => {
    stepId += 1;
    deliveredImage = null;
    const result = await askProvider({
      reqId: `${msg.runId}-s${stepId}`,
      provider,
      settings,
      prompt: stepId === 1 && sameSession ? NEW_TASK_BANNER + prompt : prompt,
      image,
      /**
       * A run gets its own thread — shared with the other runs in this panel
       * chat, and never with the ordinary chat scope. See `sameSession` above
       * for why this is no longer "a new one every time"; what follows is why
       * the FIRST run of a chat still opens clean.
       *
       * Sharing the chat thread meant every run opened where the last one had
       * finished, and a model shown its own closing paragraph above a fresh
       * task repeats it rather than acting: no action parses, two misreads end
       * the run, and the panel reports "finished · 0 steps" with an answer
       * about a page it never looked at. It reproduced three times running.
       *
       * The turns after the first stay in the thread that turn opened — the
       * loop's whole design is that the plan and the observations accumulate
       * in one conversation.
       */
      // The chat's own thread. A run joins the conversation this panel chat
      // already has with this provider rather than opening a second one — see
      // `sameSession` above for why that is safe.
      scope: 'chat',
      // The chat that owns this run, so its thread is filed and resumed under
      // that chat rather than in one slot shared by the whole browser.
      sessionId: msg.sessionId ?? null,
      fresh: stepId === 1 && !sameSession,
      // Decided once for the whole run, above — never per turn. See there.
      allowDirect,
      /**
       * A run is the volume path, and the only one that can produce forty
       * requests without a person doing anything between them. `pace.js` widens
       * the floor for it — see RUN_GAP_MS there for what that costs against a
       * provider turn of ten to forty seconds.
       */
      intent: 'run',
      post: (m) => {
        /**
         * Which provider conversation this run is in, passed on to the panel.
         *
         * Everything else here is filtered down to the wait states, and this
         * used to be filtered out with them — so a chat whose only activity was
         * an agent run had an empty `session.conversationUrls` while the worker
         * had the thread filed perfectly well. The two records disagreed, and
         * the panel's empty one then overwrote the worker's on the next tab
         * switch: the next ordinary question found no thread and opened a second
         * provider conversation for the same chat. Now that runs and questions
         * share one thread, the panel has to hear about both.
         */
        if (m.type === 'CONVERSATION') {
          post({ ...m, reqId: msg.runId });
          return;
        }

        /**
         * The wait states, forwarded rather than collapsed.
         *
         * `connecting`, `ready`, `submitted` and `streaming` are four
         * different places a turn can park, and they fail for four different
         * reasons — the panel already relies on that distinction for ordinary
         * chats. An agent run showed none of it: every one of those became a
         * still step with no sign of life, so ten to forty seconds of normal
         * provider latency was indistinguishable from a hang, which is the
         * single most common reason someone presses Stop on a run that was
         * working.
         */
        if (m.type === 'STREAM' && m.state) {
          // `via` too: "waiting for the provider" and "waiting for the provider
          // in a window that just opened on your screen" are the same delay and
          // very different news, and the run is the place people watch it from.
          post({ type: 'AGENT_PHASE', runId: msg.runId, state: m.state, via: m.via || null });
        }
        if (m.type === 'STREAM' && m.state === 'streaming') {
          post({ type: 'AGENT_THINKING', runId: msg.runId, text: m.text });
        }
        // The turn that carried the user's file, reporting whether it arrived.
        // Said out loud because the run continues either way, and "I could not
        // fill in your address" is the same sentence whether the CV got there
        // or not.
        if (m.type === 'STREAM' && m.attached !== undefined) {
          deliveredImage = Boolean(m.attached);
          post({
            type: 'AGENT_ATTACHMENT',
            runId: msg.runId,
            ok: m.attached,
            notice: m.notice || null
          });
        }
      }
    });
    if (result.state !== 'done') {
      return { error: result.error || `Provider stopped: ${result.state}.` };
    }
    // `null` when the turn carried no picture — which is not the same as "it
    // failed", and the loop must not read it as one.
    return { text: result.text, imageDelivered: image ? deliveredImage : null };
  };

  const confirm = ({ description, risk, fields }) =>
    new Promise((resolve) => {
      approve = (answer) => {
        approve = null;
        // Tolerates the bare boolean too: nothing should be able to wedge a run
        // on an approval because a caller passed the older shape.
        resolve(
          answer && typeof answer === 'object' ? answer : { ok: Boolean(answer), reply: '' }
        );
      };
      post({ type: 'AGENT_CONFIRM', runId: msg.runId, description, risk, fields });
    });

  /**
   * The tab group this run's pages will live in, before any of them is taken.
   *
   * Here because this is the only layer holding both halves: the task, which
   * names the group, and the panel chat, which colours it — so the same
   * conversation keeps the same colour across the tasks you give it. It also
   * puts up the guard that keeps tabs YOU open out of that group; Chrome files
   * a new tab under whatever group the active tab is in, and during a run that
   * is one of ours. See `session-tabs.js`.
   */
  startTabSession({ task: msg.task, sessionId: msg.sessionId });

  try {
    await runAgent({
      task: msg.task,
      tabId: tab.id,
      // The whole working set, primary first. The loop needs the titles as well
      // as the ids: the model chooses a tab by name in the task it was given
      // ("fill in the application"), never by the number Chrome happens to have
      // assigned it.
      tabs: working,
      // The panel's dropdown is the live control; the stored setting is only
      // the fallback for a run started without one.
      policy: msg.policy || settings.agentPolicy || 'confirm-risky',
      upload: msg.upload || null,
      // Watching the pointer travel is what makes a run supervisable at all;
      // the setting exists for whoever would rather have the seconds back.
      pacing: settings.agentPacing !== false,
      /**
       * There was nothing to start from, so the run is on the placeholder page.
       *
       * The loop uses this to defer its survey to the page it navigates to.
       * Surveying the placeholder means scrolling, photographing and planning a
       * route across google.com, which is minutes spent describing a page the
       * task is not about — and worse, the plan it produces is then repeated on
       * every later turn as the route to follow.
       */
      blankStart: Boolean(target.opened),
      /**
       * This run is joining a thread that already holds finished work.
       *
       * NEW_TASK_BANNER says so at the TOP of the first prompt — and the top of
       * that prompt is a long way from the end of it, with the whole element
       * list and page text in between. Measured: a chat whose previous run had
       * read Gmail, given a new task, came back "The navigation to Gmail failed
       * with a 301 redirect… I will attempt to observe the current state" — the
       * model carrying on with the task before it, several steps into a run
       * that had nothing to do with Gmail.
       *
       * So the loop restates it in the TAIL of the first turn, where recency
       * works for us. Same division of labour as every other rule here that
       * appears twice: this is not belt and braces, it is the half that lands.
       */
      resumed: sameSession,
      // Called once, after the first observation and before the first ask.
      decideTransport,
      ask,
      confirm,
      signal,
      emit: (event) => post({ ...event, runId: msg.runId })
    });
  } catch (err) {
    post({ type: 'AGENT_ERROR', runId: msg.runId, error: String(err?.message || err) });
  } finally {
    /**
     * Another run holds this slot now — see `waitForStoppingRun`. Everything
     * below then belongs to IT: nulling the slot would leave the live run
     * unguarded, and `releaseControl` would take down its curtain and scatter
     * its tab group while it was still working. AGENT_FINISHED is still posted,
     * because it carries this run's id and is what releases this chat's
     * composer.
     */
    const superseded = agentRun !== run;
    if (!superseded) agentRun = null;
    releaseKeepAlive();
    // Here and nowhere else: this `finally` is the only thing that runs on
    // every path out of a run — finished, cancelled, thrown, or a preflight
    // refusal. A curtain left up is a page the user cannot click, with nothing
    // running behind it to explain why.
    if (!superseded) await releaseControl();
    post({ type: 'AGENT_FINISHED', runId: msg.runId });
  }
}

/**
 * Where a run starts when nothing usable is open.
 *
 * Not `about:blank`: it matches no content-script pattern and `executeScript`
 * cannot reach it, so the run would still die on step 0, just for a different
 * reason. A real search page is injectable, is one `navigate` away from
 * anywhere, and gives a task that names its own destination something to act on
 * straight away.
 */
const AGENT_START_URL = 'https://www.google.com/';

/**
 * The tab the agent will drive — opening one if it has to.
 *
 * Refusing outright when no ordinary page was open was wrong. The agent already
 * has `navigate` and `open_tab`, and a large share of real tasks name their own
 * starting page ("open Gmail and tell me…"), so the page that happened to be in
 * front was never needed. The cost was that a browser showing only chrome://
 * pages — exactly what you are looking at right after reloading the extension
 * from chrome://extensions — killed every run in a preflight, five times in a
 * row, for a page the task never asked about.
 *
 * A tab the user explicitly picked from the "+" sheet is different: if that page
 * cannot be driven then they pointed at the wrong thing, and quietly working
 * somewhere else is worse than saying so. Only a picked tab that has since been
 * CLOSED falls through to the search below — that is staleness, not a choice.
 */
async function resolveAgentTab(explicitTabId) {
  if (explicitTabId != null) {
    const picked = await chrome.tabs.get(explicitTabId).catch(() => null);
    if (picked) {
      const blocked = whyUnusable(picked.url || '');
      return blocked ? { error: blocked } : { tab: picked };
    }
  }

  const current = await resolveUserTab();
  if (current && !whyUnusable(current.url || '')) return { tab: current };

  /**
   * They are on a page we cannot drive — almost always the New Tab page.
   *
   * Work in THAT tab rather than opening another beside it. It is the tab they
   * are looking at, it is empty, and a task typed into a blank tab means "do
   * this here". Opening a second tab for it leaves the original sitting there
   * doing nothing, and the run happens somewhere the user has to go and find.
   */
  const focused = await focusedUserTab();
  if (focused.blocked && focused.tab?.id != null) {
    await chrome.tabs.update(focused.tab.id, { url: AGENT_START_URL }).catch(() => {});
    await waitForLoad(focused.tab.id);
    await settle(focused.tab.id, 5000);
    const tab = await chrome.tabs.get(focused.tab.id).catch(() => null);
    if (tab && !whyUnusable(tab.url || '')) return { tab, opened: true };
  }

  const opened = await openStartTab();
  if (!opened) return { error: 'Could not open a page for the agent to work on.' };

  // Hand the loop a page that has finished moving: its first observation is not
  // retried, so observing a half-built document costs the whole run.
  await waitForLoad(opened.id);
  await settle(opened.id, 5000);

  // Re-read it for the settled URL — a freshly created tab reports none yet.
  const tab = await chrome.tabs.get(opened.id).catch(() => opened);
  return { tab, opened: true };
}

/**
 * Input with no task in it: a greeting, an acknowledgement, a stray keystroke.
 *
 * Matched against the WHOLE input, trimmed of punctuation — never searched for
 * inside it — because "hi, open my gmail" is a real task and must run. One
 * token only, and a short one: anything with a space in it has been given the
 * benefit of the doubt since a two-word instruction ("open gmail") is a task
 * and a two-word greeting costs nothing but one refusal to act.
 *
 * Repeated letters are the point of the character classes. What people actually
 * type is "hyy", "hii", "heyyy", "helloo", "okkk" — a fixed word list catches
 * none of them, which is how "hyy" reached the browser in the first place.
 */
const NOT_A_TASK =
  /^(?:h+[aeiy]+[aeiyh]*|hey+|hell?o+|hlo+|yo+|sup|wass?up|ok+(?:ay+)?|kk*|thanks*|thx|ty|tq|test+|hmm+|hm+|asdf+|qwerty+|lol+|nvm|nothing|nil|na|no|yes|yeah|yep|yup|nope|bye+|gm|gn)$/i;

export function isNotATask(task) {
  const text = String(task || '')
    .trim()
    .replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, '')
    .trim();

  // Nothing at all, or a line of punctuation: also not a task.
  if (!text) return true;
  if (/\s/.test(text)) return false;
  return text.length <= 12 && NOT_A_TASK.test(text);
}

/**
 * The tabs this run may work on: the one it starts from, plus the ones named.
 *
 * Deliberately a closed list. The agent has `list_tabs` and could in principle
 * find any page in the browser, and letting it do so is how a run that was
 * asked to fill in one form ends up reading a banking tab that happened to be
 * open. A tab is part of the task because the user said so with '@' — or
 * because the run opened it itself, which `page.js` tracks separately.
 *
 * Silently dropped rather than refused: a mention can outlive the tab it named
 * (closed, or navigated to a PDF), and killing the whole run over one stale
 * reference is a worse answer than doing the task with the tabs that are left.
 * The step note in `startAgentRun` lists what survived, so it is never a
 * surprise.
 */
async function resolveWorkingTabs(primary, tabIds) {
  const out = [describeTab(primary)];
  const seen = new Set([primary.id]);

  for (const id of Array.isArray(tabIds) ? tabIds : []) {
    if (seen.has(id)) continue;
    seen.add(id);
    const tab = await chrome.tabs.get(id).catch(() => null);
    if (!tab || whyUnusable(tab.url || '')) continue;
    out.push(describeTab(tab));
  }

  return out;
}

const describeTab = (tab) => ({
  id: tab.id,
  title: tab.title || tab.url || 'Untitled',
  url: tab.url || ''
});

/**
 * Put the start page in one of the user's own windows.
 *
 * The rule itself lives in `createUserTab` now, because `open_tab` needed it
 * just as much and did not have it — the whole reasoning is written down there.
 * In short: a bare `tabs.create` goes to the last focused window, which is the
 * relay whenever the extension has just been driving a provider.
 */
const openStartTab = () => createUserTab(AGENT_START_URL, { active: false });

/**
 * Pages the agent physically cannot read, named plainly.
 *
 * Left to itself the model infers *something* from an empty observation and
 * reports that instead — a confident explanation of the wrong problem. These are
 * common enough, and fixable enough, to be worth saying outright.
 */
function whyUnusable(url) {
  if (/^file:/i.test(url)) {
    return (
      'This is a local file. Chrome blocks extensions from reading file:// ' +
      'pages until you turn on “Allow access to file URLs” for this extension ' +
      'on chrome://extensions — and Chrome renders PDFs in a plugin with no ' +
      'readable text even then. Paste the details into the chat instead.'
    );
  }

  if (/\.pdf($|[?#])/i.test(url)) {
    return (
      'Chrome shows PDFs through a plugin that exposes no page content, so ' +
      'there is nothing here for the agent to read or click.'
    );
  }

  if (!isOrdinaryUrl(url)) {
    return (
      `The agent cannot work on ${url || 'this page'} — Chrome does not let ` +
      'extensions read its own pages or the Web Store. Switch to an ordinary ' +
      'http(s) tab and ask again.'
    );
  }

  return null;
}
