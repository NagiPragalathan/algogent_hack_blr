/**
 * Which tabs belong to the run in flight, and how the tab strip says so.
 *
 * Split out of `page.js` because it is a different question. `page.js` answers
 * "how do I reach into a tab"; this answers "which tabs are this run's, and
 * which are the user's" — and getting that second one wrong is what made the
 * agent feel like it was taking the browser over rather than borrowing one tab
 * of it.
 *
 * Chrome's own grouping is the right vocabulary: it is the tab strip's existing
 * language for "these belong together", it colours them, and the label sits
 * where the question is actually being asked. But grouping has a behaviour
 * nobody asks for and everybody hits — **Chrome puts a newly created tab into
 * the group the active tab is in**. So opening a tab for yourself mid-run, by
 * Ctrl+T or by middle-clicking a link, dropped it into the agent's group,
 * coloured it as the agent's, and left you looking at a browser that had
 * quietly decided your new tab was part of somebody else's task. Nothing in the
 * run did that; Chrome did, and the run got the blame.
 *
 * `guardGroup` is the answer, and it is deliberately narrow: a tab CREATED into
 * our group that the run does not claim is ejected on the spot. A tab you drag
 * in afterwards is left alone, because that is a gesture with an obvious
 * meaning — you are handing the agent a page — and the two must not be confused.
 *
 * Everything here is best effort. Grouping is a nicety; a run must never fail
 * because a tab could not be moved, and `chrome.tabGroups` may be missing on an
 * older Chrome.
 */

/**
 * Group colours, chosen for what they are NOT.
 *
 * Red reads as an error on a group the user did not make, and grey and yellow
 * are the two Chrome draws with the least contrast against its own chrome. What
 * is left is six that all read as "something is happening here".
 */
const PALETTE = ['cyan', 'blue', 'purple', 'green', 'orange', 'pink'];

/**
 * The dots, which say the same thing the panel's ellipsis says.
 *
 * A group whose title never changes is furniture: you stop seeing it, and a run
 * that has hung looks exactly like one that is working. Fixed-width glyphs
 * rather than one, two and three dots — a title that changes width reflows the
 * tab strip on every tick, which is a lot of movement for a progress indicator.
 */
const WORKING = ['●∙∙', '∙●∙', '∙∙●'];
const WAITING = '✋';
const PULSE_MS = 900;

/** How much of the task fits in a tab group label before it is just a smear. */
const LABEL_CHARS = 24;

let groupId = null;
let session = null;
let pulse = null;
let frame = 0;
let waiting = false;
let createdListener = null;

/**
 * Start a run's tab session: what its group will be called and coloured.
 *
 * `claims` is the run's own answer to "is this tab mine?" — passed in rather
 * than imported, because the set of controlled tabs lives in `page.js` and
 * importing it back here would close a ring for one predicate.
 */
export function beginTabSession({ task, sessionId, claims }) {
  endTabSession();

  session = {
    label: labelFor(task),
    color: colorFor(sessionId),
    claims: typeof claims === 'function' ? claims : () => true
  };

  guardGroup();
}

/** Nothing is being driven any more: stop the pulse and drop the guard. */
export function endTabSession() {
  stopPulse();
  unguardGroup();
  session = null;
  waiting = false;
}

/**
 * The tabs a run is driving, gathered into one coloured group.
 *
 * Only when there is more than one: a single tab in a group of its own is
 * visual noise carrying no information, and it is the common case.
 */
export async function gatherTabs(tabIds) {
  try {
    if (!chrome.tabGroups || tabIds.length < 2) return;

    // Only tabs that still exist, and only within one window — Chrome cannot
    // group across windows, and a run that opened a popup may well span two.
    const tabs = (
      await Promise.all(tabIds.map((id) => chrome.tabs.get(id).catch(() => null)))
    ).filter(Boolean);
    if (tabs.length < 2) return;

    const windowId = tabs[0].windowId;
    const here = tabs.filter((t) => t.windowId === windowId).map((t) => t.id);
    if (here.length < 2) return;

    groupId = await chrome.tabs.group({ tabIds: here, ...(groupId ? { groupId } : {}) });
    await paintGroup();
    startPulse();
  } catch {
    /* the run matters; the grouping does not */
  }
}

/**
 * Hand the tabs back, ungrouped.
 *
 * A group left behind outlives the thing it described — the user is told these
 * tabs are the agent's long after the agent has finished with them, and the
 * only way out is to ungroup them by hand. Other extensions in this space leave
 * one group per session lying around and they pile up; this one does not.
 */
export async function scatterTabs() {
  const id = groupId;
  groupId = null;
  stopPulse();

  if (id == null || !chrome.tabGroups) return;

  try {
    const tabs = await chrome.tabs.query({ groupId: id });
    if (tabs.length) await chrome.tabs.ungroup(tabs.map((t) => t.id));
  } catch {
    /* nothing here is worth failing a teardown for */
  }
}

/**
 * The run has stopped to ask the user something.
 *
 * Worth its own marker: a group that is waiting on YOU and one that is waiting
 * on a provider look identical otherwise, and only one of them will ever finish
 * without you.
 */
export function setWaitingOnUser(on) {
  if (waiting === Boolean(on)) return;
  waiting = Boolean(on);
  paintGroup();
}

/* ------------------------------------------------------------------ */

/**
 * Eject a tab Chrome put in our group that this run does not claim.
 *
 * `onCreated` only. A tab dragged in later is a deliberate gesture and is left
 * where it was put; a tab that was *born* into the group never chose to be
 * there — Chrome inherited the group from whichever tab happened to be active,
 * which during a run is one of ours.
 *
 * The re-check exists because the two orderings both happen: Chrome sometimes
 * reports the group on the created tab and sometimes assigns it a tick later,
 * and a guard that only handled the first left every Ctrl+T tab in the group.
 */
function guardGroup() {
  unguardGroup();

  createdListener = (tab) => {
    if (groupId == null) return;
    if (tab.groupId === groupId) evict(tab);
    else setTimeout(() => recheck(tab.id), 80);
  };

  chrome.tabs.onCreated.addListener(createdListener);
}

function unguardGroup() {
  if (!createdListener) return;
  chrome.tabs.onCreated.removeListener(createdListener);
  createdListener = null;
}

async function recheck(tabId) {
  if (groupId == null) return;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab && tab.groupId === groupId) evict(tab);
}

function evict(tab) {
  // The run's own new tab arrives here too — `open_tab` creates it before
  // anything has had a chance to take control of it — so the claim test has to
  // be the same one the tab-following gate uses, not "is it already controlled".
  if (session?.claims(tab)) return;
  chrome.tabs.ungroup(tab.id).catch(() => {});
}

/* ------------------------------------------------------------------ */

async function paintGroup() {
  if (groupId == null || !chrome.tabGroups || !session) return;
  const marker = waiting ? WAITING : WORKING[frame % WORKING.length];
  await chrome.tabGroups
    .update(groupId, { title: `${marker} ${session.label}`, color: session.color })
    .catch(() => {
      // The group can be gone between the tick and the write — the user closed
      // its last tab, or Chrome merged it into another.
    });
}

/**
 * The dots, ticked while a group exists and stopped the moment it does not.
 *
 * A worker interval that outlives what it is animating is the mistake the
 * keep-alive is careful to avoid: it resets the idle timer, so MV3 never lets
 * the worker sleep. This one is started by `gatherTabs` and cleared by
 * `scatterTabs` and `endTabSession`, both of which run on every path out of a
 * run — and a run is holding the keep-alive open anyway for its whole duration.
 */
function startPulse() {
  if (pulse) return;
  pulse = setInterval(() => {
    if (groupId == null) return stopPulse();
    if (waiting) return;
    frame += 1;
    paintGroup();
  }, PULSE_MS);
}

function stopPulse() {
  if (!pulse) return;
  clearInterval(pulse);
  pulse = null;
}

/**
 * The group's name is the task, cut where a word ends.
 *
 * "AI agent" on every group answered a question nobody was asking — you know it
 * is the agent, the tabs are curtained and the panel is open. What you cannot
 * tell from the tab strip is WHICH task those three tabs belong to, which is
 * the thing worth six words of label. Cut mid-word it reads as a glitch, so the
 * trailing fragment goes.
 */
function labelFor(task) {
  const one = String(task || '').replace(/\s+/g, ' ').trim();
  if (!one) return 'AI agent';
  if (one.length <= LABEL_CHARS) return one;
  const cut = one.slice(0, LABEL_CHARS).replace(/\s+\S*$/, '');
  return `${cut || one.slice(0, LABEL_CHARS)}…`;
}

/**
 * One colour per panel chat, not one per run.
 *
 * Derived rather than rotated on purpose: a chat that runs three tasks keeps the
 * same colour throughout, so "the purple group is my job applications" stays
 * true across the afternoon. A rotation would recolour it every run, which is
 * movement that means nothing.
 */
function colorFor(sessionId) {
  const key = String(sessionId || '');
  if (!key) return PALETTE[0];
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return PALETTE[hash % PALETTE.length];
}
