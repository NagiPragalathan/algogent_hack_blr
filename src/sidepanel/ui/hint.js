import { els } from '../core/dom.js';

/**
 * The one status line under the composer.
 *
 * Everything transient the panel has to say goes here — errors, warnings,
 * confirmations — because a second place to look is a place people do not look.
 */
export function setHint(text, kind = '') {
  els.hint.textContent = text;
  els.hint.className = `hint ${kind}`.trim();
}

/** Say something, then get out of the way. */
export function flashHint(text, ms = 2500, kind = '') {
  setHint(text, kind);
  setTimeout(() => setHint(''), ms);
}
