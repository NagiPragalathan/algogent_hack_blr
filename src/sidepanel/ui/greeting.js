import { els, make } from '../core/dom.js';
import { state } from '../core/state.js';
import { icon, paintIcons } from '../lib/icons.js';

/**
 * What an empty thread shows.
 *
 * Bottom-anchored: the heading sits just above the composer rather than
 * floating in the middle of an empty panel, so the eye lands where the typing
 * happens.
 */
export function greeting() {
  const wrap = make('div', 'greeting');

  const mark = make('div', 'greeting-mark');
  mark.innerHTML = icon('sparkle', 24);

  wrap.append(
    mark,
    make('h1', '', 'Agent at your service'),
    make('h2', '', 'Let AI automate tasks and browse for you')
  );

  // The chips are authored in a <template> so the markup lives with the HTML.
  wrap.append(document.getElementById('quick-template').content.cloneNode(true));
  paintIcons(wrap);

  // Only worth offering once there is something to leave behind.
  if (state.sessions.length) {
    const fresh = make('button', 'greeting-new');
    fresh.innerHTML = icon('compose', 14) + '<span>Start a new chat</span>';
    fresh.addEventListener('click', () => els.btnNew.click());
    wrap.append(fresh);
  }

  return wrap;
}
