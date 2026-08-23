import { els } from '../core/dom.js';
import { send } from '../core/port.js';
import { runsElsewhere, requestTurn, forgetRequest } from '../core/runs.js';
import { loadSession } from './history.js';

/**
 * One line for the run that is happening somewhere you are not looking.
 *
 * This is the price of letting the panel follow the tab you are on, and it has
 * to be paid: before, the panel froze on the running conversation, which was
 * awful but at least honest — you could always see what the agent was doing.
 * Free the panel without this and a run becomes invisible the moment you open
 * another tab, which is worse: tabs are moving, a curtain is up somewhere, and
 * the panel is showing an empty chat with no explanation.
 *
 * Deliberately one line with two controls and no detail. It is not a second
 * timeline — the timeline is in that conversation, one click away — it is the
 * answer to "where did that go" and the way back.
 *
 * The blocked case is the one that justifies the whole thing. A run stopped on
 * an approval cannot make progress until somebody answers it, and a question
 * asked into a conversation nobody is looking at waits forever. So a pending
 * confirm changes the wording and the colour rather than being one more thing
 * that says "working".
 */
export function renderRunning() {
  const runs = runsElsewhere();

  if (!runs.length) {
    els.running.hidden = true;
    return;
  }

  // One line, so a run waiting on an answer wins: it is the only one that
  // cannot finish by itself, and the other will still be there afterwards.
  const blocked = runs.find((r) => requestTurn(r.id)?.agent?.pendingConfirm);
  const run = blocked || runs[0];
  const waiting = Boolean(blocked);

  els.running.hidden = false;
  els.running.classList.toggle('waiting', waiting);

  els.runningWhat.textContent = waiting
    ? 'Agent needs an answer'
    : run.kind === 'agent'
      ? 'Agent working'
      : 'Waiting for a reply';

  const where = run.session.title || 'another chat';
  // "in" spelled out rather than a bullet: this line is read once, at a glance,
  // by someone who does not yet know there is another conversation at all.
  els.runningWhere.textContent = `in ${where}`;
  els.runningOpen.title = `Open “${where}”`;

  // The count when there is more than one, because "a run is going somewhere
  // else" and "two are" call for different amounts of concern.
  if (runs.length > 1) els.runningWhere.textContent += ` · +${runs.length - 1} more`;

  els.runningOpen.onclick = () => loadSession(run.session.id);

  els.runningStop.onclick = () => {
    // Stopped from here without opening it: the whole point of this bar is that
    // you are in the middle of something else.
    if (run.kind === 'agent') send({ type: 'AGENT_STOP', runId: run.id });
    else send({ type: 'CANCEL', reqId: run.id });
    forgetRequest(run.id);
  };
}
