/**
 * The panel's whole mutable state, in one object.
 *
 * Deliberately a plain object rather than a store with subscriptions: the panel
 * repaints explicitly, at the points where something actually changed, and a
 * reactive layer would hide which of those repaints is the expensive one.
 */

export const state = {
  providers: [],
  byId: {},
  active: null,
  compare: false,
  /** Every past session, newest first. */
  sessions: [],
  /** The session being added to right now. */
  session: null,
  /**
   * The tab this panel is showing the conversation for.
   *
   * A chat belongs to a tab: switch tabs and the panel switches with you, so
   * the thread in front of you is always about the page in front of you. The
   * agent is bound to it too — a run started here drives this tab and the tabs
   * it opens itself, and nothing else, so two panels working on two tabs
   * cannot reach into each other's pages.
   */
  tabId: null,
  /** That tab's title and url, for labelling the conversation. */
  tab: null,
  pageContext: null,
  busyReq: null,
  settings: {},
  /**
   * Tabs shared as context. Empty means "whatever page you are looking at",
   * which is the common case; anything else is an explicit choice.
   */
  contextTabs: [],
  /** Last tab list from the background, for filtering without a round trip. */
  knownTabs: [],
  /** A picked folder whose text files ride along with every question. */
  workspace: null,
  /**
   * Agent mode is strictly opt-in and off on every load. Nothing clicks,
   * types or navigates on a real page unless this was switched on deliberately
   * for that question — an agent that could start acting because a setting was
   * remembered from yesterday is not one you can trust to leave open.
   */
  agentMode: false,
  /** How often the agent stops to ask. Remembered; agent mode itself is not. */
  agentPolicy: 'confirm-risky',
  /** The run in flight, if any. */
  agentRunId: null,
  /** Reusable prompts, shown behind + > Browse skills. */
  skills: [],
  /**
   * The skill chosen for the next question, if any.
   *
   * Held here rather than pasted into the composer. A skill's body is a
   * paragraph — inserting it filled the box, pushed the thread off screen and
   * left you editing someone else's wording to add your own three words. The
   * composer shows `/links` and keeps your words; the body is put in front of
   * them on the way out, where the provider needs it and you do not.
   */
  skill: null,
  /** Text files attached to the next question. */
  files: [],
  /** A region of the page the user pointed at, used instead of the whole page. */
  picked: null,
  /**
   * A cropped screenshot of the page, for the questions text cannot carry — a
   * chart, a diagram, a layout that has gone wrong. Travels as an image
   * attachment on the provider's own composer, so there is room for one.
   */
  pickedImage: null,
  /**
   * A real file on its way to the provider's own uploader — a résumé, a slide
   * deck, a photo. Not read here: it is pasted into the provider's composer, so
   * a PDF is parsed by whatever ChatGPT or Claude use for uploads rather than
   * by a parser we would have to ship per format. Shares the attachment slot
   * with `pickedImage`, because a provider composer takes exactly one.
   */
  upload: null,
  /** Caret offset of the '@' that opened the tab picker, or null. */
  mentionAt: null
};

/**
 * `state.turns` reads and writes the current session's turns, so the rendering
 * code stays unaware that sessions exist at all.
 * turn: { id, question, contextTitle, providerIds, answers: {id: {...}} }
 */
Object.defineProperty(state, 'turns', {
  get: () => (state.session ? state.session.turns : []),
  set: (value) => {
    if (state.session) state.session.turns = value;
  }
});

/** Ids only need to be unique within one browser profile. */
export const uid = (prefix) => `${prefix}${Date.now()}${Math.floor(Math.random() * 1000)}`;
