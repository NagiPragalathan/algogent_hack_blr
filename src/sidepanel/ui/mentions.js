import { els } from '../core/dom.js';
import { state } from '../core/state.js';
import { send } from '../core/port.js';

/**
 * The tab picker belongs on '@', not on '+'.
 *
 * '+' is where you go to add something you have — a file, a skill, a region of
 * the page. '@' is how you refer to something already open. Putting the tab
 * list behind '+' conflated the two, which is why it was the only thing there.
 */
function mentionQuery() {
  const value = els.input.value;
  const caret = els.input.selectionStart ?? value.length;
  const before = value.slice(0, caret);
  const match = before.match(/(?:^|\s)@([^\s@]*)$/);
  if (!match) return null;
  return { query: match[1].toLowerCase(), start: caret - match[1].length - 1 };
}

/** Open, keep open, or close the '@' sheet to match what is being typed. */
export function syncMentionMenu() {
  const mention = mentionQuery();
  if (!mention) {
    els.mentionMenu.hidden = true;
    state.mentionAt = null;
    return;
  }
  if (state.mentionAt === null) {
    els.tabFilter.value = '';
    send({ type: 'LIST_TABS' });
  }
  state.mentionAt = mention.start;
  els.mentionMenu.hidden = false;
}

/**
 * Where the '@query' being typed starts and ends, for whoever replaces it.
 *
 * There used to be a `clearMentionToken` here that deleted the query and put a
 * chip in a row under the box. Nothing ever called it — so picking a tab left
 * "@job" sitting in the middle of your sentence with a grey pill somewhere
 * else claiming to be the thing you had just referred to. `toggleTab` in
 * `tab-picker.js` does the replacement now, because that is where the choice
 * is actually made.
 */
export function mentionRange() {
  if (state.mentionAt === null) return null;
  return { from: state.mentionAt, to: els.input.selectionStart ?? els.input.value.length };
}
