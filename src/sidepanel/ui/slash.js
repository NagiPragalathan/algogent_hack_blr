import { els, make } from '../core/dom.js';
import { state } from '../core/state.js';
import { icon } from '../lib/icons.js';
import { useSkill } from './skills.js';
import { autosize } from './composer.js';

/**
 * '/' opens the skill list, the way '@' opens the tab list.
 *
 * Skills already existed behind + > Browse skills, which is two clicks and a
 * read — so they were used once, when discovered, and never again. A command
 * you can type without leaving the keyboard is a different feature from the
 * same list behind a menu.
 *
 * Only at the very start of the composer. Matching '/' anywhere would fire on
 * "and/or", on every URL anyone pastes, and mid-sentence on "24/7" — and a
 * suggestion list that opens while you are typing prose is worse than no
 * suggestion list, because it steals the Enter key.
 */
function slashQuery() {
  const value = els.input.value;
  const caret = els.input.selectionStart ?? value.length;
  if (caret !== value.length) return null;

  const match = value.match(/^\/([a-z0-9-]*)$/i);
  return match ? match[1].toLowerCase() : null;
}

/** Skills matching what has been typed, best first. */
function matches(query) {
  if (!query) return state.skills;

  const scored = state.skills
    .map((skill) => {
      const slug = (skill.slug || '').toLowerCase();
      const title = skill.title.toLowerCase();
      if (slug.startsWith(query)) return { skill, rank: 0 };
      if (title.startsWith(query)) return { skill, rank: 1 };
      if (slug.includes(query) || title.includes(query)) return { skill, rank: 2 };
      // The body last: it matches broadly, so a body hit is a weak signal.
      if (skill.body.toLowerCase().includes(query)) return { skill, rank: 3 };
      return null;
    })
    .filter(Boolean);

  scored.sort((a, b) => a.rank - b.rank);
  return scored.map((s) => s.skill);
}

/** Which row Enter would take. Reset every time the list is rebuilt. */
let active = 0;
let shown = [];

/** Open, refilter, or close the '/' sheet to match what is being typed. */
export function syncSlashMenu() {
  const query = slashQuery();

  if (query === null) {
    closeSlashMenu();
    return;
  }

  shown = matches(query);
  if (!shown.length) {
    closeSlashMenu();
    return;
  }

  active = 0;
  renderSlashList();
  els.slashMenu.hidden = false;
}

export function closeSlashMenu() {
  els.slashMenu.hidden = true;
  shown = [];
}

function renderSlashList() {
  els.slashList.replaceChildren();

  shown.forEach((skill, index) => {
    const row = make('button', 'sheet-row slash-row');
    if (index === active) row.classList.add('active');

    const badge = make('span', 'row-icon');
    badge.innerHTML = icon(skill.glyph || 'book', 15);

    const main = make('span', 'sheet-row-main', skill.title);
    main.append(make('span', 'sub', skill.hint || skill.body.slice(0, 60)));

    // A skill that is about to open a file picker, or to send a CV without
    // asking, must say so in the list where it is chosen — the typeahead is
    // where most of them are used, and the sheet is the only place that said it.
    const files = skill.files || [];
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

    const slug = make('span', 'skill-slug', `/${skill.slug}`);

    row.append(badge, main, slug);
    // `mousedown`, not `click`: the composer loses focus on mousedown, and a
    // blur handler that closes the sheet would remove this row before the click
    // ever lands on it.
    row.addEventListener('mousedown', (e) => {
      e.preventDefault();
      pick(index);
    });
    row.addEventListener('mouseenter', () => {
      active = index;
      highlight();
    });

    els.slashList.append(row);
  });
}

function highlight() {
  [...els.slashList.children].forEach((row, index) => {
    row.classList.toggle('active', index === active);
  });
  els.slashList.children[active]?.scrollIntoView({ block: 'nearest' });
}

function pick(index) {
  const skill = shown[index];
  if (!skill) return;
  closeSlashMenu();
  // `useSkill` completes the '/query' into the full '/slug' and leaves it in
  // the box as a badge. It used to empty the composer instead, which meant the
  // one visible trace of the command you had just typed disappeared the moment
  // you chose it.
  useSkill(skill);
  autosize();
}

/**
 * Keys the sheet owns while it is open. Returns true when it handled one.
 *
 * Enter has to be intercepted before the composer's own handler sends the
 * question — "/sum" is not a question, and sending it is the one outcome the
 * list exists to prevent.
 */
export function handleSlashKey(event) {
  if (els.slashMenu.hidden || !shown.length) return false;

  switch (event.key) {
    case 'ArrowDown':
      active = (active + 1) % shown.length;
      highlight();
      break;
    case 'ArrowUp':
      active = (active - 1 + shown.length) % shown.length;
      highlight();
      break;
    case 'Enter':
    case 'Tab':
      pick(active);
      break;
    case 'Escape':
      closeSlashMenu();
      break;
    default:
      return false;
  }

  event.preventDefault();
  return true;
}
