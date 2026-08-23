import { els } from '../core/dom.js';

/**
 * Where the thread is scrolled, and everything that depends on it.
 *
 * Its own module because both `thread.js` and `agent.js` repaint a message in
 * place and both have to decide whether to follow the bottom — and thread.js
 * already imports agent.js, so putting these next to either one would close an
 * import ring. See the cycle note in AGENTS.md.
 */

/** How close to the bottom still counts as "following along". */
const PINNED_SLACK = 80;

/** Past this the topbar stops pretending it is part of the thread. */
const HAIRLINE_AT = 4;

export const pinnedToBottom = () =>
  els.thread.scrollHeight - els.thread.scrollTop - els.thread.clientHeight < PINNED_SLACK;

/**
 * Go to the bottom without animating.
 *
 * `.thread` is `scroll-behavior: smooth`, which is right when the user jumps to
 * the latest message and wrong while one is streaming: every delta would start
 * a fresh smooth scroll that the next delta interrupts, so the view crawls
 * along a few pixels behind the text and never catches up. `instant` overrides
 * the stylesheet for exactly the case that has to be immediate.
 */
export function stickToBottom() {
  els.thread.scrollTo({ top: els.thread.scrollHeight, behavior: 'instant' });
  syncScrollState();
}

/**
 * Two things the scroll position drives.
 *
 * The panel scrolls itself to the bottom on every delta, which is right while
 * you are following along and wrong the moment you scroll up to re-read
 * something — the repaint paths already stop fighting you there, but then
 * nothing tells you the answer has moved on without you. The button is that;
 * the topbar's hairline is the same signal at the other end of the thread.
 *
 * The scroll listener itself is installed by `bindEvents`, so every listener
 * the panel owns is still findable in one file.
 */
export function syncScrollState() {
  els.toLatest.hidden = pinnedToBottom();
  els.topbar.classList.toggle('scrolled', els.thread.scrollTop > HAIRLINE_AT);
}

export function jumpToLatest() {
  // Smooth here: this one IS the user asking to travel, and the distance is
  // exactly what they need to see being covered.
  els.thread.scrollTo({ top: els.thread.scrollHeight, behavior: 'smooth' });
}
