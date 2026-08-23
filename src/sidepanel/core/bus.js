/**
 * Three signals that would otherwise be import cycles.
 *
 * The thread renders an agent turn, so it imports the agent view; the agent
 * view sometimes needs a full thread repaint. The thread offers "ask again" on
 * a reply, but asking lives in the composer, which renders the thread. Saving a
 * session has to refresh the history drawer, which saves sessions.
 *
 * Each of those is one call in one direction, so rather than let three modules
 * import each other in a ring, they announce what happened and `app/events.js`
 * decides what that means.
 */

const target = new EventTarget();

export const emit = (name, detail) => target.dispatchEvent(new CustomEvent(name, { detail }));

export const on = (name, handler) =>
  target.addEventListener(name, (event) => handler(event.detail));

export const EVENTS = {
  /** Ask a question again — detail is the question text. */
  ASK: 'ask',
  /** Repaint the whole thread. */
  RENDER_THREAD: 'render-thread',
  /** The session list changed on disk. */
  SESSIONS_CHANGED: 'sessions-changed',
  /**
   * Something started or stopped, in this conversation or another one.
   *
   * `core/runs.js` cannot call the view that draws the "still working over
   * there" bar without core importing ui, which is the one direction this panel
   * does not allow. It announces instead.
   */
  RUNS_CHANGED: 'runs-changed',
  /**
   * Open the skill editor — detail is the skill, or null for a new one.
   *
   * The editor writes through `ui/skills.js` (the library is the one place that
   * knows what a preset is and how the list is stored), and the library's own
   * rows offer an edit button. Announcing that click is what keeps those two
   * out of a ring.
   */
  EDIT_SKILL: 'edit-skill'
};
