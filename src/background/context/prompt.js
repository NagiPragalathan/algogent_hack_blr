/**
 * Wrap the question with the page extract in a form the models handle well.
 *
 * XML-ish tags rather than markdown headings: every provider's chat box treats
 * markdown as formatting to render, and a page that itself contains "## Notes"
 * then becomes indistinguishable from our own scaffolding.
 */
export function buildPrompt(question, context, extras = {}) {
  const { files = [], picked = null, extraPages = [] } = extras;

  const attachments = buildAttachments(files, picked, extras.uploadName);

  if (!context) {
    return attachments.length
      ? [...attachments, '', '<question>', question, '</question>'].join('\n')
      : question;
  }

  const parts = [
    'You are answering a question about web pages the user has shared.',
    'Use the content below as your primary source. If the answer is not in it, say so plainly rather than guessing.',
    '',
    ...renderPage(context, { primary: true })
  ];

  // Additional attached tabs, each as its own page so the model can tell them
  // apart and answer across them.
  for (const extra of extraPages) {
    parts.push('', ...renderPage(extra));
  }

  // Files and a pointed-at region sit outside <page>: they are things the user
  // handed over, not things the page happened to contain.
  if (attachments.length) parts.push('', ...attachments);

  parts.push('', '<question>', question, '</question>');

  return parts.join('\n');
}

/**
 * Split a page into parts on line boundaries, never mid-line.
 *
 * A page extract is one item per line — a job, a row, a comment. Cutting at a
 * character offset would hand two different turns half of the same item each,
 * and both would reasonably decide it was noise.
 *
 * Lives here rather than beside either caller because both the chat path and
 * the agent path split the same extract for the same prompt, and two copies of
 * this would drift.
 */
export function splitOnLines(text, size) {
  const parts = [];
  let current = '';

  for (const line of String(text || '').split('\n')) {
    // A line longer than a whole part has no boundary left to respect, and
    // refusing to cut it is worse than cutting it: the text comes back as one
    // part, the caller decides it does not need splitting, and the page it was
    // trying not to skim gets skimmed whole. Some pages really are one blob.
    if (line.length > size) {
      if (current) {
        parts.push(current);
        current = '';
      }
      for (let i = 0; i < line.length; i += size) parts.push(line.slice(i, i + size));
      continue;
    }

    if (current && current.length + line.length + 1 > size) {
      parts.push(current);
      current = '';
    }
    current += (current ? '\n' : '') + line;
  }

  if (current.trim()) parts.push(current);
  return parts;
}

/**
 * The longest line in `text`.
 *
 * A part stops at the last line that fits, so it lands short of its size by up
 * to one line. Callers add this to the size they ask for, because without the
 * allowance N parts never quite cover the page and one more appears carrying
 * its final few lines — a whole extra provider round trip for a rounding error.
 *
 * Callers cap it before adding it. Uncapped, one 40k-character line — a page
 * whose text arrived as a single blob — makes the part size larger than the
 * page, which produces one part and skips the part-reading entirely.
 */
export function longestLine(text) {
  let longest = 0;
  for (const line of String(text || '').split('\n')) longest = Math.max(longest, line.length);
  return longest;
}

/**
 * One part of a page, on its way out as its own provider turn.
 *
 * A single turn carrying forty thousand characters and "list every Easy Apply
 * job" reliably returns the first few and stops: the model skims a long block,
 * and nothing in the reply reveals that it skimmed. Asking part by part removes
 * the skimming — each turn is small enough to read exhaustively — and the reply
 * is deliberately a transcript rather than an answer, so nothing is judged
 * before all of the page has been seen.
 */
export function buildScanPrompt({ question, page, part, total, text }) {
  return [
    `You are reading a long web page in ${total} parts. This is part ${part}.`,
    '',
    'Do NOT answer the question yet. From THIS part only, copy out every item,',
    'row, entry or passage that could bear on it — verbatim, one per line, with',
    'whatever labels sit alongside each one. Be exhaustive: a later part cannot',
    'recover something you leave out here. If this part contains nothing',
    `relevant, reply exactly: NOTHING IN PART ${part}.`,
    '',
    `<page_part number="${part}" of="${total}">`,
    `<title>${page.title}</title>`,
    `<url>${page.url}</url>`,
    text,
    '</page_part>',
    '',
    '<question>',
    question,
    '</question>'
  ].join('\n');
}

/**
 * The final turn: everything that was found, and the actual question.
 *
 * The findings are re-sent rather than referred to. The provider's own thread
 * usually still holds them, but "usually" is doing a lot of work in a chat window
 * we do not control — a trimmed context or a reset thread would turn the last
 * turn into a confident answer drawn from nothing.
 */
export function buildAnswerPrompt({ question, findings, pages = [], extras = {} }) {
  const { files = [], picked = null } = extras;
  const attachments = buildAttachments(files, picked, extras.uploadName);

  const parts = [
    `You have now read the whole page in ${findings.length} parts. Everything you`,
    'extracted is collected below.',
    '',
    'Answer the question from it, and answer completely: include every matching',
    'item you found, not a sample. If two parts describe the same item, count it',
    'once. If something the question asks for is genuinely absent, say so.',
    ''
  ];

  for (const page of pages) {
    parts.push(`<source><title>${page.title}</title><url>${page.url}</url></source>`);
  }

  findings.forEach((text, index) => {
    parts.push('', `<findings part="${index + 1}">`, text, '</findings>');
  });

  if (attachments.length) parts.push('', ...attachments);

  parts.push('', '<question>', question, '</question>');

  return parts.join('\n');
}

function buildAttachments(files, picked, uploadName) {
  const attachments = [];

  /**
   * Name the uploaded file, because the prompt cannot contain it.
   *
   * A PDF or a document goes to the provider through its own uploader — the
   * adapter pastes the real file into the composer — so by the time the model
   * reads this text, the file is sitting beside it as an attachment. Without a
   * line saying so, a question like "does my CV match this job" gets answered
   * from the page alone, with the file quietly ignored.
   */
  if (uploadName) {
    attachments.push(
      '<uploaded_file>',
      `The user has attached “${uploadName}” to this message. Read it — it is ` +
        'part of the question, not a stray upload.',
      '</uploaded_file>'
    );
  }

  // A pointed-at region beats the whole page: the user has already told us
  // which part they mean, so it goes in ahead of the general extract.
  if (picked?.text) {
    attachments.push(
      '<selected_region>',
      `<from>${picked.title || ''} ${picked.url || ''}</from>`,
      picked.text,
      '</selected_region>'
    );
  }

  for (const file of files) {
    if (!file?.text) continue;
    attachments.push(`<file name="${file.name}">`, file.text, '</file>');
  }

  return attachments;
}

function renderPage(page, { primary = false } = {}) {
  const parts = ['<page>', `<title>${page.title}</title>`, `<url>${page.url}</url>`];

  if (primary && page.description) {
    parts.push(`<description>${page.description}</description>`);
  }

  if (primary && page.hasSelection) {
    parts.push('<user_selection>', page.selection, '</user_selection>');
  }

  parts.push(
    '<content>',
    page.text,
    page.truncated ? '\n[content truncated]' : '',
    '</content>'
  );

  // What is fillable on the page, so questions about a form can be answered
  // without the agent ever being switched on.
  if (page.forms) parts.push('<forms>', page.forms, '</forms>');

  parts.push('</page>');
  return parts;
}
