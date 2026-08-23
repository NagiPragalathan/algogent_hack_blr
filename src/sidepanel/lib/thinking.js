/**
 * The model's reply, as it arrives, reduced to one readable line.
 *
 * A provider round trip is ten to forty seconds in which the curtain is up,
 * nothing on the page moves, and the panel said one fixed sentence — "Agent is
 * deciding the next step…". That is read once and ignored ever after, and it
 * says nothing about whether the run understood the task or has wandered off,
 * which is the question someone watching their own browser is actually asking.
 * The text was already here: `AGENT_THINKING` has carried the streamed reply
 * all along and the panel discarded it.
 *
 * In `lib/` because it knows nothing about this panel — it is string work, and
 * that is what makes it testable without a DOM.
 */

/**
 * The reasoning field, possibly still being written.
 *
 * The capture deliberately has no closing quote: mid-stream the value is
 * unterminated far more often than not, and requiring the close would mean the
 * hint stays generic for the whole of the one field worth showing. `[^"\\]|\\.`
 * walks escapes properly so a `\"` inside the thought does not end it early.
 */
const THOUGHT = /"(?:thought|reasoning|thinking|plan)"\s*:\s*"((?:[^"\\]|\\.)*)/;

/** Structural characters that make a half-written action read as an error. */
const SYNTAX = /[{}[\]"]/g;

const FENCE = /```[a-z]*/gi;

/**
 * @param {string} text  the reply so far
 * @param {number} limit characters before it is cut
 * @returns {string} one line, or '' when there is nothing worth showing yet
 */
export function thinkingExcerpt(text, limit = 140) {
  const raw = String(text ?? '');
  if (!raw.trim()) return '';

  const thought = raw.match(THOUGHT)?.[1];

  const said = thought
    // A JSON string body, so its escapes are still escaped. Unescaped in this
    // order — backslash last — or `\\n` would become a newline rather than the
    // two characters the model actually wrote.
    ? thought.replace(/\\n/g, ' ').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
    // No thought yet. Drop the fence and the punctuation so what shows is prose
    // rather than syntax — a bare `{"action":"click","id":` in the hint reads as
    // a crash to anyone not holding the protocol in their head.
    : raw.replace(FENCE, ' ').replace(SYNTAX, ' ');

  const clean = said.replace(/\s+/g, ' ').trim();
  if (!clean) return '';

  // From the START, not the tail: a thought grows left to right, and a window
  // sliding along the end of it flickers on every delta without ever becoming
  // more informative.
  return clean.length > limit ? `${clean.slice(0, limit)}…` : clean;
}
