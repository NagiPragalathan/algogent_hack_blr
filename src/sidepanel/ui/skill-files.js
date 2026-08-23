import { els, make } from '../core/dom.js';
import { state } from '../core/state.js';
import { icon } from '../lib/icons.js';
import { setHint } from './hint.js';
import {
  fileKind,
  readAsDataUrl,
  renderAttachmentChips,
  MAX_FILES,
  TEXT_LIMIT
} from './attachments.js';

/**
 * The files a skill carries, and the moment you choose between them.
 *
 * A skill was a prompt and nothing else, which is most of what makes one
 * reusable and not all of it: "tailor this CV to the job on screen" is the same
 * paragraph every time and a *different file* every time. Attaching the file by
 * hand each time is the part people stop doing, so the prompt gets sent without
 * it and the answer is written about a CV the model never saw — a failure with
 * no symptom, since the reply is fluent either way.
 *
 * So a skill keeps its own reference files, and `filePick` says what happens to
 * them when you type its command:
 *
 *   'ask'  the sheet below opens and you choose. This is the résumé case — the
 *          skill is a library and the point is to pick one of them.
 *   'all'  every file rides along silently. This is the style-guide case, where
 *          the files ARE the skill and choosing would be a question with one
 *          answer.
 *
 * They are sorted the same way the composer sorts a dragged file, by
 * `fileKind`: a `.md` is read here and inlined in the prompt, a PDF or a
 * screenshot is handed to the provider's own uploader. Nothing here is a new
 * road to the provider — everything ends up in `state.files` or `state.upload`,
 * which is what `ask()` already sends and what the chips already draw.
 */

/**
 * Per-file ceiling for something we are going to keep.
 *
 * The composer's own limit is 20MB for a file that lives for one question; this
 * one is stored, re-serialised on every skill edit, and is base64 in
 * `storage.local` where the whole library shares one write. A 10MB résumé does
 * not exist.
 */
const STORE_LIMIT = 10 * 1024 * 1024;

/** Read a chosen file into the shape a skill stores. */
export async function readSkillFile(file) {
  const name = file.name || 'file';

  if (file.size > STORE_LIMIT) {
    setHint(`${name} is too big to keep with a skill (limit ${STORE_LIMIT / 1024 / 1024}MB).`, 'error');
    return null;
  }

  const kind = fileKind(file);
  try {
    const body =
      kind === 'upload'
        ? { dataUrl: await readAsDataUrl(file) }
        : { text: (await file.text()).slice(0, TEXT_LIMIT) };

    return { id: `f${Date.now()}${Math.floor(Math.random() * 1000)}`, name, type: file.type || '', size: file.size, kind, ...body };
  } catch {
    setHint(`Could not read ${name}.`, 'error');
    return null;
  }
}

/**
 * Put a skill's files where the composer already looks for attachments.
 *
 * `fromSkill` is stamped on each one and is load-bearing twice over: the chip
 * says which command brought the file, and `syncTokens` takes them away again
 * when you rub the command out of the box — a file you never chose on its own
 * must not outlive the badge that carried it.
 */
export function armSkillFiles(skill, files) {
  let uploads = 0;
  let last = '';
  let full = 0;

  for (const file of files) {
    if (file.kind === 'upload') {
      uploads += 1;
      last = file.name;
      state.upload = {
        name: file.name,
        type: file.type || '',
        size: file.size,
        dataUrl: file.dataUrl,
        fromSkill: skill.slug
      };
      continue;
    }

    if (state.files.length >= MAX_FILES) {
      full += 1;
      continue;
    }
    state.files.push({
      name: file.name,
      text: (file.text || '').slice(0, TEXT_LIMIT),
      fromSkill: skill.slug
    });
  }

  renderAttachmentChips();

  // One attachment slot, because a provider composer has one. Silently keeping
  // the last of three would be a skill that says it sends three files and does
  // not — and the answer written from the wrong CV reads exactly like the right
  // one.
  if (uploads > 1) {
    setHint(`Only ${last} was attached — the provider takes one file per question.`, 'warn');
  } else if (full) {
    setHint(`${full} file${full > 1 ? 's' : ''} left off — ${MAX_FILES} is the limit for one question.`, 'warn');
  }
}

/** Take back what a skill armed, for when its command leaves the composer. */
export function dropSkillFiles() {
  state.files = state.files.filter((f) => !f.fromSkill);
  if (state.upload?.fromSkill) state.upload = null;
}

/* ------------------------------------------------------------- chooser --- */

/** The skill whose files are on screen, and which of them are ticked. */
let pending = null;
const chosen = new Set();

/**
 * Open the picker for a skill armed with `filePick: 'ask'`.
 *
 * Deliberately not dismissed by a click elsewhere — see `bindDismissals`. The
 * sheet is the second half of a command you have already typed, and losing it
 * to a stray click leaves `/resume` in the box with no résumé attached, which
 * is the exact failure the picker exists to prevent.
 */
export function openSkillFiles(skill) {
  pending = skill;
  chosen.clear();
  // One file is not a choice. Ticking it saves the click and still shows what
  // is about to be attached.
  if (skill.files.length === 1) chosen.add(skill.files[0].id);

  els.skillPickTitle.textContent = skill.title;
  els.skillPickSub.textContent = `${skill.files.length} files · choose what goes with this question`;
  renderSkillPick();
  els.skillPick.hidden = false;
  els.skillPickUse.focus();
}

export function closeSkillFiles() {
  els.skillPick.hidden = true;
  pending = null;
  chosen.clear();
}

/** Attach what is ticked and close. */
export function useSkillFiles() {
  const skill = pending;
  if (!skill) return;
  const files = skill.files.filter((f) => chosen.has(f.id));
  closeSkillFiles();
  if (files.length) armSkillFiles(skill, files);
}

function renderSkillPick() {
  els.skillPickList.replaceChildren();
  if (!pending) return;

  for (const file of pending.files) {
    const row = make('button', 'sheet-row');
    row.setAttribute('aria-pressed', String(chosen.has(file.id)));

    const badge = make('span', 'row-icon');
    if (file.kind === 'upload' && file.type.startsWith('image/')) {
      // A picture's contents have no name — that is usually why it is a
      // picture — so the row shows it rather than an icon.
      const img = make('img');
      img.src = file.dataUrl;
      img.alt = '';
      badge.classList.add('has-thumb');
      badge.append(img);
    } else {
      badge.innerHTML = icon(file.kind === 'upload' ? 'folder' : 'file', 15);
    }

    const main = make('span', 'sheet-row-main', file.name);
    main.append(make('span', 'sub', describe(file)));

    const check = make('span', 'check');
    check.innerHTML = icon('check', 14);

    row.append(badge, main, check);
    row.addEventListener('click', () => toggle(file));
    els.skillPickList.append(row);
  }

  els.skillPickUse.textContent = chosen.size ? `Attach ${chosen.size}` : 'Attach';
  els.skillPickUse.disabled = !chosen.size;
}

/**
 * Ticking an upload unticks the other uploads.
 *
 * Not a warning afterwards: there is exactly one attachment slot, so a list
 * that lets you tick three PDFs and then quietly sends the last is a picker
 * that lies about what it did. Text files are unaffected — several of those
 * genuinely travel together, inside the prompt.
 */
function toggle(file) {
  if (chosen.has(file.id)) chosen.delete(file.id);
  else {
    if (file.kind === 'upload') {
      for (const other of pending.files) {
        if (other.kind === 'upload') chosen.delete(other.id);
      }
    }
    chosen.add(file.id);
  }
  renderSkillPick();
}

/** "PDF · 210 KB — uploaded to the provider" */
export function describe(file) {
  const ext = (file.name.split('.').pop() || '').toUpperCase().slice(0, 4);
  const size =
    file.size >= 1024 * 1024
      ? `${(file.size / 1024 / 1024).toFixed(1)} MB`
      : `${Math.max(1, Math.round((file.size || file.text?.length || 0) / 1024))} KB`;
  const road = file.kind === 'upload' ? 'uploaded to the provider' : 'read into the prompt';
  return `${ext} · ${size} — ${road}`;
}
