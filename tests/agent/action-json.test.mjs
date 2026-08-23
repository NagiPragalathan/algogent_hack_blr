/**
 * The action block has to parse, and the answer inside it has to render.
 *
 * Two halves of one journey, tested end to end because that is where it broke.
 * The prompt asks for the answer as MARKDOWN — "## " headings, "- " bullets, a
 * table when the items share fields — and the answer travels inside a JSON
 * string. A model writing a document does not write it as one line with \n
 * between the paragraphs; it presses return. `JSON.parse` rejects a raw control
 * character inside a string outright.
 *
 * So the instruction that made answers readable is the same instruction that
 * made them unreadable one layer down: the run reaches `finish`, the reply
 * carries the finished answer, and `parseAction` reports "Could not read an
 * action from that reply". The work is discarded a step from the finish line and
 * nothing on screen says why.
 *
 * The bottom half of this file drives the panel's own renderer over the answer
 * that comes out, because "it parsed" is not the thing being asked for — "the
 * user can read it" is.
 *
 * Run: node tests/agent/action-json.test.mjs
 */

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`);
  }
};

const { parseAction } = await import('../../src/background/agent/protocol.js');
const { renderMarkdown } = await import('../../src/sidepanel/lib/markdown.js');

const F = '```';
const fenced = (body) => `${F}json\n${body}\n${F}`;

/** The action out of a reply, or null. */
const act = (reply) => parseAction(reply).action || null;

console.log('\nthe shape the prompt asks for');

/**
 * A heading, a table and bullets, written the way a model writes them: with
 * real newlines. This exact reply returned no action at all before.
 */
const REAL_ANSWER =
  '## Top picks\n' +
  '\n' +
  '| Tool | Price |\n' +
  '|---|---|\n' +
  '| Copilot | $10/mo |\n' +
  '| Cursor | Free tier |\n' +
  '\n' +
  '- **GitHub Copilot** — $10/mo, best for autocomplete\n' +
  '- **Cursor** — free tier, best for whole-file edits\n' +
  '\n' +
  'I could not check Windsurf: the pricing page would not load.';

const REAL_REPLY = fenced(
  '{"thought":"collected all of them","action":"finish","answer":"' +
    REAL_ANSWER.replace(/"/g, '\\"') +
    '"}'
);

{
  const a = act(REAL_REPLY);
  ok('a markdown answer with real newlines parses', a?.action === 'finish');
  ok('and every line of it survives', a?.answer === REAL_ANSWER, JSON.stringify(a?.answer));
  ok('the thought comes with it', a?.thought === 'collected all of them');
}

console.log('\nthe individual mistakes, each on its own');

const cases = [
  [
    'raw newlines',
    fenced('{"action":"finish","answer":"## Picks\n\n- **A** — one"}'),
    '## Picks\n\n- **A** — one'
  ],
  [
    'a raw tab',
    fenced('{"action":"finish","answer":"name\tvalue"}'),
    'name\tvalue'
  ],
  [
    'a raw carriage return',
    fenced('{"action":"finish","answer":"one\r\ntwo"}'),
    'one\r\ntwo'
  ],
  [
    'an unescaped inner quote',
    fenced('{"action":"finish","answer":"It says "free tier" here."}'),
    'It says "free tier" here.'
  ],
  [
    'a fenced code block inside the answer',
    fenced('{"action":"finish","answer":"Run:\n\n' + F + 'sh\nnpm i\n' + F + '"}'),
    'Run:\n\n' + F + 'sh\nnpm i\n' + F
  ],
  [
    'no fence around the object at all',
    '{"action":"finish","answer":"## Picks\n\n- one"}',
    '## Picks\n\n- one'
  ],
  [
    'prose in front of the block',
    'Here is the summary you asked for:\n\n' +
      fenced('{"action":"finish","answer":"## Done\n\n- one\n- two"}'),
    '## Done\n\n- one\n- two'
  ]
];

for (const [name, reply, want] of cases) {
  const a = act(reply);
  ok(name, a?.action === 'finish' && a.answer === want, JSON.stringify(a?.answer));
}

console.log('\nwhat must not change');

/**
 * The repairs are tried in order behind the untouched text, so none of them can
 * rewrite something that already parsed. These are the cases that prove it.
 */
{
  const a = act(fenced('{"action":"finish","answer":"## Picks\\n\\n- **A** — one"}'));
  ok('a properly escaped answer is untouched', a?.answer === '## Picks\n\n- **A** — one');
}

{
  const a = act(fenced('{"action":"finish","answer":"It says “free tier” here."}'));
  ok(
    'curly quotes inside the answer stay curly',
    a?.answer === 'It says “free tier” here.',
    JSON.stringify(a?.answer)
  );
}

{
  // The object's own delimiters typed in prose. The straightening pass exists
  // for this, and it must still fire.
  const a = act('I will do: {“action”:“click”,“id”:12}');
  ok('smart-quoted delimiters are still straightened', a?.action === 'click' && a.id === 12);
}

{
  const a = act(fenced('{"x":212,y:338,"action":"click_at"}'));
  ok('a key that lost its quotes is still repaired', a?.action === 'click_at' && a.y === 338);
}

{
  const a = act(fenced('{"action":"click","id":12,}'));
  ok('a trailing comma is still repaired', a?.action === 'click' && a.id === 12);
}

{
  const a = act(fenced('{"thought":"go to a, b: c","action":"click","id":4}'));
  ok(
    'a colon inside a value is not mistaken for a key',
    a?.thought === 'go to a, b: c' && a.id === 4,
    JSON.stringify(a)
  );
}

{
  const a = act(fenced('{"action":"type","id":3,"text":"he said \\"hi\\""}'));
  ok(
    'an already-escaped inner quote is left alone',
    a?.text === 'he said "hi"',
    JSON.stringify(a?.text)
  );
}

{
  // JSON in a value: the model is typing an object into a form field.
  const a = act(fenced('{"action":"type","id":3,"text":"{\\"a\\": 1, \\"b\\": 2}"}'));
  ok('an object inside a string value survives', a?.text === '{"a": 1, "b": 2}', JSON.stringify(a?.text));
}

{
  const batch = parseAction(
    fenced('{"actions":[{"action":"type","id":1,"text":"a"},{"action":"click","id":2}]}')
  );
  ok('a batch still batches', batch.actions?.length === 2 && batch.action?.id === 1);
}

{
  const truncated = parseAction('```json\n{"action":"finish","answer":"## Half of');
  ok(
    'a reply cut off mid-block is still reported as truncated',
    truncated.truncated === true,
    JSON.stringify(truncated)
  );
}

console.log('\nand it renders');

/**
 * `lib/markdown.js` is what the panel runs over `run.answer` (ui/agent.js), and
 * it is pure string-to-string, so the whole journey can be driven here: the
 * reply a provider sent, through the parser, into the HTML the user reads.
 */
{
  const html = renderMarkdown(act(REAL_REPLY).answer);

  // `lib/markdown.js` offsets by two, so "## " is an h4. Asserted at the level
  // it actually emits, because thread.css styles these by tag.
  ok('the heading is a heading', html.includes('<h4>Top picks</h4>'), html.slice(0, 140));
  ok('the table is a table', html.includes('<table>') && html.includes('<th'), 'no table');
  ok('both rows are in it', html.includes('$10/mo') && html.includes('Free tier'));
  ok('the bullets are a list', /<ul>[\s\S]*<li>/.test(html));
  ok('bold is bold', /<strong>GitHub Copilot<\/strong>/.test(html));
  ok(
    'and the part it could not do is still there',
    html.includes('could not check Windsurf'),
    'the honest half must survive the render too'
  );
  ok(
    'nothing rendered as one wall of pipes',
    !html.includes('| Tool | Price |'),
    'the table fell through to a paragraph'
  );
}

{
  // The answer is provider text passing through a model — it must not be able
  // to put markup in the panel.
  const a = act(fenced('{"action":"finish","answer":"<img src=x onerror=alert(1)>\nand **bold**"}'));
  const html = renderMarkdown(a.answer);
  ok('markup in the answer is escaped', !html.includes('<img'), html);
  ok('while the markdown around it still renders', html.includes('<strong>bold</strong>'));
}

console.log('\nthe shapes that used to render as a wall');

/**
 * The measured failure, from a run comparing AI coding tools. The model wrote a
 * line per field with single newlines between them, and the renderer folded them
 * into one paragraph: "Company: Anysphere Main purpose: AI-first code editor
 * Key features: … Pricing/free plan: …". Every fact present, every boundary
 * between them gone, five items over.
 */
{
  const answer = 'Company: Anysphere\nMain purpose: AI-first code editor\nPricing: from $20/month';
  const html = renderMarkdown(answer);

  ok(
    'a line the model typed is a line the reader gets',
    html.includes('Company: Anysphere<br>Main purpose:'),
    html
  );
  ok('and it is still one paragraph, not three', (html.match(/<p>/g) || []).length === 1, html);
}

{
  // Emphasis spanning two lines still resolves: every pattern in `inline`
  // excludes a newline, and none of them excludes the <br> that replaced it.
  const html = renderMarkdown('**bold\ntext** after');
  ok('emphasis across a line break survives', html.includes('<strong>bold<br>text</strong>'), html);
}

{
  // A blank line is still a paragraph break — the <br> must not swallow it.
  const html = renderMarkdown('one\n\ntwo');
  ok('a blank line is still a new paragraph', (html.match(/<p>/g) || []).length === 2, html);
  ok('and no stray break between them', !html.includes('<br>'), html);
}

{
  // The three levels the answer instruction asks for must come out as three
  // different tags, or thread.css has nothing to tell them apart by.
  const html = renderMarkdown('# One\n\n## Two\n\n### Three');
  ok('# is an h3', html.includes('<h3>One</h3>'), html);
  ok('## is an h4', html.includes('<h4>Two</h4>'), html);
  ok('### is an h5', html.includes('<h5>Three</h5>'), html);
}

{
  // The shape the prompt now asks for, end to end.
  const html = renderMarkdown(
    '## Top picks\n\n### Cursor\n\n- **Company** — Anysphere\n- **Pricing** — from $20/month\n'
  );
  ok(
    'a section heading and an item heading are different tags',
    html.includes('<h4>Top picks</h4>') && html.includes('<h5>Cursor</h5>'),
    html
  );
  ok('the fields are list items', (html.match(/<li>/g) || []).length === 2, html);
}

{
  // Sources are asked for as markdown links because only that form is made
  // clickable. If this ever stops working the instruction is a lie.
  const html = renderMarkdown('- **Source** — [cursor.com/pricing](https://cursor.com/pricing)');
  ok(
    'a source link is clickable',
    html.includes('href="https://cursor.com/pricing"') && html.includes('target="_blank"'),
    html
  );
  ok('and a javascript: href is not', renderMarkdown('[x](javascript:alert(1))').includes('href="#"'));
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
