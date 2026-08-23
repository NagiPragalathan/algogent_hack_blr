/**
 * Reading a page without opening it.
 *
 * The model kept inventing this. `http_get` appears twice in one measured run —
 * an action that has never existed — because the alternative it was offered is
 * expensive and it could tell: `navigate` costs a page load, a curtain, an
 * observation and usually a screenshot, and a research task wants none of that.
 * It wants the words on the page. Twelve steps of one 32-step run went on
 * opening an article, failing to read it, screenshotting it, scrolling it and
 * opening the PDF behind it.
 *
 * So the gap was real and the fix is to fill it rather than to keep refusing.
 *
 * ANONYMOUS, ALWAYS. `credentials: 'omit'` is the one line here that is not
 * negotiable, and it is what makes this safe to hand a model. Navigating is
 * visible — the tab moves, the curtain goes up, the user can see the page being
 * read. A background fetch is invisible, so one carrying the user's cookies
 * would let a run pull their webmail, their bank or an internal wiki into the
 * prompt with nothing on screen to show it happened. Anonymous means this can
 * only ever read what any visitor could read. A page that genuinely needs the
 * login has to be navigated to, where it is on screen and the user can watch.
 */

/** Past this the model is being handed a haystack. Whole articles fit easily. */
const MAX_CHARS = 20000;

/** Give up rather than park a run on a slow host. */
const TIMEOUT_MS = 15000;

/** Anything else is a download, not a page. */
const READABLE = /^(?:text\/html|text\/plain|application\/(?:xhtml\+xml|json|xml)|text\/xml)/i;

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘',
  rdquo: '”', ldquo: '“'
};

function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000
        ? String.fromCodePoint(code)
        : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/**
 * Markup to something worth reading.
 *
 * There is no DOM in a service worker, so this is a scanner rather than a
 * parser and it will never be as good as the content script's extraction —
 * which is fine, because that one runs on a page that is actually open and this
 * one exists precisely so the page does not have to be. What it must not do is
 * hand back navigation soup: `script`, `style` and friends go FIRST, whole,
 * because stripping tags before their contents leaves a page of minified
 * JavaScript that reads like text and is not.
 *
 * Block ends become newlines before the rest of the tags go, or every heading,
 * paragraph and list item runs into the one after it and the model is given a
 * wall with no structure to quote back.
 */
export function textFromHtml(html) {
  return decodeEntities(
    String(html)
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style|noscript|template|svg|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      /**
       * Navigation chrome, dropped whole.
       *
       * Not cosmetic — it is the difference between reading an article and
       * reading a sidebar. Measured on the Wikipedia AI page before this line:
       * the first 180 characters were "Jump to content / Main menu / move to
       * sidebar / hide / Navigation / Main page / Contents / Current events…"
       * and the 20k budget was largely spent before the article began. The
       * model then reports that the page had nothing on it, which is the
       * confident wrong answer this whole file exists to avoid.
       *
       * `header` goes too even though it sometimes holds the headline, because
       * the `<title>` is captured separately and is the more reliable of the
       * two.
       */
      .replace(/<(nav|aside|footer|header)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]*\brole=["']navigation["'][^>]*>[\s\S]*?<\/[a-z]+>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|section|article|header|footer|li|tr|h[1-6]|blockquote|pre)\s*>/gi, '\n')
      .replace(/<[^>]*>/g, ' ')
  )
    .replace(/\r/g, '')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** The `<title>`, which is often the only thing naming what was fetched. */
function titleFromHtml(html) {
  const raw = String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  return raw ? decodeEntities(raw).replace(/\s+/g, ' ').trim() : '';
}

/**
 * Fetch a URL and return its readable text.
 *
 * Errors are RETURNED, never thrown: every one of them is something the model
 * can act on — try another link, navigate instead, give up on this source — and
 * a thrown one would end the step as a generic failure with the reason lost.
 * The measured failures were exactly this shape: "Could not resolve host" and a
 * 400 from a truncated URL, both of which the model could have recovered from
 * if it had been told which.
 *
 * @returns {Promise<{ok: true, title: string, url: string, text: string, truncated: boolean}
 *                  | {ok: false, error: string}>}
 */
export async function readUrl(rawUrl, { maxChars = MAX_CHARS, fetchImpl = fetch } = {}) {
  let url;
  try {
    url = new URL(String(rawUrl || '').trim());
  } catch {
    return { ok: false, error: `"${rawUrl}" is not a URL. Give the full address, including https://.` };
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, error: `Only http and https can be read this way — got ${url.protocol}` };
  }

  const stop = AbortSignal.timeout ? AbortSignal.timeout(TIMEOUT_MS) : undefined;

  let response;
  try {
    response = await fetchImpl(url.href, {
      // See the header comment. Not a default — the whole safety of this.
      credentials: 'omit',
      redirect: 'follow',
      headers: { Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8' },
      signal: stop
    });
  } catch (err) {
    return {
      ok: false,
      error:
        `Could not reach ${url.host}: ${err?.message || 'the request failed'}. ` +
        'Check the address is complete — an address cut short in the element list is the usual cause.'
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      error:
        `${url.host} answered HTTP ${response.status}. ` +
        (response.status === 403 || response.status === 401
          ? 'This page is not readable without being signed in — navigate to it instead, ' +
            'where the browser session applies.'
          : 'Try a different source.')
    };
  }

  const type = response.headers?.get?.('content-type') || '';
  if (type && !READABLE.test(type)) {
    return {
      ok: false,
      error:
        `${url.host} returned ${type.split(';')[0]}, which has no text to read. ` +
        'A PDF or an image has to be opened in the browser and looked at.'
    };
  }

  let body;
  try {
    body = await response.text();
  } catch (err) {
    return { ok: false, error: `The reply from ${url.host} could not be read: ${err?.message}` };
  }

  const text = /json|xml/i.test(type) && !/xhtml/i.test(type)
    ? body.trim()
    : textFromHtml(body);

  if (!text) {
    return {
      ok: false,
      error:
        `${url.host} returned a page with no readable text — it is most likely built by ` +
        'JavaScript after loading. Navigate to it instead so the browser can render it.'
    };
  }

  return {
    ok: true,
    url: response.url || url.href,
    title: titleFromHtml(body),
    text: text.length > maxChars ? text.slice(0, maxChars) : text,
    truncated: text.length > maxChars
  };
}
