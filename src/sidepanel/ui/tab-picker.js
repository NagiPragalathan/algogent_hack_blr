import { els, make } from '../core/dom.js';
import { state } from '../core/state.js';
import { send } from '../core/port.js';
import { icon } from '../lib/icons.js';
import { faviconFor, refreshContext } from './context.js';
import { autosize } from './composer.js';
import { insertMention, removeMention, labelForTab, paintInk } from './composer-ink.js';

/**
 * The "@" sheet: attach any number of open tabs.
 *
 * Multi-select rather than pick-one, because the questions worth asking a
 * browser agent usually span tabs — this job ad against my CV, these two docs
 * against each other. One tab at a time forced the user to paste.
 */
export function renderTabPicker(tabs) {
  if (tabs) state.knownTabs = tabs;

  const filter = els.tabFilter.value.trim().toLowerCase();
  const shown = state.knownTabs.filter(
    (t) =>
      !filter ||
      (t.title || '').toLowerCase().includes(filter) ||
      (t.url || '').toLowerCase().includes(filter)
  );

  els.tabList.replaceChildren();

  if (!shown.length) {
    els.tabList.append(
      make('div', 'sheet-empty', filter ? 'No tab matches that.' : 'No other tabs are open.')
    );
  }

  for (const tab of shown) els.tabList.append(tabRow(tab));

  updateAttachCount();
}

function tabRow(tab) {
  const attached = state.contextTabs.some((t) => t.id === tab.id);

  const row = make('button', 'sheet-row attach-row-item');
  row.setAttribute('aria-current', String(attached));

  const box = make('span', 'checkbox');
  box.innerHTML = attached ? icon('check', 12) : '';

  const favicon = make('span', 'favicon');
  if (tab.url) favicon.style.backgroundImage = `url("${faviconFor(tab.url)}")`;

  const main = make('div', 'sheet-row-main', tab.title || tab.url || 'Untitled');
  main.append(make('span', 'sub', tab.url || ''));

  row.append(box, favicon, main);
  row.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleTab(tab);
  });
  return row;
}

export function updateAttachCount() {
  const n = state.contextTabs.length;
  els.attachCount.textContent =
    n === 0 ? 'No tabs selected' : `${n} tab${n === 1 ? '' : 's'} selected`;
  els.tabCount.textContent = String(n);
  els.btnTabs.classList.toggle('active', n > 0);
}

/**
 * Attach or detach a tab, and put the badge for it into the sentence.
 *
 * The text half is the part that was missing. Picking a tab used to leave the
 * "@job" you had typed sitting in the middle of your question — nothing ever
 * removed it — while the tab itself became a chip in a separate row. So the
 * sentence read "compare @job with my CV" and sent something else, and the two
 * things on screen that claimed to describe the same choice disagreed.
 *
 * Now the token IS the attachment: `@[Job ad]` goes where you were typing,
 * `composer-ink.js` paints it as a badge, and `syncTokens` rebuilds this list
 * from the text on every keystroke — so backspacing over a badge detaches its
 * tab, which is the only behaviour that does not surprise anyone.
 */
export function toggleTab(tab) {
  const at = state.contextTabs.findIndex((t) => t.id === tab.id);

  if (at >= 0) {
    const [gone] = state.contextTabs.splice(at, 1);
    if (gone.token) removeMention(gone.token);
  } else {
    const token = labelForTab(tab, state.contextTabs.map((t) => t.token).filter(Boolean));
    state.contextTabs.push({ id: tab.id, title: tab.title, url: tab.url, token });
    insertMention(token);
  }

  // Attaching a tab explicitly is a statement that context matters, so turn
  // sharing back on rather than silently attaching to a disabled toggle.
  if (state.contextTabs.length) {
    els.ctxOn.checked = true;
    els.context.classList.remove('off');
  }

  paintInk();
  autosize();
  renderTabPicker();
  renderTabChips();
  refreshContext();
}

/**
 * Chips for attached tabs that have no badge of their own.
 *
 * Which, now that '@' writes `@[Title]` into the sentence, is almost none of
 * them — and that is the point. A chip row under the box saying "My CV.pdf ✕"
 * directly beneath a badge in the box saying the same thing is the same fact
 * twice, and two representations of one choice is how they end up disagreeing:
 * the old code had exactly that bug, with the chip outliving an '@' the user
 * had deleted.
 *
 * The row is kept for a tab attached by some other route — nothing does that
 * today, but a tab with no badge and no chip would be attached invisibly, and
 * that is the failure worth guarding against. The count pill in the toolbar is
 * updated either way; it is a summary, not a duplicate.
 */
export function renderTabChips() {
  els.tabChips.replaceChildren();

  for (const tab of state.contextTabs.filter((t) => !t.token)) {
    const chip = make('span', 'attach-chip');

    const favicon = make('span', 'chip-favicon');
    if (tab.url) favicon.style.backgroundImage = `url("${faviconFor(tab.url)}")`;

    const label = make('span', 'chip-label', tab.title || tab.url || 'Tab');

    const x = make('button');
    x.innerHTML = icon('close', 11);
    x.title = 'Detach';
    x.addEventListener('click', () => toggleTab(tab));

    chip.append(favicon, label, x);
    els.tabChips.append(chip);
  }

  updateAttachCount();
}

export function openTabSheet() {
  els.plusMenu.hidden = true;
  els.workspaceMenu.hidden = true;
  els.mentionMenu.hidden = false;
  els.tabList.replaceChildren();
  send({ type: 'LIST_TABS' });
}
