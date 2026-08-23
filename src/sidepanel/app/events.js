import { els } from '../core/dom.js';
import { state } from '../core/state.js';
import { send } from '../core/port.js';
import { on, EVENTS } from '../core/bus.js';
import {
  newSession,
  saveThread,
  forgetAllSessions,
  bindCurrentTab
} from '../core/sessions.js';
import { setHint, flashHint } from '../ui/hint.js';
import { renderProviderSheet, targetProviders, toggleCompare } from '../ui/providers.js';
import { renderThread } from '../ui/thread.js';
import { syncScrollState, jumpToLatest } from '../ui/scroll.js';
import { setAgentMode, POLICY_HINT } from '../ui/agent.js';
import { renderHistory } from '../ui/history.js';
import { refreshContext, contextPreviewText, queueContextRefresh } from '../ui/context.js';
import { renderTabPicker, renderTabChips, openTabSheet } from '../ui/tab-picker.js';
import { paintInk, syncTokens } from '../ui/composer-ink.js';
import { syncMentionMenu } from '../ui/mentions.js';
import { syncSlashMenu, handleSlashKey, closeSlashMenu } from '../ui/slash.js';
import { renderSkills } from '../ui/skills.js';
import {
  openSkillEditor,
  closeSkillEditor,
  saveSkillDraft,
  addDraftFiles,
  readSkillForm,
  togglePick
} from '../ui/skill-editor.js';
import { closeSkillFiles, useSkillFiles } from '../ui/skill-files.js';
import { attachFiles, closeShot, renderAttachmentChips } from '../ui/attachments.js';
import { chooseWorkspace, clearWorkspace } from '../ui/workspace.js';
import { ask, autosize, stopEverything, syncComposer } from '../ui/composer.js';
import { renderRunning } from '../ui/running.js';

/**
 * Every listener the panel installs, in one place.
 *
 * Keeping the wiring out of the view modules means each of those stays a set of
 * functions you can read top to bottom, and this file is the single answer to
 * "what happens when I click that?".
 */
export function bindEvents() {
  bindBus();
  bindThread();
  bindComposer();
  bindAgentControls();
  bindContextBar();
  bindPlusMenu();
  bindSkillSheets();
  bindTabPicker();
  bindProviderSheet();
  bindTopbar();
  bindHistoryDrawer();
  bindOverflowMenu();
  bindDismissals();
  bindPanelFocus();
  bindBrowserEvents();
}

/** The cross-module signals — see core/bus.js for why they exist. */
function bindBus() {
  on(EVENTS.ASK, (question) => ask(question));
  on(EVENTS.RENDER_THREAD, () => renderThread());
  on(EVENTS.SESSIONS_CHANGED, () => {
    if (!els.history.hidden) renderHistory();
  });
  on(EVENTS.EDIT_SKILL, (skill) => openSkillEditor(skill));
  on(EVENTS.RUNS_CHANGED, () => {
    renderRunning();
    // The drawer marks live chats, so it is stale the moment one starts or
    // stops — and it is open precisely when someone is looking for one.
    if (!els.history.hidden) renderHistory();
  });
}

/**
 * The thread's own scroll position is a control surface: it decides whether the
 * jump button is offered and whether the topbar separates itself. `passive`
 * because neither ever calls preventDefault, and a non-passive scroll listener
 * on the one element that scrolls is how a panel starts feeling heavy.
 */
function bindThread() {
  els.thread.addEventListener('scroll', syncScrollState, { passive: true });
  els.toLatest.addEventListener('click', jumpToLatest);

  /**
   * Copy, for every code block there will ever be.
   *
   * Delegated rather than bound per block: an answer's markup is rebuilt on
   * every streamed delta, so handlers attached to a block would be discarded
   * several times a second — and the block you are trying to copy from is
   * usually one that is still arriving.
   */
  els.thread.addEventListener('click', async (event) => {
    const button = event.target.closest('.code-copy');
    if (!button) return;

    const code = button.closest('.code-block')?.querySelector('code');
    if (!code) return;

    // `textContent`, not innerText: the highlighter wraps tokens in spans, and
    // innerText would render them through layout and lose leading indentation.
    await navigator.clipboard.writeText(code.textContent).catch(() => {});

    const label = button.querySelector('span');
    if (!label || button.classList.contains('copied')) return;
    const was = label.textContent;
    label.textContent = 'Copied';
    button.classList.add('copied');
    setTimeout(() => {
      label.textContent = was;
      button.classList.remove('copied');
    }, 1400);
  });
}

function bindComposer() {
  els.input.addEventListener('input', () => {
    autosize();
    /**
     * The text is the truth, so it is read back before anything else.
     *
     * Badges are ordinary characters, which is what makes them editable — and
     * it means the attachments have to be re-derived from what is actually in
     * the box. Backspacing over `@[Job ad]` detaches that tab; rubbing out
     * `/summarise` disarms the skill. A list maintained alongside the text
     * would drift the first time anybody edited it, and it would drift in the
     * direction that matters: still attached, no longer visible.
     */
    if (syncTokens()) {
      renderTabChips();
      renderAttachmentChips();
    }
    paintInk();
    syncMentionMenu();
    syncSlashMenu();
  });

  // The layer only lines up while it is scrolled to the same place. A long
  // question scrolls the textarea inside its 120px cap, and without this the
  // badges stay behind at the top while their words move.
  els.input.addEventListener('scroll', paintInk, { passive: true });

  els.input.addEventListener('keydown', (e) => {
    // The '/' list gets first refusal on Enter, Tab, the arrows and Escape.
    // "/sum" is not a question, and sending it is exactly what the list exists
    // to prevent — so this has to come before the send.
    if (handleSlashKey(e)) return;

    /**
     * Backspace used to be the only way to disarm a skill from the keyboard,
     * and it worked only on an empty composer — because the skill lived
     * nowhere but a chip. Now `/summarise` is text: Backspace over it deletes
     * characters like anything else and `syncTokens` notices, so the special
     * case is gone. This is the leftover for a skill armed before the badge
     * existed, in a composer that really is empty.
     */
    if (e.key === 'Backspace' && !els.input.value && state.skill) {
      e.preventDefault();
      state.skill = null;
      renderAttachmentChips();
      return;
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      ask(els.input.value);
    }
  });

  // Clicking away, or moving the caret off the end of the token, closes it.
  els.input.addEventListener('blur', () => setTimeout(closeSlashMenu, 0));
  els.input.addEventListener('click', () => syncSlashMenu());

  els.send.addEventListener('click', () => ask(els.input.value));
  els.stop.addEventListener('click', stopEverything);

  // Suggestion chips are rendered inside the greeting, so delegate.
  els.thread.addEventListener('click', (e) => {
    const prompt = e.target.closest('button[data-prompt]')?.dataset.prompt;
    if (prompt) ask(prompt);
  });
}

function bindAgentControls() {
  els.btnAgent.addEventListener('click', () => {
    setAgentMode(!state.agentMode);
    setHint(
      state.agentMode
        ? 'Agent mode on — this question can click, type and navigate on the page.'
        : ''
    );
  });

  els.agentPolicy.addEventListener('change', () => {
    state.agentPolicy = els.agentPolicy.value;
    setHint(
      POLICY_HINT[state.agentPolicy] || '',
      state.agentPolicy === 'auto' ? 'warn' : ''
    );
    saveThread();
  });
}

function bindContextBar() {
  els.ctxOn.addEventListener('change', () => {
    els.context.classList.toggle('off', !els.ctxOn.checked);
    if (els.ctxOn.checked) refreshContext();
  });

  els.ctxRefresh.addEventListener('click', refreshContext);

  // The ✕ on the sharing bar is the visible form of the ctx-on checkbox.
  els.ctxDismiss.addEventListener('click', () => {
    els.ctxOn.checked = false;
    els.context.classList.add('off');
    state.contextTabs = [];
    renderTabChips();
  });

  els.ctxChip.addEventListener('click', () => {
    els.ctxBody.textContent = contextPreviewText();
    els.ctxPreview.hidden = !els.ctxPreview.hidden;
  });

  els.ctxClose.addEventListener('click', () => (els.ctxPreview.hidden = true));
}

/** "+" — add a skill, a file, a folder, or a region of the page. */
function bindPlusMenu() {
  els.btnPlus.addEventListener('click', (e) => {
    e.stopPropagation();
    els.providerMenu.hidden = true;
    els.mentionMenu.hidden = true;
    els.plusMenu.hidden = !els.plusMenu.hidden;
  });

  els.plusClose.addEventListener('click', () => (els.plusMenu.hidden = true));

  els.plusMenu.addEventListener('click', (e) => {
    const action = e.target.closest('[data-add]')?.dataset.add;
    if (!action) return;

    /**
     * Stop here, or this click closes what it just opened.
     *
     * Every row below hands off to another sheet, and the document-level
     * dismissal runs after this handler on the way up — it sees a click that
     * landed outside the skills sheet (it landed in the + sheet) and hides it
     * again, in the same tick it appeared. Browse skills, Workspace and Select
     * from screen all opened and vanished; the sheets looked broken and the
     * feature looked missing.
     */
    e.stopPropagation();
    els.plusMenu.hidden = true;

    if (action === 'skills') {
      renderSkills();
      els.skillsMenu.hidden = false;
    } else if (action === 'files') {
      els.fileInput.click();
    } else if (action === 'workspace') {
      els.workspaceMenu.hidden = false;
    } else if (action === 'screen') {
      els.pickMenu.hidden = false;
    }
  });

  els.pickClose.addEventListener('click', () => (els.pickMenu.hidden = true));

  els.pickMenu.addEventListener('click', (e) => {
    const how = e.target.closest('[data-pick]')?.dataset.pick;
    if (!how) return;
    els.pickMenu.hidden = true;

    // The page the panel says it is sharing is the page the picker opens on.
    // Without this it lands on "whatever is active", which after an answer
    // arrives can be the provider's own tab.
    const tabId = state.contextTabs[0]?.id ?? null;

    if (how === 'visual') {
      setHint('Drag a box over the part you want to send. Esc cancels.');
      send({ type: 'PICK_REGION', tabId });
    } else {
      setHint('Click the part of the page you want to send. Esc cancels.');
      send({ type: 'PICK_ELEMENT', tabId });
    }
  });

  els.skillsClose.addEventListener('click', () => (els.skillsMenu.hidden = true));
  // "+" writes a new one, starting from whatever is in the composer. It used to
  // save that text on the spot, which is no way to build a skill that carries
  // four résumés and a command you chose.
  els.skillSave.addEventListener('click', () => openSkillEditor(null));

  els.fileInput.addEventListener('change', async () => {
    await attachFiles([...els.fileInput.files]);
    els.fileInput.value = '';
  });

  bindDropAndPaste();

  els.workspaceClose.addEventListener('click', () => (els.workspaceMenu.hidden = true));

  els.workspaceMenu.addEventListener('click', async (e) => {
    const choice = e.target.closest('[data-workspace]')?.dataset.workspace;
    if (!choice) return;
    els.workspaceMenu.hidden = true;
    if (choice === 'none') clearWorkspace();
    else await chooseWorkspace();
  });
}

/**
 * The two sheets a skill's files need: the form that writes them, and the list
 * that chooses between them.
 *
 * Neither is in the outside-click dismissal below, and that is deliberate.
 * Every other sheet is a menu — one click, one outcome, and closing it by
 * accident costs a click. These two are unfinished work: the form holds a
 * prompt you are still typing, and the picker is the second half of a `/resume`
 * that is already sitting in the composer. Losing either to a stray click
 * leaves the question armed with no file, which is the failure the picker
 * exists to prevent.
 */
function bindSkillSheets() {
  els.skillEditClose.addEventListener('click', closeSkillEditor);
  els.skillEditCancel.addEventListener('click', closeSkillEditor);
  els.skillEditSave.addEventListener('click', saveSkillDraft);

  // The draft is read back from the form on every keystroke for the same reason
  // the composer re-reads its own text: what is on screen is the truth, and a
  // copy kept alongside it drifts the moment anyone edits one of them.
  for (const field of [els.skillName, els.skillCmd, els.skillBody]) {
    field.addEventListener('input', readSkillForm);
  }

  els.skillAsk.addEventListener('click', togglePick);

  els.skillAddFile.addEventListener('click', () => els.skillFileInput.click());
  els.skillFileInput.addEventListener('change', async () => {
    await addDraftFiles([...els.skillFileInput.files]);
    // Cleared, or choosing the same file twice in a row fires no change event.
    els.skillFileInput.value = '';
  });

  els.skillPickClose.addEventListener('click', closeSkillFiles);
  // "Send without a file" is not a cancel: the command is already in the box
  // and the prompt alone is a complete question — that is what makes a skill
  // worth keeping. Closing without saying so would leave people deleting the
  // command and typing it again.
  els.skillPickSkip.addEventListener('click', closeSkillFiles);
  els.skillPickUse.addEventListener('click', useSkillFiles);
}

/**
 * Dropping a file on the panel, and pasting a picture into it.
 *
 * The same two gestures people already use on every chat app, and until now the
 * panel answered neither: a dragged CV navigated the panel to `file:///…` and
 * took the conversation with it — Chrome's default for a dropped file is to
 * open it — and Ctrl+V of a screenshot pasted nothing at all, because the
 * clipboard's image never touches `input.value`.
 *
 * Bound on the document, not the composer: the drop target people aim at is
 * "the panel", and a 40px-tall textarea is a hard thing to hit while dragging.
 */
function bindDropAndPaste() {
  let depth = 0;

  // dragenter/dragleave fire for every element the pointer crosses, so a
  // counter is the only way to know when the file has really left the panel —
  // watching `dragleave` alone flickers the overlay on every inner border.
  const enter = (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth += 1;
    document.body.classList.add('dropping');
  };

  const leave = () => {
    depth = Math.max(0, depth - 1);
    if (!depth) document.body.classList.remove('dropping');
  };

  document.addEventListener('dragenter', enter);
  document.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    // Both halves are needed: without preventDefault the browser navigates to
    // the file on drop, and without `copy` the cursor says "no entry" the whole
    // way in.
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  document.addEventListener('dragleave', leave);

  document.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    document.body.classList.remove('dropping');
    await attachFiles([...e.dataTransfer.files]);
  });

  /**
   * A pasted picture becomes an attachment; pasted text goes in the composer —
   * wherever in the panel the paste actually landed.
   *
   * Bound on the document rather than on the textarea, for the same reason the
   * drop is: what people aim at is "the panel". A click on the thread, on a
   * button, or on one of the empty-state cards leaves `document.body` holding
   * the focus, and Chrome dispatches the paste THERE — so the textarea's own
   * listener never ran and Ctrl+V did nothing whatsoever, with the composer
   * still wearing the focus ring `boot()` gave it. That reads as a panel that
   * refuses pastes, and the next move it invites is to try somewhere that does
   * not refuse them: the address bar, which is where the reported task text
   * ended up, three times over.
   *
   * A field that can take the paste itself keeps it — a sheet's filter, the
   * skill editor's prompt. The composer is the one exception and only for
   * files, because `preventDefault` on its text would break pasting a paragraph
   * into the box this panel exists for.
   */
  document.addEventListener('paste', async (e) => {
    const inComposer = e.target === els.input;
    if (isEditable(e.target) && !inComposer) return;

    const files = [...(e.clipboardData?.files || [])];
    if (files.length) {
      e.preventDefault();
      await attachFiles(files);
      return;
    }

    if (inComposer) return;

    const text = e.clipboardData?.getData('text/plain') || '';
    if (!text) return;
    e.preventDefault();
    insertIntoComposer(text);
  });
}

/** A control that owns its own paste, and must keep it. */
const isEditable = (node) =>
  node instanceof HTMLElement &&
  (node.isContentEditable || /^(input|textarea|select)$/i.test(node.tagName));

/**
 * Put text in the composer as though it had been typed there.
 *
 * `execCommand` rather than assigning `value`: it keeps the undo stack, it
 * replaces a selection, and it fires `input` itself — which is where every
 * piece of composer bookkeeping already lives (autosize, `syncTokens`, the ink
 * layer, the '@' and '/' menus). Reproducing that list here is how the two ends
 * drift apart, and the drift would be silent: a badge painted for a token the
 * state no longer holds. The assignment below is the fallback for the day the
 * deprecated call goes, and dispatches `input` by hand for the same reason.
 */
function insertIntoComposer(text) {
  els.input.focus();
  if (document.execCommand('insertText', false, text)) return;

  const el = els.input;
  const from = el.selectionStart ?? el.value.length;
  const to = el.selectionEnd ?? from;
  el.value = el.value.slice(0, from) + text + el.value.slice(to);
  el.selectionStart = el.selectionEnd = from + text.length;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');

function bindTabPicker() {
  els.mentionClose.addEventListener('click', () => {
    els.mentionMenu.hidden = true;
    state.mentionAt = null;
  });

  els.tabFilter.addEventListener('input', () => renderTabPicker());

  els.btnTabs.addEventListener('click', (e) => {
    e.stopPropagation();
    if (els.mentionMenu.hidden) openTabSheet();
    else els.mentionMenu.hidden = true;
  });
}

function bindProviderSheet() {
  els.providerPill.addEventListener('click', (e) => {
    e.stopPropagation();
    els.plusMenu.hidden = true;
    els.providerMenu.hidden = !els.providerMenu.hidden;
    if (!els.providerMenu.hidden) renderProviderSheet();
  });

  els.providerClose.addEventListener('click', () => (els.providerMenu.hidden = true));

  els.btnCompare.addEventListener('click', () => {
    setHint(toggleCompare() ? 'Every enabled provider will answer each question.' : '');
  });
}

function bindTopbar() {
  els.btnNew.addEventListener('click', async () => {
    for (const id of targetProviders()) send({ type: 'NEW_CHAT', providerId: id, sessionId: state.session?.id ?? null });

    // Bank the current session before starting a blank one, so it stays
    // reachable from history rather than being thrown away.
    await saveThread();
    state.session = newSession();
    // "New chat" replaces the chat for the tab you are on, not for all of
    // them: leaving the old binding in place would show the previous
    // conversation again the moment you came back to this tab.
    await bindCurrentTab(state.session.id);
    renderThread();
    // A blank chat has nothing of its own in flight, so the composer comes back
    // even if the chat you just banked is still running.
    syncComposer();
    renderRunning();
    await saveThread();
    flashHint('Started a new chat. The previous one is in history (◷).', 3000);
  });

  els.btnHistory.addEventListener('click', () => {
    els.history.hidden = !els.history.hidden;
    if (!els.history.hidden) renderHistory();
  });
}

function bindHistoryDrawer() {
  els.historyClose.addEventListener('click', () => (els.history.hidden = true));

  els.historyClear.addEventListener('click', async () => {
    await forgetAllSessions();
    send({ type: 'SET_CONVERSATIONS', sessionId: state.session?.id ?? null, urls: {} });
    renderHistory();
    renderThread();
  });
}

function bindOverflowMenu() {
  els.btnMenu.addEventListener('click', (e) => {
    e.stopPropagation();
    els.menu.hidden = !els.menu.hidden;
  });

  els.menu.addEventListener('click', (e) => {
    const action = e.target.closest('button')?.dataset.action;
    if (!action) return;
    els.menu.hidden = true;

    switch (action) {
      case 'show-relay':
        return send({ type: 'SHOW_RELAY', providerId: state.active });
      case 'hide-relay':
        return send({ type: 'HIDE_RELAY' });
      case 'close-relay':
        return send({ type: 'CLOSE_RELAY' });
      case 'compare':
        return els.btnCompare.click();
      case 'open-conversation':
        return send({ type: 'OPEN_CONVERSATION', providerId: state.active, sessionId: state.session?.id ?? null });
      case 'clear':
        state.turns = [];
        renderThread();
        saveThread();
        return;
      case 'options':
        return chrome.runtime.openOptionsPage();
      default:
        return;
    }
  });
}

/** Clicking anywhere else dismisses whichever popover is open. */
function bindDismissals() {
  // The picture, full size. Anywhere outside it closes it, including the
  // backdrop — a preview you have to hunt for the X to leave is a modal.
  els.lightboxClose.addEventListener('click', closeShot);
  els.lightbox.addEventListener('click', (e) => {
    if (e.target === els.lightbox) closeShot();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    // Topmost first: the picker opens over the skills sheet, and the editor
    // over both.
    if (!els.lightbox.hidden) closeShot();
    else if (!els.skillEdit.hidden) closeSkillEditor();
    else if (!els.skillPick.hidden) closeSkillFiles();
  });

  document.addEventListener('click', (e) => {
    els.menu.hidden = true;

    if (!els.plusMenu.contains(e.target)) els.plusMenu.hidden = true;
    if (!els.providerMenu.contains(e.target)) els.providerMenu.hidden = true;
    if (!els.skillsMenu.contains(e.target)) els.skillsMenu.hidden = true;
    if (!els.workspaceMenu.contains(e.target) && !els.plusMenu.contains(e.target)) {
      els.workspaceMenu.hidden = true;
    }

    // Clicking back into the composer must not dismiss the '@' list — that is
    // where you are typing the query it is filtering on.
    if (
      !els.mentionMenu.contains(e.target) &&
      e.target !== els.input &&
      !els.btnTabs.contains(e.target)
    ) {
      els.mentionMenu.hidden = true;
      state.mentionAt = null;
    }
  });
}

/**
 * The composer may only look focused while the panel really is focused.
 *
 * `:focus` outlives the window losing focus, and `boot()` focuses the composer
 * the instant the panel opens — so a panel nobody has clicked yet draws a lit,
 * ready-looking box while every keystroke goes to whatever the BROWSER has the
 * focus on. Opening the panel from the toolbar leaves that on the omnibox,
 * which is how a task meant for the composer ends up in the address bar with
 * the composer glowing beside it, three pastes deep. Nothing here can take the
 * focus back from the omnibox; what it can do is stop claiming to hold it.
 *
 * The other half is that once a click does bring the panel forward, the caret
 * goes back to the composer — but only if nothing inside the panel has taken
 * it. `document.body` holding the focus is a panel you can neither type into
 * nor paste into, and it is what a click on the thread or on the background
 * leaves behind. A field in a sheet, or the skill editor's prompt, is left
 * alone: this fires on the way back from an alt-tab too, and a caret that jumps
 * out of the form you were filling in is worse than the ring ever was.
 */
function bindPanelFocus() {
  const paint = () => document.body.classList.toggle('unfocused', !document.hasFocus());

  window.addEventListener('blur', paint);
  window.addEventListener('focus', () => {
    paint();
    const active = document.activeElement;
    if (!active || active === document.body) els.input.focus();
  });

  paint();
}

function bindBrowserEvents() {
  chrome.tabs.onActivated.addListener(queueContextRefresh);
  chrome.tabs.onUpdated.addListener((_id, info, tab) => {
    if (!tab.active) return;
    if (info.status === 'complete' || info.url) queueContextRefresh();
  });
}
