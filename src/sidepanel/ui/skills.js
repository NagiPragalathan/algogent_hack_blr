import { els, make } from '../core/dom.js';
import { state } from '../core/state.js';
import { emit, EVENTS } from '../core/bus.js';
import { icon } from '../lib/icons.js';
import { PRESET_SKILLS } from '../lib/preset-skills.js';
import { autosize } from './composer.js';
import { insertSkill, paintInk } from './composer-ink.js';
import { renderAttachmentChips } from './attachments.js';
import { armSkillFiles, openSkillFiles } from './skill-files.js';

/**
 * Reusable prompts: the ones that ship, and the ones you save.
 *
 * The two are kept apart in storage and joined on the way out. A single stored
 * list looked simpler and was not: `stored.skills || PRESETS` meant the moment
 * you saved your first skill, all twelve shipped ones disappeared — the shipped
 * set was only ever "the empty state", which is not what a library is. Now
 * saving one adds to them, and a preset you never want to see again is
 * remembered as hidden rather than deleted, so an update can add new ones
 * without resurrecting the one you threw away.
 */

export const isPreset = (skill) => skill.id.startsWith('p-');

/** How many files a skill carries, and whether you get to choose between them. */
export const skillFiles = (skill) => skill.files || [];

export async function loadSkills() {
  const stored = await chrome.storage.local.get(['skills', 'skillsHidden']);
  const hidden = new Set(stored.skillsHidden || []);

  // Yours first: a saved skill is one you went out of your way to keep.
  state.skills = [
    ...(stored.skills || []),
    ...PRESET_SKILLS.filter((skill) => !hidden.has(skill.id))
  ];
}

/**
 * Write the saved half of the library back.
 *
 * Returns the failure rather than throwing it away, because a skill now carries
 * files: the one write that can realistically fail is a résumé too big for the
 * quota, and a save that reports success and loses the file the next time the
 * panel boots is the worst of the three possible outcomes.
 */
export async function saveSkills() {
  try {
    await chrome.storage.local.set({ skills: state.skills.filter((s) => !isPreset(s)) });
    return null;
  } catch (error) {
    return error?.message || String(error);
  }
}

export async function hidePreset(id) {
  const stored = await chrome.storage.local.get('skillsHidden');
  const hidden = new Set(stored.skillsHidden || []);
  hidden.add(id);
  await chrome.storage.local.set({ skillsHidden: [...hidden] });
}

/**
 * Arm a skill for the next question.
 *
 * It becomes a chip, not text. Pasting the body in was the obvious version and
 * the wrong one: these prompts are a paragraph each, so the composer filled up,
 * the conversation was pushed off screen, and adding "for the pricing section"
 * meant finding the end of somebody else's sentence first. The body is joined
 * to what you type when the question is sent — see `ask()`.
 */
export function useSkill(skill) {
  state.skill = skill;
  els.skillsMenu.hidden = true;
  /**
   * The command goes into the box as text, and is drawn there as a badge.
   *
   * Not the body — that is a paragraph, and pasting it filled the composer,
   * pushed the conversation off screen and left you editing someone else's
   * wording to add your own three words. But not nothing, either, which is what
   * this did before: the box was emptied and the only sign a skill was armed
   * was a chip below it, so a composer that was about to send four hundred
   * words of instruction looked completely blank.
   *
   * `/summarise` is the honest middle: short, editable, deletable — and
   * deleting it disarms the skill, because `syncTokens` reads the text back.
   */
  insertSkill(skill.slug);
  paintInk();
  renderAttachmentChips();
  autosize();

  /**
   * A skill's own files, on the same gesture that armed the prompt.
   *
   * This is the half that makes "/resume" a feature rather than a nickname for
   * a paragraph: the prompt and the file are one thought, and splitting them
   * across two gestures means the second one gets skipped — after which the
   * question is sent without the CV and the answer is written about a document
   * nobody attached. Which of the two happens is the author's decision, made
   * when the skill was written and stored on it, because "pick one of my four
   * résumés" and "always send my style guide" are different skills.
   */
  const files = skillFiles(skill);
  if (!files.length) return;
  if (skill.filePick === 'all') armSkillFiles(skill, files);
  else openSkillFiles(skill);
}

export function renderSkills() {
  els.skillList.replaceChildren();

  for (const skill of state.skills) {
    const row = make('button', 'sheet-row');

    const badge = make('span', 'row-icon');
    badge.innerHTML = icon(skill.glyph || 'book', 15);

    const main = make('div', 'sheet-row-main', skill.title);
    main.append(make('span', 'sub', skill.hint || skill.body.slice(0, 70)));

    // The slash command, so the sheet teaches the faster way to get here.
    if (skill.slug) main.append(make('span', 'skill-slug', `/${skill.slug}`));

    // What it will attach, in the list where you decide whether to use it. A
    // skill that quietly sends a CV and one that quietly sends nothing look
    // identical otherwise.
    const files = skillFiles(skill);
    if (files.length) {
      main.append(
        make(
          'span',
          'skill-files-note',
          `${files.length} file${files.length > 1 ? 's' : ''} · ` +
            (skill.filePick === 'all' ? 'all sent' : 'you choose')
        )
      );
    }

    const edit = make('span', 'session-del');
    edit.innerHTML = icon('compose', 13);
    edit.title = isPreset(skill) ? 'Edit — saves your own copy' : 'Edit this skill';
    edit.addEventListener('click', (e) => {
      e.stopPropagation();
      emit(EVENTS.EDIT_SKILL, skill);
    });

    const del = make('span', 'session-del');
    del.innerHTML = icon('trash', 14);
    del.title = isPreset(skill) ? 'Hide this built-in skill' : 'Delete this skill';
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (isPreset(skill)) await hidePreset(skill.id);
      state.skills = state.skills.filter((k) => k.id !== skill.id);
      saveSkills();
      renderSkills();
    });

    row.append(badge, main, edit, del);
    row.addEventListener('click', () => useSkill(skill));

    els.skillList.append(row);
  }
}

/**
 * Two words, lowercased, made unique against what already exists.
 *
 * `mine` is the skill being edited, and leaving it out of the taken set is the
 * whole reason it is a parameter: re-saving `/resume` without touching its
 * command would otherwise find its own slug taken and rename it `/resume-2`,
 * so editing a skill would silently break the command you had learned.
 */
export function slugFor(text, mine = null) {
  const base =
    String(text)
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .split(/[\s-]+/)
      .filter(Boolean)
      .slice(0, 2)
      .join('-')
      .slice(0, 20) || 'skill';

  const taken = new Set(state.skills.filter((s) => s.id !== mine).map((s) => s.slug));
  if (!taken.has(base)) return base;

  let n = 2;
  while (taken.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}
