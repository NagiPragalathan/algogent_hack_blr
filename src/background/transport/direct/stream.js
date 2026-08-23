/**
 * Reading a fetch response line by line, as the bytes arrive.
 *
 * Every provider's own API streams — server-sent events on ChatGPT and Claude,
 * newline-delimited JSON on Meta, length-framed batchexecute chunks on Gemini —
 * and all four are line-oriented. Buffering the whole body with
 * `await response.text()` works and is what the reference engines do, but it
 * throws away the one thing that makes a direct call *feel* fast: the first
 * words land in about a second, and the last ones twenty seconds later. Waiting
 * for the last to show the first is paying the full price of a slow answer and
 * getting none of the benefit.
 *
 * So this yields complete lines. A chunk boundary in the middle of a line is
 * held back until its newline arrives, which is what makes every caller safe to
 * write as "parse this line as JSON" — a half-parsed frame is the failure mode
 * that would otherwise show up as an intermittently truncated reply.
 *
 * Closing the consumer (a `break`, or an abort) runs the `finally` and cancels
 * the reader, which is what actually stops the provider generating: an
 * abandoned response body keeps streaming until the server gives up on it.
 */
export async function* lines(response) {
  if (!response.body) {
    // No streaming body — a mocked response, or a body already consumed.
    // Falling back to the whole text keeps callers to one code path.
    for (const line of (await response.text()).split('\n')) yield line;
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;

      // `stream: true` so a multi-byte character split across two chunks is
      // held rather than decoded as two replacement characters — which lands
      // in the middle of the answer as visible mojibake.
      buffer += decoder.decode(value, { stream: true });

      let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        yield buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
      }
    }

    buffer += decoder.decode();
    if (buffer) yield buffer;
  } finally {
    reader.cancel().catch(() => {});
  }
}

/**
 * A signal that gives up on SILENCE, not on elapsed time, and that Stop can
 * still reach.
 *
 * The relay path has a watchdog because a hidden tab can wedge without saying
 * so; a direct call has the same problem for a different reason — a socket that
 * stalls mid-stream never rejects, so the panel sits on a spinner with nothing
 * behind it. A plain deadline is the wrong instrument for that, because the
 * thing it would kill most reliably is the case it is not for: a long answer
 * that is arriving perfectly well and simply takes two minutes. So the clock is
 * reset by `touch()` on every chunk, and only a genuinely quiet connection
 * runs it out.
 */
export function idleSignal(signal, ms) {
  const controller = new AbortController();
  let timer = null;

  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new Error('The provider stopped sending.')), ms);
  };

  const stop = () => controller.abort(signal?.reason ?? new Error('cancelled'));
  if (signal) {
    if (signal.aborted) stop();
    else signal.addEventListener('abort', stop, { once: true });
  }
  arm();

  return {
    signal: controller.signal,
    touch: arm,
    done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
    }
  };
}
