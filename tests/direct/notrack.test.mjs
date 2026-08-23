/**
 * notrack.js, driven end to end in Node.
 *
 * The engines take a `fetch` and a `chrome.*` and nothing else, so a fake
 * `globalThis.fetch` returning a ReadableStream drives the whole path —
 * including the streaming, which is the half a recorded-body fixture cannot
 * exercise. Chunks are split mid-line and mid-character on purpose: that is
 * where `stream.js` earns its keep, and a reply that gains a replacement
 * character in the middle is indistinguishable from one the provider sent.
 *
 * Run: node tests/direct/notrack.test.mjs
 */

import assert from 'node:assert/strict';
import * as notrack from '../../src/background/transport/direct/notrack.js';

let passed = 0;
const test = async (name, fn) => {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}\n       ${err.message}`);
    process.exitCode = 1;
  }
};

/** An SSE body delivered in byte-level slices, so line and character
 *  boundaries land in the wrong places on purpose. */
function streamOf(text, { sliceAt = 7, status = 200, contentType = 'text/event-stream' } = {}) {
  const bytes = new TextEncoder().encode(text);
  let i = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (i >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(i, i + sliceAt));
      i += sliceAt;
    }
  });
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h) => (h.toLowerCase() === 'content-type' ? contentType : null) },
    body,
    text: async () => text
  };
}

const sse = (frames) => frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('');

let lastRequest = null;
const install = (response) => {
  globalThis.fetch = async (url, init) => {
    lastRequest = { url, init, body: init?.body ? JSON.parse(init.body) : null };
    return typeof response === 'function' ? response() : response;
  };
};

console.log('notrack engine');

await test('exports the interface index.js calls', () => {
  for (const key of ['id', 'images', 'files', 'EMPTY', 'resumable', 'session', 'probe', 'ask', 'forget']) {
    assert.ok(key in notrack, `missing export: ${key}`);
  }
  assert.equal(notrack.id, 'notrack');
  assert.equal(notrack.images, false, 'no verified upload flow, so this must stay false');
  assert.equal(notrack.files, false);
  assert.deepEqual(notrack.EMPTY, { chatId: null });
  assert.equal(notrack.resumable({ chatId: 'x' }), true);
  assert.equal(notrack.resumable({}), false);
  assert.equal(notrack.resumable(null), false);
});

await test('streams a reply, splitting chunks mid-line and mid-character', async () => {
  install(
    streamOf(
      sse([
        { type: 'chat_meta', chat_id: 'c-1', mode: 'usual' },
        { type: 'user', turn: 0, content: 'ping', message_id: 'm0' },
        { type: 'thinking', speaker: 'C', turn: 1 },
        { type: 'delta', speaker: 'C', turn: 1, chunk: 'Héllo — ' },
        { type: 'delta', speaker: 'C', turn: 1, chunk: 'wörld 😀' },
        { type: 'done' }
      ]),
      { sliceAt: 3 } // small enough to split multi-byte characters
    )
  );

  const seen = [];
  const answer = await notrack.ask({ prompt: 'ping', onText: (t) => seen.push(t) });

  assert.equal(answer.text, 'Héllo — wörld 😀', 'multi-byte characters survived the split');
  assert.equal(answer.thread.chatId, 'c-1', 'chat_id captured for the next turn');
  assert.equal(answer.attached, false);
  assert.ok(seen.length >= 2, 'onText fired progressively, not once at the end');
  assert.ok(seen[seen.length - 1] === answer.text);
});

await test('turn 0 is our own question and never becomes the answer', async () => {
  install(
    streamOf(
      sse([
        { type: 'chat_meta', chat_id: 'c-2' },
        { type: 'user', turn: 0, content: 'WHAT I ASKED' },
        { type: 'delta', turn: 1, chunk: 'the reply' },
        { type: 'done' }
      ])
    )
  );
  const answer = await notrack.ask({ prompt: 'WHAT I ASKED' });
  assert.equal(answer.text, 'the reply');
  assert.ok(!answer.text.includes('WHAT I ASKED'));
});

await test('a message frame REPLACES its deltas rather than appending', async () => {
  install(
    streamOf(
      sse([
        { type: 'chat_meta', chat_id: 'c-3' },
        { type: 'delta', turn: 1, chunk: 'PO' },
        { type: 'delta', turn: 1, chunk: 'NG' },
        { type: 'message', turn: 1, content: 'PONG' },
        { type: 'done' }
      ])
    )
  );
  const answer = await notrack.ask({ prompt: 'x' });
  assert.equal(answer.text, 'PONG', 'got "PONGPONG" — deltas and message were concatenated');
});

await test('several turns stay separate and in order', async () => {
  install(
    streamOf(
      sse([
        { type: 'chat_meta', chat_id: 'c-4' },
        { type: 'delta', speaker: 'B', turn: 2, chunk: 'second' },
        { type: 'delta', speaker: 'A', turn: 1, chunk: 'first' },
        { type: 'done' }
      ])
    )
  );
  const answer = await notrack.ask({ prompt: 'x' });
  assert.equal(answer.text, 'first\n\nsecond', 'turns sorted by turn number, not arrival');
});

await test('a resumed thread posts its chat_id back', async () => {
  install(streamOf(sse([{ type: 'delta', turn: 1, chunk: 'ok' }, { type: 'done' }])));
  await notrack.ask({ prompt: 'x', thread: { chatId: 'keep-me' } });
  assert.equal(lastRequest.body.chat_id, 'keep-me');

  install(streamOf(sse([{ type: 'delta', turn: 1, chunk: 'ok' }, { type: 'done' }])));
  await notrack.ask({ prompt: 'x' });
  assert.equal(lastRequest.body.chat_id, null, 'a fresh chat sends null, not an omitted field');
});

await test('an accepted request that sends nothing is retryable, once', async () => {
  install(streamOf(''));
  await assert.rejects(
    () => notrack.ask({ prompt: 'x' }),
    (err) => {
      assert.equal(err.retryable, true, 'a dropped connection is worth one more attempt');
      return true;
    }
  );
});

await test("a JSON body instead of a stream repeats the endpoint's own words", async () => {
  install(streamOf(JSON.stringify({ error: 'too many requests, slow down' }), { contentType: 'application/json' }));
  await assert.rejects(
    () => notrack.ask({ prompt: 'x' }),
    (err) => {
      assert.ok(err.message.includes('too many requests, slow down'), err.message);
      assert.ok(!err.retryable, 'the endpoint spoke; asking again is not the answer');
      return true;
    }
  );
});

await test('events with no text name the keys that did arrive', async () => {
  install(streamOf(sse([{ type: 'surprise', payload: 1 }, { type: 'done' }])));
  await assert.rejects(
    () => notrack.ask({ prompt: 'x' }),
    (err) => {
      assert.ok(/shape has most likely changed/.test(err.message), err.message);
      assert.ok(/type|payload/.test(err.message), 'the error should name the keys seen');
      return true;
    }
  );
});

await test('a non-200 carries status and is never marked stale', async () => {
  install(streamOf('nope', { status: 429 }));
  await assert.rejects(
    () => notrack.ask({ prompt: 'x' }),
    (err) => {
      assert.equal(err.status, 429);
      assert.ok(!err.stale, 'there is no credential here, so a refresh would change nothing');
      return true;
    }
  );
});

await test('an attachment is refused rather than sent without the file', async () => {
  install(streamOf(sse([{ type: 'delta', turn: 1, chunk: 'hi' }, { type: 'done' }])));
  await assert.rejects(
    () => notrack.ask({ prompt: 'x', image: 'data:image/png;base64,AAA' }),
    /needs the window/
  );
});

await test('session resolves without a network call', async () => {
  globalThis.fetch = async () => {
    throw new Error('session() must not reach the network');
  };
  assert.ok(await notrack.session());
  await notrack.forget(); // must not throw
});

console.log(`\n${passed} passed${process.exitCode ? ', with failures' : ''}`);
