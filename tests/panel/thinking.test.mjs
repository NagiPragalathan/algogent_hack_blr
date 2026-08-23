/**
 * `thinkingExcerpt`, driven in Node.
 *
 * It lives in `lib/` precisely so this needs no DOM — it is string work, and
 * the inputs that matter are all HALF-WRITTEN, because that is what a streamed
 * reply looks like every time it is sampled.
 *
 * Run: node tests/panel/thinking.test.mjs
 */

import assert from 'node:assert/strict';
import { thinkingExcerpt } from '../../src/sidepanel/lib/thinking.js';

let passed = 0;
const test = (name, fn) => {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}\n       ${err.message}`);
    process.exitCode = 1;
  }
};

console.log('thinkingExcerpt');

test('nothing yet reads as nothing, so the caller can fall back', () => {
  assert.equal(thinkingExcerpt(''), '');
  assert.equal(thinkingExcerpt('   \n  '), '');
  assert.equal(thinkingExcerpt(null), '');
  assert.equal(thinkingExcerpt(undefined), '');
});

test('an unterminated thought still shows — which is the whole point', () => {
  const mid = '```json\n{"thought": "I need to click the News tab to filt';
  assert.equal(thinkingExcerpt(mid), 'I need to click the News tab to filt');
});

test('a complete action shows the thought, not the action', () => {
  const done = '{"thought":"The results are visible","action":"click","id":13}';
  assert.equal(thinkingExcerpt(done), 'The results are visible');
});

test('reasoning, thinking and plan are accepted too', () => {
  assert.equal(thinkingExcerpt('{"reasoning":"because X"}'), 'because X');
  assert.equal(thinkingExcerpt('{"plan":"do Y"}'), 'do Y');
});

test('escapes inside the thought do not end it early', () => {
  const quoted = '{"thought":"click the \\"News\\" tab now","action":"click"}';
  assert.equal(thinkingExcerpt(quoted), 'click the "News" tab now');
});

test('an escaped newline becomes a space, not a line break', () => {
  assert.equal(thinkingExcerpt('{"thought":"one\\ntwo"}'), 'one two');
});

test('no thought yet falls back to prose, never raw syntax', () => {
  const bare = '```json\n{"action":"cl';
  const out = thinkingExcerpt(bare);
  assert.ok(!out.includes('{'), `syntax leaked: ${out}`);
  assert.ok(!out.includes('"'), `syntax leaked: ${out}`);
  assert.ok(!out.includes('```'), `fence leaked: ${out}`);
  // The stripped quotes leave gaps that whitespace-collapsing turns into single
  // spaces, so this is 'action : cl' rather than 'action:cl'. Ugly, and still
  // far better than showing the reader a half-written JSON object.
  assert.equal(out, 'action : cl');
});

test('plain prose passes through', () => {
  assert.equal(thinkingExcerpt('Let me look at the news tab.'), 'Let me look at the news tab.');
});

test('cut from the START, so it does not slide about on every delta', () => {
  const long = `{"thought":"${'a'.repeat(300)}"}`;
  const out = thinkingExcerpt(long, 140);
  assert.equal(out.length, 141, 'limit plus the ellipsis');
  assert.ok(out.startsWith('aaa'));
  assert.ok(out.endsWith('…'));
});

test('growing text keeps the same prefix — no flicker', () => {
  const a = thinkingExcerpt('{"thought":"I am reading the');
  const b = thinkingExcerpt('{"thought":"I am reading the page now');
  assert.ok(b.startsWith(a), `${JSON.stringify(b)} should extend ${JSON.stringify(a)}`);
});

console.log(`\n${passed} passed${process.exitCode ? ', with failures' : ''}`);
