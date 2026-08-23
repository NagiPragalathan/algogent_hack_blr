import { els, make } from '../core/dom.js';
import { state } from '../core/state.js';
import { dropSkillFiles } from './skill-files.js';

/**
 * The badges you can see inside the composer.
 *
 * A mentioned tab and a chosen skill were both real and both invisible. The tab
 * became a chip in a row under the box and the '@' text you typed vanished; the
 * skill became a chip too and emptied the composer entirely. So the box you are
 * looking at while you type said nothing about what the question would actually
 * carry — you wrote "compare this with the other one" into an apparently empty
 * field and had to trust a strip of grey pills somewhere else.
 *
 * They are *in the text* now: `@[Job ad]` and `/summarise` are ordinary
 * characters in the textarea, which is the whole trick. Everything keeps
 * working — the caret, selection, undo, IME, paste, Backspace over a badge —
 * because nothing about the control changed. What changed is that a second
 * layer behind it paints a rounded background under those runs of characters,
 * so they read as badges while remaining text.
 *
 * A contenteditable was the obvious alternative and is the trap: it would mean
 * reimplementing the caret arithmetic in `mentions.js` and `slash.js`, and
 * inheriting every paste-brings-its-own-markup bug that comes with one.
 *
 * The layer is `aria-hidden` and takes no pointer events — it is a drawing, not
 * a control. The textarea above it keeps the real, selectable glyphs, so the
 * badge is a background rather than a substitute and nothing can drift between
 * what you read and what gets sent.
 *
 * TEXT IS THE TRUTH. `state.contextTabs` and `state.skill` are rebuilt from
 * what is in the box (`syncTokens`), never the other way round. Backspacing
 * over `@[Job ad]` therefore detaches that tab, which is the only behaviour
 * that is not surprising: a badge you have deleted must not still be attached.
 */

/** Anything that would break the token grammar, or make the box unreadable. */
const LABEL_CHARS = 34;

/** `@[Anything but a bracket or a newline]` */
const MENTION = /@\[[^\]\n]{1,80}\]/g;
/** A skill command, and only as the first thing in the box. */
const SKILL = /^\/[a-z0-9-]+/i;

/**
 * The same thing half-typed, which is what `insertSkill` has to replace.
 *
 * `SKILL` needs at least one character after the slash so a lone "/" is not
 * mistaken for a command — and a lone "/" is exactly what is in the box the
 * instant the list opens. Reusing `SKILL` to strip it therefore matched
 * nothing and left it behind: choosing the first skill offered produced
 * "/summarise /".
 */
const SKILL_PARTIAL = /^\/[a-z0-9-]*/i;

const tokenFor = (label) => `@[${label}]`;

/**
 * A tab's label: short, bracket-free, and unique among what is already there.
 *
 * Unique matters more than it looks. Two tabs from the same site are routinely
 * called the same thing ("Application — Workday"), and two identical tokens
 * would be indistinguishable both to `syncTokens`, which matches by text, and
 * to the person reading their own sentence back. The host disambiguates first
 * because it is meaningful; the id is the last resort and is at least unique.
 */
export function labelForTab(tab, taken = []) {
  const clean = String(tab.title || tab.url || 'Tab')
    .replace(/[[\]\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, LABEL_CHARS) || 'Tab';

  if (!taken.includes(clean)) return clean;

  let host = '';
  try {
    host = new URL(tab.url).hostname.replace(/^www\./, '');
  } catch {
    /* not a URL we can shorten */
  }

  const withHost = host ? `${clean} · ${host}` : clean;
  return taken.includes(withHost) ? `${clean} #${tab.id}` : withHost;
}

/** Put `@[Label]` where the caret is, replacing the `@query` being typed. */
export function insertMention(label) {
  const value = els.input.value;
  const caret = els.input.selectionStart ?? value.length;
  const from = state.mentionAt ?? caret;

  // A trailing space, because the next thing typed is a word and not part of
  // the badge — without it the token grows a tail and stops matching.
  const token = `${tokenFor(label)} `;
  els.input.value = value.slice(0, from) + token + value.slice(caret);

  const at = from + token.length;
  els.input.selectionStart = els.input.selectionEnd = at;
  state.mentionAt = null;
  els.input.focus();
}

/** Take a badge out of the text, for the ✕ on its chip. */
export function removeMention(label) {
  const token = tokenFor(label);
  const value = els.input.value;
  const at = value.indexOf(token);
  if (at < 0) return;
  // The space after it goes too, or removing a badge mid-sentence leaves a
  // double space behind every time.
  const end = at + token.length + (value[at + token.length] === ' ' ? 1 : 0);
  els.input.value = value.slice(0, at) + value.slice(end);
}

/** Put `/slug ` at the front, replacing whatever command was being typed. */
export function insertSkill(slug) {
  els.input.value = `/${slug} ${els.input.value.replace(SKILL_PARTIAL, '').trimStart()}`;
  const at = els.input.value.length;
  els.input.selectionStart = els.input.selectionEnd = at;
  els.input.focus();
}

/**
 * Rebuild the attachments from what is actually written in the box.
 *
 * Runs on every keystroke, which sounds expensive and is not: the composer
 * holds a sentence, and both regexes are anchored or bracketed. What it buys is
 * that there is exactly ONE source of truth. A chip list maintained alongside
 * the text drifts the first time someone edits the text — and it drifted in the
 * obvious direction, leaving a tab attached that the user had visibly deleted.
 *
 * Returns whether anything changed, so the caller only repaints when it has to.
 */
export function syncTokens() {
  const value = els.input.value;
  const present = new Set((value.match(MENTION) || []).map((t) => t.slice(2, -1)));

  const before = state.contextTabs.length;
  state.contextTabs = state.contextTabs.filter((tab) => !tab.token || present.has(tab.token));

  let changed = state.contextTabs.length !== before;

  // A skill whose command has been rubbed out is not armed any more. Compared
  // on the slug rather than on "does it still start with a slash", or typing a
  // different command would silently keep the first one's body.
  if (state.skill) {
    const match = value.match(SKILL);
    if (!match || match[0].slice(1).toLowerCase() !== state.skill.slug.toLowerCase()) {
      state.skill = null;
      /**
       * The files it brought go with it.
       *
       * A skill's reference file is the one attachment nobody chose on its own
       * — it arrived because a command was typed — so a command you have
       * visibly deleted must not leave your CV queued for the next question.
       * That is the same drift this module exists to prevent, one layer along:
       * still attached, no longer visible.
       */
      dropSkillFiles();
      changed = true;
    }
  }

  return changed;
}

/**
 * What actually gets sent, with the badges spelled out.
 *
 * `@[Job ad]` means nothing to a provider, and leaving it in produces an answer
 * that talks about the brackets. The tab is already travelling as page text (or,
 * for a run, as a tab the agent can switch to), so the token becomes the name
 * it stands for — in quotes, because "compare Job ad with My CV" is a sentence
 * about two things whose names the model has to be able to pick out of the
 * TABS list it was given.
 *
 * The skill command goes entirely: its body is prepended by `ask()`, so leaving
 * `/summarise` in front of it would tell the provider to summarise the
 * instruction it is being handed.
 */
export function expandTokens(text) {
  return text
    .replace(SKILL, '')
    .replace(MENTION, (token) => `“${token.slice(2, -1)}”`)
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/**
 * Paint the layer behind the text.
 *
 * Built with nodes rather than an HTML string: the labels come from page titles,
 * which are content we do not control, and `innerHTML` here would let a tab
 * called `<img onerror=…>` write markup into the panel.
 *
 * The trailing newline guard is the standard mirror quirk — a textarea shows a
 * blank line for a trailing "\n" and a div collapses it, so without this the
 * layer drifts up by one line the moment you press Enter at the end.
 */
export function paintInk() {
  const ink = els.inputInk;
  if (!ink) return;

  const value = els.input.value;
  ink.replaceChildren();

  let at = 0;
  for (const [start, end, kind] of tokenRanges(value)) {
    if (start > at) ink.append(document.createTextNode(value.slice(at, start)));
    ink.append(make('span', `tok tok-${kind}`, value.slice(start, end)));
    at = end;
  }
  if (at < value.length) ink.append(document.createTextNode(value.slice(at)));
  if (value.endsWith('\n')) ink.append(document.createTextNode(' '));

  // The textarea scrolls once the text is taller than its cap; the layer has to
  // scroll with it or the badges slide off the bottom of their own words.
  ink.scrollTop = els.input.scrollTop;
}

/** Every badge range in the text, in order and never overlapping. */
function tokenRanges(value) {
  const found = [];

  const skill = value.match(SKILL);
  if (skill) found.push([0, skill[0].length, 'skill']);

  MENTION.lastIndex = 0;
  for (const match of value.matchAll(MENTION)) {
    const start = match.index;
    // A '/' command only ever sits at position 0, so an overlap is impossible
    // in practice — checked anyway, because a range that starts before the
    // previous one ended would paint the slice backwards and drop text.
    if (start >= (found[found.length - 1]?.[1] ?? 0)) {
      found.push([start, start + match[0].length, 'tab']);
    }
  }

  return found;
}
