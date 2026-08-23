import { highlight, languageName } from './highlight.js';
import { icon } from './icons.js';

/**
 * Minimal markdown renderer.
 *
 * Everything is HTML-escaped BEFORE any markdown transformation runs, so text
 * arriving from a provider page can never inject markup into the panel. Links
 * are additionally restricted to http/https/mailto.
 *
 * Fenced code is the one exception to "escape first, transform after", and it
 * is not a loophole: it is handed to `highlight()` as RAW text, and that
 * escapes every character it emits. Escaping first and colouring afterwards
 * would mean running regexes over `&lt;` and `&amp;`, where a single token
 * spanning an entity turns a provider's answer into markup.
 */

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

function safeHref(href) {
  const trimmed = href.trim();
  return /^(https?:|mailto:)/i.test(trimmed) ? trimmed : '#';
}

function inline(text) {
  return text
    .replace(/`([^`\n]+)`/g, (_, code) => `<code>${code}</code>`)
    .replace(/\*\*\*([^*\n]+)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
    .replace(
      /\[([^\]\n]+)\]\(([^)\s]+)\)/g,
      (_, label, href) =>
        `<a href="${escapeHtml(safeHref(href))}" target="_blank" rel="noopener noreferrer">${label}</a>`
    );
}

/**
 * A fenced block, as a card with its language and a copy button.
 *
 * The button is the reason code lands in a chat panel at all — the alternative
 * is selecting text inside a box that is also horizontally scrollable, in a
 * 400px-wide window. It carries no handler: `app/events.js` listens once on the
 * thread, because this HTML is rebuilt on every streamed delta and a listener
 * attached here would be thrown away several times a second.
 */
function codeBlock(code, lang) {
  /**
   * Nothing in it, nothing to draw.
   *
   * A reply is re-rendered on every streamed delta, and the first delta of a
   * fenced answer is the opening ``` on its own — so the panel drew a full card,
   * language label and Copy button around an empty box, sometimes before the
   * provider had produced a single character. It also catches the tail case: a
   * provider whose loading indicator converts to a stray fence.
   */
  if (!code.trim()) return '';

  const name = languageName(lang);
  const label = name || 'code';

  return (
    `<div class="code-block">` +
    `<div class="code-head">` +
    `<span class="code-lang">${escapeHtml(label)}</span>` +
    `<button class="code-copy" type="button" title="Copy this snippet">` +
    `${icon('copy', 13)}<span>Copy</span>` +
    `</button>` +
    `</div>` +
    `<pre><code${name ? ` class="language-${escapeHtml(name)}"` : ''}>` +
    `${highlight(code, name)}` +
    `</code></pre>` +
    `</div>`
  );
}

/**
 * A GFM table row, split into cells.
 *
 * Leading and trailing pipes are optional in the wild and providers emit both
 * shapes, so they are stripped before splitting rather than required. Escaped
 * pipes inside a cell are not supported and do not need to be: this runs on
 * escaped text, where a literal `|` in prose is just a pipe.
 */
function tableCells(line) {
  return line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((cell) => cell.trim());
}

/** `| --- | :--: |` — the row that makes the line above it a header. */
function isDelimiterRow(line) {
  if (!line || !line.includes('|')) return false;
  const cells = tableCells(line);
  return cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c));
}

/** left / center / right, from the colons in the delimiter row. */
function alignOf(cell) {
  const left = cell.startsWith(':');
  const right = cell.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  if (left) return 'left';
  return '';
}

export function renderMarkdown(src) {
  if (!src) return '';

  const escaped = escapeHtml(src);
  const lines = escaped.split('\n');
  // Escaping never adds or removes a newline, so the two are the same length
  // and a code line can be taken raw by index while everything else stays safe.
  const rawLines = String(src).split('\n');
  const out = [];

  let inCode = false;
  let codeLang = '';
  let codeBuffer = [];
  let listType = null;
  let paragraph = [];

  /**
   * A newline the writer typed is a newline the reader gets.
   *
   * CommonMark says a single newline inside a paragraph is a SPACE, and that
   * is right for a document. It is wrong here, and the measured failure is the
   * shape these answers actually arrive in: a model asked to list five tools
   * writes a line per field —
   *
   *   Company: Anysphere
   *   Main purpose: AI-first code editor
   *   Key features: agent coding, tab autocomplete, MCP servers
   *   Pricing: Hobby is free; individual plans from $20/month
   *
   * — and joining those with a space produced exactly one run-on paragraph:
   * "Company: Anysphere Main purpose: AI-first code editor Key features: …".
   * Every fact present, every boundary between them gone, five times over. It
   * is the same failure the table branch below was written for, one level down.
   *
   * Every chat surface people compare this one to — GitHub comments, Slack,
   * the providers’ own UIs — breaks on a single newline for the same reason.
   * Pressing return means pressing return.
   *
   * The join happens BEFORE `inline`, not after, so emphasis and a link that
   * span two lines still resolve: every pattern in `inline` excludes `
` but
   * none of them excludes the `<br>` that replaced it. Inserting our own
   * markup after `escapeHtml` is safe for the same reason the table cells are:
   * the text is already escaped, so this tag cannot be one of theirs.
   */
  const flushParagraph = () => {
    if (!paragraph.length) return;
    out.push(`<p>${inline(paragraph.join('<br>'))}</p>`);
    paragraph = [];
  };

  const closeList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };

  /** Line indexes already swallowed by a multi-line block (a table body). */
  const consumed = new Set();

  lines.forEach((line, index) => {
    if (consumed.has(index)) return;

    const fence = line.match(/^\s*```(\w+)?\s*$/);

    if (fence) {
      if (inCode) {
        out.push(codeBlock(codeBuffer.join('\n'), codeLang));
        codeBuffer = [];
        inCode = false;
      } else {
        flushParagraph();
        closeList();
        codeLang = fence[1] || '';
        inCode = true;
      }
      return;
    }

    if (inCode) {
      codeBuffer.push(rawLines[index]);
      return;
    }

    if (!line.trim()) {
      flushParagraph();
      closeList();
      return;
    }

    /**
     * A table, which used to come out as one long line of pipes.
     *
     * Nothing here handled them, so a table fell through to `paragraph` — and
     * `flushParagraph` joins its lines with a SPACE. A four-row comparison
     * table arrived as "Course | Cost | Time | Best for | Machine Learning
     * Specialization | Free to audit | ~2 months | …" in a single wrapped
     * paragraph: every value present, every relationship between them gone.
     * Comparisons are one of the things people most often ask two models for,
     * so this was breaking the answers that most needed structure.
     */
    if (line.includes('|') && isDelimiterRow(lines[index + 1])) {
      flushParagraph();
      closeList();

      const align = tableCells(lines[index + 1]).map(alignOf);
      const head = tableCells(line);
      const rows = [];

      // Consume the body here, and mark those lines consumed so the loop's
      // later passes do not render them a second time as paragraphs.
      let cursor = index + 2;
      while (cursor < lines.length && lines[cursor].includes('|') && lines[cursor].trim()) {
        rows.push(tableCells(lines[cursor]));
        cursor += 1;
      }
      for (let i = index; i < cursor; i += 1) consumed.add(i);

      const cell = (tag, text, i) => {
        const a = align[i] ? ` style="text-align:${align[i]}"` : '';
        return `<${tag}${a}>${inline(text ?? '')}</${tag}>`;
      };

      out.push(
        // Its own scroll container: a wide comparison table must not make the
        // whole panel scroll sideways.
        '<div class="md-table-wrap"><table>',
        `<thead><tr>${head.map((c, i) => cell('th', c, i)).join('')}</tr></thead>`,
        '<tbody>',
        ...rows.map(
          (r) => `<tr>${head.map((_, i) => cell('td', r[i], i)).join('')}</tr>`
        ),
        '</tbody></table></div>'
      );
      return;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      closeList();
      const level = Math.min(heading[1].length + 2, 6);
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      return;
    }

    if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) {
      flushParagraph();
      closeList();
      out.push('<hr />');
      return;
    }

    const quote = line.match(/^\s*&gt;\s?(.*)$/);
    if (quote) {
      flushParagraph();
      closeList();
      out.push(`<blockquote>${inline(quote[1])}</blockquote>`);
      return;
    }

    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      flushParagraph();
      const want = ul ? 'ul' : 'ol';
      if (listType !== want) {
        closeList();
        out.push(`<${want}>`);
        listType = want;
      }
      out.push(`<li>${inline((ul || ol)[1])}</li>`);
      return;
    }

    closeList();
    paragraph.push(line.trim());
  });

  // A block still open is a reply that is mid-stream, or one that was cut off:
  // render what has arrived rather than dropping it.
  if (inCode) out.push(codeBlock(codeBuffer.join('\n'), codeLang));
  flushParagraph();
  closeList();

  return out.join('');
}
