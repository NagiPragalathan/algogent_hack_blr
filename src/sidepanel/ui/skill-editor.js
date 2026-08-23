import { els, make } from '../core/dom.js';
import { state } from '../core/state.js';
import { icon } from '../lib/icons.js';
import { setHint } from './hint.js';
import { saveSkills, renderSkills, hidePreset, isPreset, slugFor } from './skills.js';
import { readSkillFile, describe } from './skill-files.js';

/**
 * Writing a skill: the prompt, the command, and the files it carries.
 *
 * Saving one used to be a single button that took whatever was in the composer
 * — which is a fine way to keep a paragraph you just wrote and no way at all to
 * build "/resume": that one needs a name you choose, a command you will
 * remember, four PDFs, and the decision that you pick between them each time.
 * All four of those were unreachable, so the feature was a prompt with a
 * nickname.
 *
 * The draft is held here and only written to storage on Save. Editing in place
 * looks simpler and is the trap: a half-typed command is a command, and the '/'
 * list would offer it while you were still deciding on the name.
 */

/** Null when the sheet is shut; otherwise the skill being written. */
let draft = null;
/** The id being edited, or null for a new one. */
let editing = null;

/**
 * Open the editor, on an existing skill or on a blank one.
 *
 * A blank one starts from whatever is in the composer, because the commonest
 * way a skill is born is "that prompt worked, keep it" — the old + button did
 * only that, and losing it to a form would be a step backwards for the case it
 * served.
 */
export function openSkillEditor(skill = null) {
  editing = skill?.id ?? null;
  draft = skill
    ? { ...skill, files: [...(skill.files || [])] }
    : {
        title: '',
        slug: '',
        glyph: 'sparkle',
        hint: 'Saved by you',
        body: els.input.value.trim(),
        files: [],
        filePick: 'ask'
      };

  els.skillEditTitle.textContent = skill ? 'Edit skill' : 'New skill';
  els.skillName.value = draft.title;
  els.skillCmd.value = draft.slug;
  els.skillBody.value = draft.body;
  renderDraftFiles();
  syncPickToggle();

  els.skillsMenu.hidden = true;
  els.skillEdit.hidden = false;
  els.skillName.focus();
}

export function closeSkillEditor() {
  els.skillEdit.hidden = true;
  draft = null;
  editing = null;
}

/** Keep the draft in step with the form; the form is what you are looking at. */
export function readSkillForm() {
  if (!draft) return;
  draft.title = els.skillName.value;
  draft.slug = els.skillCmd.value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
  draft.body = els.skillBody.value;
}

/** The checkbox, drawn as a row so it matches every other choice in a sheet. */
export function togglePick() {
  if (!draft) return;
  draft.filePick = draft.filePick === 'ask' ? 'all' : 'ask';
  syncPickToggle();
}

function syncPickToggle() {
  const ask = draft?.filePick === 'ask';
  els.skillAsk.setAttribute('aria-pressed', String(ask));
  els.skillAskSub.textContent = ask
    ? 'A list opens when you type the command'
    : 'Every file goes with the question, without asking';
}

export async function addDraftFiles(fileList) {
  if (!draft) return;
  for (const file of fileList) {
    const stored = await readSkillFile(file);
    if (stored) draft.files.push(stored);
  }
  renderDraftFiles();
}

function renderDraftFiles() {
  els.skillFileList.replaceChildren();

  if (!draft.files.length) {
    els.skillFileList.append(
      make('div', 'skill-file-empty', 'No files yet — add the résumés, briefs or notes this skill should send.')
    );
    return;
  }

  for (const file of draft.files) {
    const row = make('div', 'skill-file');

    const badge = make('span', 'row-icon');
    badge.innerHTML = icon(file.kind === 'upload' ? 'folder' : 'file', 14);

    const main = make('span', 'sheet-row-main', file.name);
    main.append(make('span', 'sub', describe(file)));

    const drop = make('button', 'skill-file-drop');
    drop.innerHTML = icon('close', 11);
    drop.title = `Remove ${file.name}`;
    drop.addEventListener('click', () => {
      draft.files = draft.files.filter((f) => f !== file);
      renderDraftFiles();
    });

    row.append(badge, main, drop);
    els.skillFileList.append(row);
  }
}

/**
 * Save the draft into the library.
 *
 * A preset that has been edited becomes yours: the shipped list is data in the
 * source and cannot be written to, so the alternative is a form that accepts
 * your changes and silently discards them. The preset is hidden rather than
 * deleted, exactly as the ✕ on its row does, so an update can still add new
 * ones without resurrecting this one.
 */
export async function saveSkillDraft() {
  readSkillForm();
  if (!draft) return;

  const title = draft.title.trim() || draft.body.trim().slice(0, 40);
  if (!draft.body.trim()) {
    setHint('A skill needs a prompt — that is the part that gets sent.', 'warn');
    els.skillBody.focus();
    return;
  }

  const was = editing ? state.skills.find((s) => s.id === editing) : null;
  const fromPreset = was && isPreset(was);

  const skill = {
    ...draft,
    id: was && !fromPreset ? was.id : `k${Date.now()}`,
    title,
    // Typed by hand, or two words off the prompt — either way unique, because
    // two skills answering to one command is a '/' list where the wrong one
    // fires and nothing on screen explains why.
    slug: slugFor(draft.slug || title || draft.body, was?.id),
    hint: draft.hint || 'Saved by you',
    filePick: draft.filePick === 'all' ? 'all' : 'ask'
  };

  if (fromPreset) await hidePreset(was.id);

  const at = was ? state.skills.findIndex((s) => s.id === was.id) : -1;
  if (at >= 0) state.skills[at] = skill;
  else state.skills.unshift(skill);

  const error = await saveSkills();
  closeSkillEditor();
  renderSkills();
  els.skillsMenu.hidden = false;

  setHint(
    error
      ? `Saved in this session only — storage refused it (${error}).`
      : `Saved. Type /${skill.slug} to use it.`,
    error ? 'error' : ''
  );
}
