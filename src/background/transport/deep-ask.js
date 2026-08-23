import { askProvider } from './ask-provider.js';
import {
  buildScanPrompt,
  buildAnswerPrompt,
  splitOnLines,
  longestLine
} from '../context/prompt.js';
import { holdKeepAlive, releaseKeepAlive } from './inflight.js';

/**
 * Answering one question with several provider turns instead of one.
 *
 * The failure this exists for: a long page and a question like "list every Easy
 * Apply job here" comes back with two of the twenty-five, phrased with complete
 * confidence. One turn carrying forty thousand characters gets skimmed, and a
 * skim is indistinguishable from an answer. So the page is read in parts — one
 * turn each, extraction only, no conclusions — and a final turn answers from
 * everything that was found.
 *
 * It costs N+1 round trips instead of one, which is why `planDeepRead` decides
 * when it is worth it rather than doing it always.
 */

/** Below this a single turn can read the whole thing properly. */
const MIN_PART_CHARS = 6000;

/**
 * Target number of reading turns. Each one is a full provider round trip, so
 * this is a time budget as much as a cost one. Extra attached pages can push the
 * real count slightly past it — dropping a page to hit a target would be the
 * silent incompleteness this whole module exists to remove.
 */
const MAX_PARTS = 6;

/**
 * Questions that are wrong unless they are complete.
 *
 * "What does this page say about X" tolerates a skim; "how many", "list all" and
 * "every" do not — those are exactly the questions where a plausible partial
 * answer is worse than a slow one.
 */
const ENUMERATIVE =
  /\b(all|every|each|list|lists|listed|complete|entire|full|how many|count|total|which ones|compare|summari[sz]e)\b/i;

/** Stream states that still belong to the user even during a reading turn. */
const FORWARDED = new Set(['error', 'need_login', 'cancelled']);

/**
 * The reading plan for this question, or null to just ask once.
 *
 * Returns the parts to send, each tagged with the page it came from.
 */
export function planDeepRead({ question, pages, settings }) {
  const mode = settings.deepRead || 'auto';
  if (mode === 'off') return null;

  const usable = pages.filter((page) => page?.text);
  const total = usable.reduce((n, page) => n + page.text.length, 0);
  if (!total) return null;

  const worthIt =
    mode === 'always'
      ? total > MIN_PART_CHARS
      : total > MIN_PART_CHARS * 2 ||
        (ENUMERATIVE.test(question || '') && total > MIN_PART_CHARS);

  if (!worthIt) return null;

  // The +longest allowance is why MAX_PARTS parts actually cover the page, and
  // the cap is why a page that arrived as one blob still splits — see
  // longestLine.
  const longest = Math.min(
    usable.reduce((n, page) => Math.max(n, longestLine(page.text)), 0),
    1000
  );
  const size = Math.max(MIN_PART_CHARS, Math.ceil(total / MAX_PARTS) + longest + 1);
  const parts = [];

  for (const page of usable) {
    for (const text of splitOnLines(page.text, size)) parts.push({ page, text });
  }

  // One part is one turn, which is what the ordinary path already does.
  return parts.length > 1 ? parts : null;
}

/**
 * Read the page in parts, then answer. Resolves like `askProvider` does.
 *
 * Only the final turn's stream reaches the panel as an answer: a reading turn's
 * text is working-out, and letting it render would show the user a partial
 * extract that then gets replaced. Errors, sign-in prompts and cancellations go
 * straight through — those are never working-out.
 */
export async function askDeep({
  reqId,
  provider,
  settings,
  post,
  question,
  pages,
  parts,
  extras = {},
  image = null,
  // Injected so the read loop can be driven from a test with scripted replies,
  // the same reason runAgent takes its `ask`.
  ask = askProvider
}) {
  const total = parts.length;
  const findings = [];

  const progress = (phase, done) =>
    post({ type: 'ASK_PROGRESS', reqId, providerId: provider.id, phase, done, total });

  const quiet = (msg) => {
    if (msg.type !== 'STREAM' || FORWARDED.has(msg.state)) post(msg);
  };

  /**
   * One reading turn.
   *
   * A provider that drops a single turn out of five loses the whole question,
   * so this used to ask twice. It no longer needs to: `askProvider` retries a
   * stall itself, closing and reopening the provider window in between, and
   * stacking a retry on a retry would make one dropped turn cost six full
   * response timeouts.
   */
  const readPart = async (index) => {
    const prompt = buildScanPrompt({
      question,
      page: parts[index].page,
      part: index + 1,
      total,
      text: parts[index].text
    });

    return ask({
      reqId, provider, settings, prompt, post: quiet, sessionId,
      // Only part 1 of the read may start the thread; every later part joins it.
      fresh: fresh && index === 0
    });
  };

  // Held across the whole read: the gaps between turns are worker-idle time, and
  // an MV3 worker torn down between part 2 and part 3 loses every finding so far
  // with no way to tell the panel why.
  holdKeepAlive();

  try {
    for (let index = 0; index < total; index += 1) {
      progress('reading', index);

      const result = await readPart(index);
      if (result.state !== 'done') return result;

      const text = (result.text || '').trim();
      if (text && !/^NOTHING IN PART/i.test(text)) findings.push(text);
    }

    progress('answering', total);

    return ask({
      reqId,
      provider,
      settings,
      post,
      image,
      prompt: buildAnswerPrompt({ question, findings, pages, extras })
    });
  } finally {
    releaseKeepAlive();
  }
}
