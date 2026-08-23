/**
 * The skills that ship with the panel.
 *
 * A skill is a prompt worth keeping: the phrasing that reliably gets a useful
 * answer out of a page, written once instead of retyped badly every time. These
 * are the ones that earn their place for a browser assistant — every one of
 * them is about the page you are looking at, not about the model.
 *
 * Three things each entry has to carry, and the reason for each:
 *
 *   `slug`  what you type after `/`. Short, lowercase, no spaces — it is a
 *           command, and a command you have to look up is one you stop using.
 *   `hint`  what it is for, in a few words. The title alone does not separate
 *           "summarise" from "takeaways" for someone deciding in half a second.
 *   `body`  the prompt itself, written the way the panel's own docs describe:
 *           demanding completeness where a partial answer would look identical
 *           to a whole one ("every", "all", "say which you could not"), because
 *           that is this transport's single biggest failure mode.
 *
 * They are data, not code: nothing here knows the panel exists.
 */

export const PRESET_SKILLS = [
  {
    id: 'p-summary',
    slug: 'summarise',
    glyph: 'book',
    title: 'Summarise',
    hint: 'The gist in five bullets',
    body: 'Summarise this page in 5 concise bullet points. Lead with what it is actually about, not with what kind of page it is.'
  },
  {
    id: 'p-takeaways',
    slug: 'takeaways',
    glyph: 'check',
    title: 'Key takeaways',
    hint: 'Points and action items',
    body: 'What are the key takeaways on this page, and what action items follow from them? Separate "what it says" from "what I should do".'
  },
  {
    id: 'p-table',
    slug: 'table',
    glyph: 'layers',
    title: 'Extract as a table',
    hint: 'Every item, as markdown',
    body: 'Extract EVERY item on this page into a markdown table — not a sample. Infer sensible columns from the data. If some rows are missing fields, leave those cells empty rather than dropping the row, and say at the end how many rows you found.'
  },
  {
    id: 'p-explain',
    slug: 'explain',
    glyph: 'sparkle',
    title: 'Explain simply',
    hint: 'Plain language, no jargon',
    body: 'Explain this page in plain language, as if to someone competent but new to the subject. Define any term the page assumes I already know. If something on the page is genuinely unclear, say so rather than smoothing over it.'
  },
  {
    id: 'p-verify',
    slug: 'verify',
    glyph: 'crosshair',
    title: 'What should I verify?',
    hint: 'Claims worth checking',
    body: 'List every claim on this page that a careful reader should verify before relying on it, and say why each one is worth checking — what would change if it turned out to be wrong.'
  },
  {
    id: 'p-compare',
    slug: 'compare',
    glyph: 'window',
    title: 'Compare the options',
    hint: 'Trade-offs, side by side',
    body: 'This page presents several options. Compare them in a table on the dimensions that actually differ, then say which one fits which situation — and name the case where each is the wrong choice.'
  },
  {
    id: 'p-numbers',
    slug: 'numbers',
    glyph: 'file',
    title: 'Pull out the numbers',
    hint: 'Prices, dates, quantities',
    body: 'Pull out every number on this page that carries meaning — prices, dates, deadlines, quantities, percentages — with what each one refers to. Keep the units and the currency exactly as written. Say plainly if a figure is ambiguous on the page itself.'
  },
  {
    id: 'p-reply',
    slug: 'reply',
    glyph: 'compose',
    title: 'Draft a reply',
    hint: 'A response to what is here',
    body: 'Draft a reply to the message or post on this page. Match its register — formal if it is formal, brief if it is brief. Give me the draft only, with no preamble about what you have written.'
  },
  {
    id: 'p-rewrite',
    slug: 'rewrite',
    glyph: 'refresh',
    title: 'Rewrite this',
    hint: 'Clearer, same meaning',
    body: 'Rewrite the main text of this page to be clearer and tighter without changing what it means or dropping any of its claims. Keep the original structure. Then list, in one line each, what you changed and why.'
  },
  {
    id: 'p-code',
    slug: 'code',
    glyph: 'copy',
    title: 'Explain the code',
    hint: 'What it does, and its traps',
    body: 'Explain the code on this page: what it does, how it is meant to be used, and what would break if I changed it. Call out anything that looks wrong, unsafe, or surprising — and say if nothing does.'
  },
  {
    id: 'p-form',
    slug: 'form',
    glyph: 'cursor',
    title: 'Fill this form',
    hint: 'What goes in each field',
    body: 'Using the details I have given you, tell me exactly what to put in each field of the form on this page, field by field in the order they appear. Say which fields you cannot fill from what you know, rather than inventing values for them.'
  },
  {
    id: 'p-links',
    slug: 'links',
    glyph: 'globe',
    title: 'Where does this go?',
    hint: 'Links and contacts on the page',
    body: 'List the links and contact details on this page that are worth keeping — where each one leads and why I would use it. Skip navigation, cookie notices, and social buttons.'
  }
];
