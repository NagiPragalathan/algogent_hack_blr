/**
 * Every element the panel talks to, looked up once.
 *
 * The markup is static — nothing here is created or destroyed at runtime — so
 * one lookup at load beats `getElementById` scattered through the render paths,
 * and a typo shows up as `undefined` here rather than as a silent no-op deep in
 * an event handler.
 */

const $ = (id) => document.getElementById(id);

export const els = {
  // topbar
  convoTitle: $('convo-title'),
  providerPill: $('provider-pill'),
  providerName: $('provider-name'),
  providerDot: $('provider-dot'),
  btnNew: $('btn-new'),
  btnHistory: $('btn-history'),
  btnMenu: $('btn-menu'),
  menu: $('menu'),

  // history drawer
  history: $('history'),
  historyList: $('history-list'),
  historyClose: $('history-close'),
  historyClear: $('history-clear'),

  // thread
  thread: $('thread'),
  topbar: document.querySelector('.topbar'),
  toLatest: $('to-latest'),

  // the attached picture, full size
  lightbox: $('lightbox'),
  lightboxImg: $('lightbox-img'),
  lightboxMeta: $('lightbox-meta'),
  lightboxClose: $('lightbox-close'),

  // a run in a conversation that is not on screen
  running: $('running'),
  runningPip: $('running-pip'),
  runningOpen: $('running-open'),
  runningWhat: $('running-what'),
  runningWhere: $('running-where'),
  runningStop: $('running-stop'),

  // context bar and its preview
  context: $('context'),
  ctxOn: $('ctx-on'),
  ctxChip: $('ctx-chip'),
  ctxTitle: $('ctx-title'),
  ctxMeta: $('ctx-meta'),
  ctxFavicon: $('ctx-favicon'),
  ctxRefresh: $('ctx-refresh'),
  ctxDismiss: $('ctx-dismiss'),
  ctxPreview: $('ctx-preview'),
  ctxBody: $('ctx-body'),
  ctxClose: $('ctx-close'),

  // composer
  composer: $('composer'),
  input: $('input'),
  /** The badge layer behind the text. See ui/composer-ink.js. */
  inputInk: $('input-ink'),
  send: $('send'),
  stop: $('stop'),
  hint: $('hint'),
  btnPlus: $('btn-plus'),
  btnAgent: $('btn-agent'),
  agentLabel: $('agent-label'),
  agentPolicy: $('agent-policy'),

  // sheets
  plusMenu: $('plus-menu'),
  plusClose: $('plus-close'),
  pickMenu: $('pick-menu'),
  pickClose: $('pick-close'),
  providerMenu: $('provider-menu'),
  providerClose: $('provider-close'),
  tabs: $('tabs'),
  btnCompare: $('btn-compare'),
  mentionMenu: $('mention-menu'),
  mentionClose: $('mention-close'),
  skillsMenu: $('skills-menu'),
  skillsClose: $('skills-close'),
  skillList: $('skill-list'),
  skillSave: $('skill-save'),

  // writing a skill
  skillEdit: $('skill-edit'),
  skillEditTitle: $('skill-edit-title'),
  skillEditClose: $('skill-edit-close'),
  skillEditCancel: $('skill-edit-cancel'),
  skillEditSave: $('skill-edit-save'),
  skillName: $('skill-name'),
  skillCmd: $('skill-cmd'),
  skillBody: $('skill-body'),
  skillFileList: $('skill-file-list'),
  skillAddFile: $('skill-add-file'),
  skillFileInput: $('skill-file-input'),
  skillAsk: $('skill-ask'),
  skillAskSub: $('skill-ask-sub'),

  // choosing between a skill's files
  skillPick: $('skill-pick'),
  skillPickTitle: $('skill-pick-title'),
  skillPickSub: $('skill-pick-sub'),
  skillPickList: $('skill-pick-list'),
  skillPickClose: $('skill-pick-close'),
  skillPickSkip: $('skill-pick-skip'),
  skillPickUse: $('skill-pick-use'),

  slashMenu: $('slash-menu'),
  slashList: $('slash-list'),
  workspaceMenu: $('workspace-menu'),
  workspaceClose: $('workspace-close'),
  workspaceLabel: $('workspace-label'),
  workspaceSub: $('workspace-sub'),
  workspaceNoneCheck: $('workspace-none-check'),

  // attaching tabs and files
  fileInput: $('file-input'),
  tabChips: $('tab-chips'),
  tabCount: $('tab-count'),
  tabList: $('tab-list'),
  tabFilter: $('tab-filter'),
  attachCount: $('attach-count'),
  btnTabs: $('btn-tabs')
};

/** `el.append(...)` with the class and text set in one go. */
export function make(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text != null) el.textContent = text;
  return el;
}
