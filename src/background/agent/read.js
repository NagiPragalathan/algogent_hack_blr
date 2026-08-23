import { SCAN_PART_CHARS, MAX_SCAN_PARTS } from './limits.js';
import { buildScanPrompt, splitOnLines, longestLine } from '../context/prompt.js';

/**
 * Reading one over-long observation across several provider turns.
 *
 * A deep observation is forty thousand characters of feed. Handed over whole it
 * gets skimmed — and a skim is indistinguishable from a reading, because the
 * reply is just as fluent either way. That is the failure this exists for: a
 * jobs page with twenty-five results, an agent that names two of them, and
 * nothing anywhere in the run that admits the other twenty-three were never
 * looked at.
 *
 * So the page is transcribed first: one turn per part, extraction only, no
 * conclusions, and the parts are collapsed into notes the deciding turn reads
 * instead of the raw page. It costs N extra round trips for the one step that
 * asked to see everything — which is the trade, and why `needsPartReading`
 * refuses it for anything a single turn can honestly read.
 *
 * The chat path does the same thing in `transport/deep-ask.js`. They share the
 * scan prompt and the splitter but not the loop: this one runs inside a step,
 * has no answer turn of its own, and must stop the moment the run is cancelled.
 */

/** Whether this observation is longer than one turn will actually read. */
export function needsPartReading(text) {
  return typeof text === 'string' && text.length > SCAN_PART_CHARS * 1.4;
}

/**
 * Transcribe `observation.text` part by part; resolve with the notes.
 *
 * Returns null when there was nothing worth the round trips, or when the run
 * was cancelled part-way — the caller then keeps the raw text, which is worse
 * but never wrong.
 *
 * `ask` is the loop's own provider call, so these turns land in the same
 * conversation as the decisions. That is deliberate: the thread then holds the
 * page as evidence, and a later step can refer back to an item it transcribed
 * ten steps ago instead of re-reading the page to find it again.
 */
export async function readInParts({ ask, task, observation, emit, step, signal }) {
  const text = observation.text || '';

  // The line allowance is capped — see longestLine. MAX_SCAN_PARTS is a target
  // size, not a hard cap, so a few extra parts are cheaper than a page that
  // declines to split at all.
  const longest = Math.min(longestLine(text), 1000);
  const size = Math.max(SCAN_PART_CHARS, Math.ceil(text.length / MAX_SCAN_PARTS) + longest + 1);
  const parts = splitOnLines(text, size);

  if (parts.length < 2) return null;

  const page = { title: observation.title || '', url: observation.url || '' };
  const findings = [];

  for (let index = 0; index < parts.length; index += 1) {
    if (signal?.cancelled) return null;

    emit({
      type: 'AGENT_STEP',
      step,
      description: `Reading the page (part ${index + 1} of ${parts.length})`,
      note:
        index === 0
          ? `The page is ${text.length.toLocaleString()} characters, too much for one ` +
            'turn to read carefully, so it is being transcribed in parts first.'
          : ''
    });

    const reply = await ask(
      buildScanPrompt({
        question: task,
        page,
        part: index + 1,
        total: parts.length,
        text: parts[index]
      })
    );

    // One dropped part is a hole in the middle of a list the model will then
    // answer from confidently. Say so in the notes rather than closing the gap
    // silently — the deciding turn can go back and look, but only if it knows.
    if (reply.error) {
      findings.push(`(Part ${index + 1} of ${parts.length} could not be read: ${reply.error})`);
      continue;
    }

    const body = (reply.text || '').trim();
    if (body && !/^NOTHING IN PART/i.test(body)) findings.push(body);
  }

  if (!findings.length) return null;

  return [
    `Read in ${parts.length} parts. Everything found on the page, in order:`,
    '',
    ...findings
  ].join('\n');
}
