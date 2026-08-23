/**
 * Universal provider adapter.
 *
 * Injected into a relay tab as a classic content script. It reads its provider
 * config from `window.__SIDEBAR_AI` (planted by the service worker immediately
 * before injection) so one implementation covers every provider — the only
 * thing that differs between ChatGPT, Gemini, Claude and Meta AI is the
 * selector table.
 *
 * Completion detection deliberately does NOT rely on any single signal. It
 * combines the stop-button, an optional streaming marker, and text stability,
 * so losing one selector to a UI change degrades rather than breaks it.
 */

(() => {
  if (window.__sidebarAIAdapterLoaded) return;
  window.__sidebarAIAdapterLoaded = true;

  const HANDSHAKE = '__sidebar_ai_handshake__';
  const TO_ADAPTER = '__sidebar_ai_to_adapter__';
  const FROM_ADAPTER = '__sidebar_ai_from_adapter__';

  /**
   * This file runs two ways.
   *
   *  - Window mode: injected into a relay tab, configured through
   *    `window.__SIDEBAR_AI`, addressed by tab id.
   *  - Embedded mode: it is a declared content script, so it also loads in
   *    every provider frame — including the invisible offscreen frames AND any
   *    tab the user has open on the same site. Those must never be driven, so
   *    it stays completely inert until the offscreen host that framed it
   *    introduces itself over postMessage.
   */
  const embedded = { active: false, provider: null, settings: null };

  const cfgOf = () => {
    if (embedded.active) {
      return { provider: embedded.provider, settings: embedded.settings };
    }
    return window.__SIDEBAR_AI || {};
  };
  const sel = (role) => (cfgOf().provider?.selectors?.[role] || []);
  const settings = () => cfgOf().settings || {};

  /**
   * Waiting, in a tab the browser has decided does not matter.
   *
   * The relay window is minimized by design, and Chrome throttles hidden pages
   * hard: timers clamp to once a second, and after five minutes hidden, chained
   * timers ("nesting level" 5 and above) clamp to once a MINUTE. A poll loop
   * built on plain `setTimeout` therefore keeps working but goes to sleep for up
   * to a minute at a time — the reply has landed, and the extension simply is
   * not awake to notice. That is the lag.
   *
   * Three defences, because none of them closes the hole alone:
   *
   *  1. MutationObserver is not a timer and is not throttled. While the answer
   *     is streaming the DOM changes constantly, so we wake on the change
   *     itself rather than waiting for a clock.
   *  2. After the last token there are no more mutations, so the settle timer
   *     still has to fire. Hopping through a MessageChannel task first resets
   *     the timer nesting level to 1, which keeps it out of the one-per-minute
   *     tier.
   *  3. That still leaves the base clamp, and measured, it is the expensive one:
   *     a chained 200ms poll runs at 200ms visible and 1000ms hidden, with the
   *     nesting reset making no difference (11.99s vs 11.95s over 12 rounds).
   *     Every quiet wait — finding the composer, waiting for the send button to
   *     enable, waiting for our own message to appear — therefore ran five times
   *     slower than intended, and an agent step is a dozen of those in a row.
   *     So the service worker, whose timers nothing throttles, ticks us while a
   *     request is in flight, and a tick wakes the waiters exactly like a
   *     mutation does. The page's own clock is now only the backstop.
   */
  const domWaiters = new Set();
  let domObserver = null;

  /** Wake everything currently sleeping. Safe to call from anywhere. */
  function wakeWaiters() {
    for (const wake of [...domWaiters]) wake();
  }

  function watchDom() {
    if (domObserver) return;
    try {
      domObserver = new MutationObserver(wakeWaiters);
      domObserver.observe(document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true
      });
    } catch {
      /* no document yet — the timer path still works */
    }
  }

  /** Yield through a non-timer task, so the next setTimeout starts unnested. */
  function freshTask() {
    return new Promise((resolve) => {
      try {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => resolve();
        channel.port2.postMessage(0);
      } catch {
        resolve();
      }
    });
  }

  /**
   * Wait up to `ms`, returning early once the page changes. `floorMs` stops a
   * busy page from spinning the loop faster than it can usefully be read.
   */
  async function sleep(ms, floorMs = 80) {
    watchDom();
    await freshTask();

    return new Promise((resolve) => {
      const startedAt = Date.now();
      let settled = false;

      const finish = () => {
        if (settled) return;
        settled = true;
        domWaiters.delete(wake);
        clearTimeout(timer);
        resolve();
      };

      const wake = () => {
        if (Date.now() - startedAt >= floorMs) finish();
      };

      domWaiters.add(wake);
      const timer = setTimeout(finish, ms);
    });
  }

  /** First element matching any candidate selector, or null. */
  function pick(role, root = document) {
    for (const s of sel(role)) {
      try {
        const el = root.querySelector(s);
        if (el) return el;
      } catch {
        /* malformed user-supplied selector — skip it */
      }
    }
    return null;
  }

  /** All elements matching the first candidate selector that matches anything. */
  function pickAll(role, root = document) {
    for (const s of sel(role)) {
      try {
        const list = root.querySelectorAll(s);
        if (list.length) return Array.from(list);
      } catch {
        /* ignore */
      }
    }
    return [];
  }

  function isInteractable(el) {
    if (!el) return false;
    if (el.disabled) return false;
    if (el.getAttribute?.('aria-disabled') === 'true') return false;
    return el.getClientRects().length > 0;
  }

  async function waitFor(fn, timeoutMs, intervalMs = 200) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const val = fn();
      if (val) return val;
      if (Date.now() > deadline) return null;
      await sleep(intervalMs);
    }
  }

  // ---------------------------------------------------------------- input ---

  /**
   * Hand text to a rich editor as a paste, and say whether it took.
   *
   * Shared by the fast path for long prompts and the fallback for short ones,
   * so there is one place that knows the shape of the event. Verified rather
   * than assumed: an editor with no paste handler swallows this silently, and
   * a silent no-op here is a question sent empty.
   */
  function pasteInto(el, text) {
    try {
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      el.dispatchEvent(
        new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt })
      );
    } catch {
      return false;
    }
    return (el.innerText || '').trim().length > 0;
  }

  /**
   * Put text into the composer.
   *
   * `document.execCommand('insertText')` emits genuine `beforeinput`/`input`
   * events, which is what ProseMirror (ChatGPT, Claude), Quill (Gemini) and
   * Lexical (Meta) require — assigning `.value` or `.textContent` directly
   * leaves those editors' models empty and the send button disabled. It is
   * still the default, and still the only route for plain fields.
   *
   * A long prompt takes the paste route instead; see the comment on the
   * threshold below for why that is a speed fix and not a style choice.
   */
  function setComposerText(el, text) {
    el.focus();
    el.click?.();

    const isField = el.tagName === 'TEXTAREA' || el.tagName === 'INPUT';

    // Clear whatever is there.
    if (isField) {
      el.select?.();
    } else {
      const range = document.createRange();
      range.selectNodeContents(el);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }

    /**
     * A big prompt goes in as a PASTE, not as typed input.
     *
     * `execCommand('insertText')` pushes text through the editor's input
     * pipeline, and a rich editor — ChatGPT's composer is ProseMirror — turns
     * that into document work proportional to what arrived: node splitting,
     * decoration passes, a re-render. An agent turn carries the rules, the
     * task, the element list and up to several thousand characters of page, and
     * on those the insert was most of the visible "typing the message" wait.
     *
     * A paste is one transaction: the editor's own paste handler parses the
     * text once and replaces the selection. Measured on ChatGPT with an agent
     * prompt, that is the difference between seconds and a frame.
     *
     * Only above a threshold, and only for rich editors. `execCommand` remains
     * the first choice for short text and for plain fields, because it is the
     * one route that behaves identically everywhere and needs no handler on
     * the other side — and for a one-line question the difference is nothing.
     */
    const PASTE_OVER = 2000;

    /**
     * Empty a rich editor through its OWN pipeline before pasting into it.
     *
     * The range above is a DOM selection, and a rich editor does not paste
     * against one — it pastes at the index in its own model. Quill's caret sits
     * wherever the last insert left it, so a paste over a composer that still
     * holds text APPENDS: Gemini's box ended up with two verbatim copies of the
     * same agent turn, joined mid-sentence, and the second send carried both.
     * `execCommand('delete')` goes through the editor's input pipeline, so the
     * model and the DOM agree about being empty before the paste lands.
     *
     * Only when there is something to remove — on the normal path the composer
     * is already empty and this must not cost a round of editor work.
     */
    if (!isField && nodeText(el).trim()) {
      try {
        document.execCommand('delete');
      } catch {
        /* the paste below is still worth trying */
      }
    }

    if (!isField && text.length > PASTE_OVER && pasteInto(el, text)) return true;

    let ok = false;
    try {
      ok = document.execCommand('insertText', false, text);
    } catch {
      ok = false;
    }

    const current = isField ? el.value : el.innerText;
    if (ok && current && current.trim().length) return true;

    // Fallback 1: React-aware native value setter for plain fields.
    if (isField) {
      const proto =
        el.tagName === 'TEXTAREA'
          ? window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      setter?.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return (el.value || '').length > 0;
    }

    // Fallback 2: the same paste, for the short text that skipped it above.
    if (pasteInto(el, text)) return true;

    // Fallback 3: last resort, write the DOM directly and announce it.
    el.textContent = text;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
    return (el.innerText || '').trim().length > 0;
  }

  /**
   * Put an image into the composer as if it had been pasted.
   *
   * Every one of these apps handles a paste carrying files — it is how people
   * screenshot into them — so a synthetic ClipboardEvent with a File on its
   * DataTransfer is the one route that needs no upload API and no file dialog.
   */
  /**
   * One attachment, in the shape the paste needs.
   *
   * The screenshot path has always sent a bare data URL; a file the user picked
   * carries its own name and type, and both matter — a provider's uploader
   * decides what it will do with a document from the MIME type, and shows the
   * user the filename. Normalised here so the callers do not have to care.
   */
  function asAttachment(value) {
    if (!value) return null;
    if (typeof value === 'string') {
      /**
       * A different name every time, because a run sends many of these.
       *
       * ChatGPT refuses a second upload of "screenshot.jpg" with a modal —
       * "You've already uploaded this file" — and that modal then sits over the
       * composer, so the turn after it cannot be typed either. One dead
       * attachment became a dead run.
       */
      return {
        dataUrl: value,
        name: `screenshot-${Date.now().toString(36)}.jpg`,
        type: 'image/jpeg'
      };
    }
    if (!value.dataUrl) return null;
    return {
      dataUrl: value.dataUrl,
      name: value.name || 'attachment',
      type: value.type || ''
    };
  }

  /**
   * A `data:` URL as a real File, decoded here rather than fetched.
   *
   * `fetch(dataUrl)` reads better and is one more thing that can fail inside a
   * content script on a site with a strict policy — and when it does, the only
   * evidence is an attachment that never appears. Decoding is six lines and
   * cannot fail for a reason we did not cause.
   */
  function fileFromDataUrl(dataUrl, name, type) {
    const comma = String(dataUrl).indexOf(',');
    if (comma < 0) return null;

    const head = dataUrl.slice(0, comma);
    const body = dataUrl.slice(comma + 1);
    const mime = type || (head.match(/^data:([^;,]+)/) || [])[1] || 'application/octet-stream';

    let bytes;
    if (/;base64/i.test(head)) {
      const binary = atob(body);
      bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    } else {
      bytes = new TextEncoder().encode(decodeURIComponent(body));
    }

    return new File([bytes], name, { type: mime });
  }

  /**
   * The composer and everything the app draws around it.
   *
   * Not `closest('form')`: ChatGPT's composer is a ProseMirror contenteditable
   * inside plain divs with no form anywhere, so that fell back to the editor's
   * immediate parent — a box that holds the text and nothing else. The
   * attachment card renders *outside* it, which is why a file that had
   * genuinely uploaded still read as a failure.
   */
  function composerZone(composer) {
    const named = composer.closest(
      'form, [data-composer-surface], [data-testid*="composer" i], [class*="composer" i]'
    );

    // Climb from whatever named itself — the named surface is not the outer
    // edge of the composer on every app, and an attachment tray drawn as its
    // *sibling* is invisible from inside it. That was worth a wrong answer:
    // the tray fell outside the zone, no test could see the file arrive, and
    // the next route attached it a second time.
    //
    // The stop condition is the conversation, not a level count: the moment an
    // ancestor contains rendered messages it is the page, and every test built
    // on it changes on every streamed token.
    let el = named || composer;
    for (let i = 0; i < 4; i++) {
      const up = el.parentElement;
      if (!up || up === document.body || up === document.documentElement) break;
      if (holdsConversation(up)) break;
      el = up;
    }

    /**
     * Then keep climbing until the uploader's own button is inside it.
     *
     * The tray and the "+" are drawn by one component, so an ancestor holding
     * the button holds the cards. A fixed level count cannot know that: Gemini
     * nests its Quill editor four deep inside `rich-textarea` alone, so the
     * climb above lands *below* the file chips and every test in `attachFile`
     * reports "nothing happened" about a file the app had accepted.
     *
     * The button, never `input[type=file]` — a hidden input often sits at the
     * end of `<body>`, and climbing to reach it would make the zone the page.
     * `shape()` would then differ after any route at all, so route one would
     * always look confirmed and the routes that actually work on this provider
     * would never run.
     */
    const uploader = pick('attach');
    if (uploader && uploader.tagName !== 'INPUT') {
      for (let i = 0; i < 4 && !el.contains(uploader); i++) {
        const up = el.parentElement;
        if (!up || up === document.body || up === document.documentElement) break;
        if (holdsConversation(up)) break;
        el = up;
      }
    }

    return el;
  }

  /** Does this element contain rendered chat messages (i.e. is it the page)? */
  function holdsConversation(el) {
    return Boolean(
      el.querySelector(
        '[data-message-author-role], [data-testid^="conversation-turn"], ' +
          'article[data-testid], [class*="conversation" i] [class*="message" i]'
      )
    );
  }

  /**
   * Hand a file to the provider's own uploader, and say whether it arrived.
   *
   * Four routes, tried in order, because none of them works everywhere:
   * pasting is what a person does and every app handles it for images;
   * dropping is what the rest of them listen for; an `input[type=file]` is the
   * app's own path but ChatGPT only creates one once its "+" menu has been
   * opened, so opening it is a route of its own.
   *
   * The return value is the point. A silent failure here is invisible from
   * every other angle — the prompt still sends, the model still answers, and it
   * answers from the page alone while the panel shows an attachment chip. The
   * caller reports it instead.
   */
  async function attachFile(composer, attachment) {
    const file = fileFromDataUrl(
      attachment.dataUrl,
      attachment.name,
      attachment.type
    );
    if (!file) return false;

    const transfer = () => {
      const dt = new DataTransfer();
      dt.items.add(file);
      return dt;
    };

    const zone = composerZone(composer);
    const stem = attachment.name.replace(/\.[^.]+$/, '').slice(0, 12);

    /**
     * Did it land? Two tests, because neither covers the other.
     *
     * An image preview is recognisable markup; a PDF renders as a card whose
     * only dependable feature is its filename — and the filename is the one
     * thing we know. The name test runs against the whole document because the
     * card is not always inside anything we can name, and it is compared
     * against what was on screen *before* we attached: the previous turn's
     * message shows the same name, and without the before-shot every second
     * upload of the same CV would report success without doing anything.
     *
     * COUNTED, not tested for presence, and that is the whole of it. The prompt
     * NAMES the file it is carrying — `<uploaded_file>` in `context/prompt.js`,
     * without which the model answers from the page and ignores the attachment
     * — so the moment one turn has gone out, the thread above the composer says
     * the filename forever. A boolean "was it showing" is then true before we
     * attach anything, the one dependable test for a PDF is switched off for
     * the rest of the conversation, and the file has to be recognised by markup
     * alone. Measured: a CV attached to the same Gemini chat twice reported
     * “… could not be handed to Gemini — the answer below was written without
     * it.” on every turn after the first, over an answer Gemini had visibly
     * written *from the CV*. A new card adds an occurrence whatever else is on
     * screen, so the count moves and presence does not.
     *
     * `textContent`, and rate-limited. This is polled while an attachment is in
     * flight, and reading the WHOLE page is not something to do twelve times a
     * second on a provider tab the user may be looking at: `innerText` forces a
     * layout flush of the entire thread, and the old boolean form was
     * short-circuited away by `nameWasShowing` on every turn but the first, so
     * making it unconditional without this would have been a straight
     * regression. `textContent` needs no layout, and 300ms is well inside the
     * time any uploader takes to draw a card.
     */
    let nameAt = 0;
    let nameWas = 0;

    const nameCount = () => {
      if (stem.length < 4) return 0;
      const now = Date.now();
      if (now - nameAt < 300) return nameWas;
      nameAt = now;

      const text = document.body.textContent || '';
      let n = 0;
      for (let i = text.indexOf(stem); i >= 0; i = text.indexOf(stem, i + stem.length)) n++;
      nameWas = n;
      return n;
    };
    const namesBefore = nameCount();

    /**
     * How many attachment cards the composer is showing.
     *
     * Counted, not tested for presence. "Is there a card?" cannot tell a file
     * we just added from the one still sitting in the composer from a previous
     * route, which is exactly the question that has to be answered before
     * firing another route — and answering it wrong is how one CV becomes two.
     * The card itself is counted rather than an `img` inside it, or a PDF (one
     * card, two icons) counts as two.
     */
    const CARD =
      'img[src^="blob:"], img[alt*="upload" i], [data-testid*="attachment" i], ' +
      '[data-testid*="file-upload" i], [aria-label*="attachment" i], [class*="attachment" i], ' +
      // Half the apps never say "attachment" anywhere. Gemini draws
      // `<uploader-file-preview>`; others use "file-preview", "uploaded-file",
      // "file-chip". Kept narrow by pairing "file" with a word that means a
      // rendered card — a bare [class*="file" i] matches layout classes.
      '[class*="file-preview" i], [class*="filepreview" i], [class*="uploaded-file" i], ' +
      '[class*="file-chip" i], [class*="file-card" i], [data-test-id*="file" i], ' +
      'uploader-file-preview, file-preview';
    const countCards = () => {
      const found = [...zone.querySelectorAll(CARD)];
      // Drop anything nested inside another match: apps wrap a card in a
      // container that also says "attachment", and both would be counted.
      return found.filter((el) => !found.some((other) => other !== el && other.contains(el)))
        .length;
    };
    const cardsBefore = countCards();

    /**
     * A screenshot's preview, found anywhere on the page rather than in the zone.
     *
     * The zone is a guess about where an app draws its tray, and when the guess
     * is wrong every test in here answers "nothing happened" about a file the
     * app has plainly accepted — which is the failure that put a false "could
     * not be handed to Gemini" under an answer, and then let the Escape in
     * `openAttachMenu` remove the picture the app was holding. An agent run's
     * attachment is almost always an image, and an image preview is one thing
     * every app renders the same way: an `<img>` off a `blob:` or `data:` URL.
     *
     * Document-wide is safe here ONLY because of the baseline and the timing.
     * Attaching happens before a character of the prompt is typed, so nothing
     * is streaming and the conversation above is not gaining pictures on its
     * own; a count that moves during those few seconds moved because of us.
     */
    const previews = () =>
      document.querySelectorAll('img[src^="blob:"], img[src^="data:image"]').length;
    const previewsBefore = previews();

    /**
     * Has *a* file arrived since we started? Not since the last route.
     *
     * Every test here is against the state before the first route ran, because
     * the failure this guards is a route that lands after its own probe gave
     * up on it: paste is accepted, the card renders 3.2s later, and by then
     * the drop route has already handed the app a second copy. Checked before
     * each route as well as during, so a late arrival stops the sequence
     * instead of doubling it.
     */
    const landed = () =>
      countCards() > cardsBefore ||
      previews() > previewsBefore ||
      nameCount() > namesBefore ||
      dismissDuplicate();

    /**
     * Enough of the composer's shape to notice the app reacting to us.
     *
     * Descendants, not direct children, and pictures counted separately. An
     * image attachment is the case that broke the first version of this: it
     * lands several levels down, it adds no text, and it adds no direct child
     * — so the shape looked identical, the paste that had *worked* was read as
     * a failure, and the next route attached the same screenshot a second
     * time. Two thumbnails in the composer, one question.
     */
    const shape = () =>
      [
        zone.querySelectorAll('*').length,
        zone.querySelectorAll('img, canvas, svg, [style*="background-image"]').length,
        (zone.innerText || '').length
      ].join(':');

    /**
     * Did the app CONSUME the event we just dispatched?
     *
     * `preventDefault` is how a page says "I am handling this drop / this
     * paste" — it is synchronous, it costs nothing, and it is the only signal
     * available before the app has drawn anything. It is not proof the file was
     * accepted (Quill calls it on every paste because it renders its own), so
     * it never resolves `attached`. What it does is stop us moving on: a route
     * the app swallowed gets a longer probe instead of a sibling route fired at
     * the same composer.
     *
     * That distinction is what the user sees. Gemini takes the screenshot, is
     * slower than `PROBE_MS` to draw the thumbnail, and the next route hands it
     * the file a second time — so the turn goes out and a leftover thumbnail is
     * still sitting in the composer afterwards, which reads as "it typed the
     * text and attached the picture afterwards".
     */
    let consumed = false;

    const paste = () => {
      composer.focus();
      const event = new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: transfer()
      });
      composer.dispatchEvent(event);
      consumed = event.defaultPrevented;
    };

    const drop = () => {
      // On the composer, which is where a person would drop it, and let it
      // bubble: apps put the listener on a wrapper, the page, or the window,
      // and we cannot tell which from here.
      for (const type of ['dragenter', 'dragover', 'drop']) {
        const event = new DragEvent(type, {
          bubbles: true,
          cancelable: true,
          dataTransfer: transfer()
        });
        composer.dispatchEvent(event);
        // Only the drop itself. `dragover` is cancelled by anything willing to
        // be a drop target, including the page behind the composer.
        if (type === 'drop') consumed = event.defaultPrevented;
      }
      // A `drop` does not end the drag as far as the app is concerned, and
      // ChatGPT's full-window "Add anything — drop any file here" curtain is
      // drawn on `dragenter` and taken down on `dragleave`/`dragend`. Left up
      // it covers the composer and the send button for the rest of the turn.
      for (const type of ['dragleave', 'dragend']) {
        composer.dispatchEvent(
          new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() })
        );
      }
    };

    /** An input the app will accept this file through, if one exists. */
    const findInput = () =>
      [
        ...zone.querySelectorAll('input[type="file"]'),
        ...document.querySelectorAll('input[type="file"]')
      ].find((el) => {
        // Skip one that has told us it does not take this kind of file —
        // setting `files` on an image-only picker uploads nothing and looks
        // exactly like success.
        const accept = (el.accept || '').trim();
        if (!accept) return true;
        return accept.split(',').some((rule) => {
          const r = rule.trim().toLowerCase();
          if (!r) return false;
          if (r === '*/*') return true;
          if (r.startsWith('.')) return attachment.name.toLowerCase().endsWith(r);
          if (r.endsWith('/*')) return (file.type || '').startsWith(r.slice(0, -1));
          return r === (file.type || '').toLowerCase();
        });
      });

    const fillInput = (input) => {
      input.files = transfer().files;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    };

    const useFileInput = () => {
      const input = findInput();
      if (!input) return false;
      fillInput(input);
      return true;
    };

    /**
     * Open the "+" menu, use the input it renders, close it again.
     *
     * ChatGPT has no file input in the page until its attach menu has existed
     * once, so there is nothing for the route above to find. Only the menu
     * button is clicked — never the "Add photos and files" item, which opens
     * the operating system's file dialog and would park the run behind a
     * window nobody is looking at.
     */
    const openAttachMenu = async () => {
      const button = pick('attach');
      if (!isInteractable(button)) return false;

      button.click();
      const input = await waitFor(findInput, 2000, 150);

      /**
       * Put the menu away — unless the file turned up while it was opening.
       *
       * Escape is the only way we have to close a menu we did not build, and it
       * covers the send button, so a run that cannot click send is worse than
       * one missing an attachment. But Escape is also what an uploader listens
       * to for CANCEL: reaching this route at all means the earlier ones were
       * read as failures, and the commonest way that happens is a card we did
       * not recognise. So the Escape lands on an attachment that had arrived and
       * removes it — the picture appears in the composer, vanishes a second or
       * two later, and the turn is then typed and sent without it, which is
       * exactly how this was reported. Re-checked HERE rather than trusting the
       * check at the top of the loop, because the two seconds spent waiting for
       * the menu's input is the window the late card lands in.
       */
      if (!landed()) {
        document.activeElement?.dispatchEvent?.(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
        );
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      }

      if (!input) return false;
      fillInput(input);
      return true;
    };

    /**
     * How long to give one route before trying the next.
     *
     * This is "did the app acknowledge the file", not "did the bytes finish
     * uploading" — every uploader draws its card the moment it accepts the
     * file and fills in the progress afterwards.
     */
    const PROBE_MS = 3000;

    /**
     * …and longer for a route the app visibly swallowed.
     *
     * A page accepts a drop by calling `preventDefault` — the spec gives it no
     * other way — and an editor that handles its own paste does the same. So a
     * cancelled event means the file may be inside the app uploading right now,
     * and waiting is free: the turn cannot go out without it either way, while
     * moving on costs a SECOND copy that lands after the message has gone.
     *
     * The reverse does NOT hold, and a shorter probe for an uncancelled event
     * was tried and taken out. The reasoning was that an app which did not
     * cancel had ignored us, so three seconds of watching a composer that will
     * not change is waste — true often enough, and wrong in the case that
     * matters: an uploader can accept a pasted file and draw its card a beat
     * later without ever cancelling, and cutting the probe to one second then
     * fires the next route INTO a working upload. The costs are not
     * symmetrical. Being early loses the user's attachment; being late costs
     * two seconds.
     */
    const CONSUMED_PROBE_MS = 6000;

    /**
     * "You've already uploaded this file." — which means it is there.
     *
     * A run sends many screenshots and often the same one twice, and ChatGPT
     * answers a repeat with a modal rather than an upload. Left standing, that
     * modal covers the composer, so the *next* turn cannot be typed either and
     * a duplicate attachment kills the whole run. Dismissing it and reporting
     * success is the honest reading: the provider is telling us it has the
     * file.
     *
     * Gated on the wording, and the click stays inside that dialog: a rule
     * loose enough to press buttons in any modal would eventually press one
     * that matters.
     */
    const alreadyThere = /already (?:uploaded|added)|uploading something new/i;
    const dismissDuplicate = () => {
      for (const dialog of document.querySelectorAll(
        '[role="dialog"], [role="alertdialog"], dialog[open]'
      )) {
        if (!alreadyThere.test(dialog.innerText || '')) continue;

        const buttons = [...dialog.querySelectorAll('button')];
        const ok =
          buttons.find((b) => /^(ok|got it|close|dismiss)$/i.test((b.innerText || '').trim())) ||
          (buttons.length === 1 ? buttons[0] : null);
        ok?.click();
        return true;
      }
      return false;
    };

    // Shown is not the same as uploaded: the card appears while the bytes are
    // still going up, and a send during that window is dropped by some apps.
    // This is the one place a fixed wait is the right tool.
    const settle = async () => {
      await sleep(1500, 1500);
      return true;
    };

    // `dispatched` marks the routes that fire a cancellable event, and so can
    // tell "the app took this" from "the app ignored this" — see the probe
    // constants above. The input routes set `.files` directly and cannot.
    const ROUTES = [
      { fire: paste, dispatched: true },
      { fire: drop, dispatched: true },
      { fire: useFileInput, dispatched: false },
      { fire: openAttachMenu, dispatched: false }
    ];

    for (const route of ROUTES) {
      /**
       * Before anything else: did the *previous* route land after we gave up
       * on it? A route is abandoned on a timer, not on a refusal, so an app
       * that renders its card a moment past `PROBE_MS` looks identical to one
       * that ignored the file — and the only difference is that firing the
       * next route now uploads it twice. Measured on ChatGPT with a PDF: paste
       * accepted, card drawn late, drop fired anyway, two identical cards in
       * the composer and two copies sent.
       */
      if (landed()) return settle();

      const before = shape();
      consumed = false;

      try {
        if ((await route.fire()) === false) continue;
      } catch {
        continue;
      }

      /**
       * Wait for the app to react — recognisably, or at all.
       *
       * All three tests poll together rather than one after the other. Waiting
       * out the full probe on the recognisable ones and only *then* asking
       * whether the composer had changed meant three seconds per attachment on
       * every provider whose markup we cannot name, which is most of them.
       *
       * "It changed at all" counts as success on purpose: the app took the file
       * and drew something we do not recognise. Trying the next route as well
       * is how one screenshot becomes two thumbnails.
       *
       * Polled at 120ms rather than 250: this is the wait in front of every
       * screenshot of every turn, and a card that renders in 300ms was costing
       * half a poll interval on each one for nothing.
       */
      const patience = route.dispatched && consumed ? CONSUMED_PROBE_MS : PROBE_MS;
      const confirmed = await waitFor(() => landed() || shape() !== before, patience, 120);

      if (confirmed) return settle();

      /**
       * Not confirmed after all that, so carry on down the list — including
       * when the app cancelled the event.
       *
       * Stopping here reads as the safe move and is not: an editor that renders
       * its own paste cancels EVERY paste, files or no files, so a route that
       * ended the sequence on `consumed` would take the one provider whose
       * working route is the drop and never fire it. Six seconds of nothing at
       * all — no card, no change of shape — is the app telling us it did not
       * take the file, and a route it did not take cannot become a duplicate.
       */
    }

    /**
     * Every route is spent, so wait once more rather than reporting failure.
     *
     * Nothing is attached after this point, so a late card costs nothing to
     * wait for and buys back the turn: reporting "not delivered" for a file
     * the app is holding puts a false notice under an answer that did read it.
     */
    if (await waitFor(landed, 2000, 250)) return settle();

    return false;
  }

  function pressEnter(el) {
    for (const type of ['keydown', 'keypress', 'keyup']) {
      el.dispatchEvent(
        new KeyboardEvent(type, {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true
        })
      );
    }
  }

  async function submit(composer) {
    const prefersEnter = cfgOf().provider?.submitWith === 'enter';

    if (!prefersEnter) {
      // Give the app a moment to enable its send button after the input event.
      const btn = await waitFor(() => {
        const b = pick('send');
        return isInteractable(b) ? b : null;
      }, 4000, 150);
      if (btn) {
        pressButton(btn);
        return 'click';
      }
    }

    pressEnter(composer);
    return 'enter';
  }

  /**
   * A real click is a pointer sequence; `el.click()` is only its last event.
   *
   * Gemini's send is an Angular Material icon button carrying
   * `mat-ripple-loader-uninitialized` — Material defers wiring that button
   * until it sees a pointer event, and a lone `click` is not one. The same
   * lesson the agent path learned on Workday's option rows applies here, and
   * the symptom is worse: nothing throws, the button simply does not fire, and
   * the question sits in the composer looking sent.
   *
   * `click` still goes last so native activation (form submit, label
   * forwarding) behaves exactly as before for the providers this already
   * worked on.
   */
  function pressButton(el) {
    const r = el.getBoundingClientRect();
    const at = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    const fire = (type, Ctor) =>
      el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, ...at }));

    if (window.PointerEvent) {
      fire('pointerover', PointerEvent);
      fire('pointerdown', PointerEvent);
    }
    fire('mousedown', MouseEvent);
    el.focus?.();
    if (window.PointerEvent) fire('pointerup', PointerEvent);
    fire('mouseup', MouseEvent);
    el.click();
  }

  // ----------------------------------------------------------- extraction ---

  /**
   * Convert the assistant's rendered HTML back into markdown, so the side panel
   * renders headings, lists and fenced code properly instead of flat text.
   */
  function htmlToMarkdown(root) {
    if (!root) return '';

    const walk = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        return node.textContent.replace(/\s+/g, ' ');
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return '';

      const tag = node.tagName.toLowerCase();

      // Chrome-injected UI inside the message (copy buttons, feedback bars).
      if (/^(button|svg|script|style|noscript)$/.test(tag)) return '';
      if (node.getAttribute?.('aria-hidden') === 'true') return '';

      const kids = () => Array.from(node.childNodes).map(walk).join('');

      switch (tag) {
        case 'br':
          return '\n';
        case 'hr':
          return '\n---\n';
        case 'strong':
        case 'b':
          return `**${kids().trim()}**`;
        case 'em':
        case 'i':
          return `*${kids().trim()}*`;
        case 'del':
        case 's':
          return `~~${kids().trim()}~~`;
        case 'a': {
          const href = node.getAttribute('href') || '';
          const label = kids().trim();
          return href && label ? `[${label}](${href})` : label;
        }
        case 'code':
          // Inline code only — code inside <pre> is handled by the pre branch.
          if (node.closest('pre')) return node.textContent;
          return `\`${node.textContent}\``;
        case 'pre': {
          const codeEl = node.querySelector('code');
          const lang =
            (codeEl?.className || '').match(/language-([\w+-]+)/)?.[1] || '';
          const body = (codeEl || node).textContent.replace(/\n+$/, '');
          return `\n\`\`\`${lang}\n${body}\n\`\`\`\n`;
        }
        case 'h1':
        case 'h2':
        case 'h3':
        case 'h4':
        case 'h5':
        case 'h6':
          return `\n${'#'.repeat(Number(tag[1]))} ${kids().trim()}\n`;
        case 'blockquote':
          return (
            '\n' +
            kids()
              .trim()
              .split('\n')
              .map((l) => `> ${l}`)
              .join('\n') +
            '\n'
          );
        case 'li': {
          const parent = node.parentElement?.tagName.toLowerCase();
          const marker =
            parent === 'ol'
              ? `${Array.from(node.parentElement.children).indexOf(node) + 1}.`
              : '-';
          const body = kids().trim().replace(/\n/g, '\n  ');
          return `${marker} ${body}\n`;
        }
        case 'ul':
        case 'ol':
          return `\n${kids()}\n`;
        case 'p':
        case 'div':
        case 'section':
          return `\n${kids()}\n`;
        case 'table':
          return `\n${kids()}\n`;
        case 'tr':
          return `${kids()}\n`;
        case 'td':
        case 'th':
          return `${kids().trim()} | `;
        default:
          return kids();
      }
    };

    return walk(root)
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /**
   * The thread, oldest first — whatever order the DOM happens to be in.
   *
   * `pickAll` answers in document order, and for most providers that is also
   * chronological. arena.ai renders its thread into an
   * `<ol class="… flex-col-reverse">`: the newest message is the FIRST child
   * and CSS puts it at the bottom, so document order is reverse chronological —
   * and `nodes[nodes.length - 1]`, which is "the latest reply" everywhere in
   * this file, is the OLDEST one.
   *
   * That was already known here: it is why arena's `user` selector is empty,
   * because the anchored branch of `freshText` looks for assistant nodes
   * FOLLOWING the question and in a reversed thread they precede it. What the
   * note beside that missed is that the FALLBACK has the same dependency —
   * "newest assistant text" is `nodes.length - 1`, which is document order too.
   *
   * Measured: every turn of an arena run came back "Hello! How can I help you
   * today?", the first reply in the conversation, while the answer actually on
   * screen was a perfectly good JSON action. Nothing anywhere reports that as a
   * failure — the text IS a real reply, it just belongs to a question from ten
   * minutes ago — so the loop read it as the model answering in prose instead
   * of acting, pushed back, got the same stale text again, and finished in
   * three steps having touched nothing.
   *
   * Declared per provider rather than sniffed: `getComputedStyle` on a thread
   * container is a layout read on the reply loop's hot path, and
   * `flex-col-reverse` is only one of the ways a site can do this.
   *
   * A reversed thread must still keep `user: []`. This puts the ARRAY in
   * chronological order; it cannot reorder the document, so the
   * `compareDocumentPosition` branch stays wrong and has to be left unreachable.
   */
  const inThreadOrder = (nodes) =>
    cfgOf().provider?.reversedThread ? nodes.reverse() : nodes;

  function assistantNodes() {
    return inThreadOrder(pickAll('assistant').filter((el) => el.getClientRects().length > 0));
  }

  function userMessageNodes() {
    return inThreadOrder(pickAll('user').filter((el) => el.getClientRects().length > 0));
  }

  function nodeText(el) {
    if (!el) return '';
    const md = htmlToMarkdown(el);
    return md || (el.innerText || '').trim();
  }

  function latestAssistantText() {
    const nodes = assistantNodes();
    return nodes.length ? nodeText(nodes[nodes.length - 1]) : '';
  }

  /** Collapse whitespace so re-wrapped DOM text still compares equal. */
  const normalise = (s) => (s || '').replace(/\s+/g, ' ').trim();

  /**
   * How much of the sent prompt to match a rendered message against. Long
   * enough to be unique, short enough to survive the "Show more" collapsing
   * every provider applies to a long message.
   */
  const FINGERPRINT_CHARS = 80;

  /**
   * Has a streaming marker EVER matched in this tab?
   *
   * Only used to decide whether the growth sample below is worth paying for.
   * A provider whose markers work needs no second opinion; one whose markers
   * have never once fired has no streaming signal at all, and the difference
   * cannot be known from the config — arena.ai declares a `stop` selector that
   * simply does not match its button.
   */
  let streamingMarkerSeen = false;

  function isStreaming() {
    if (pick('streaming') || isInteractable(pick('stop'))) {
      streamingMarkerSeen = true;
      return true;
    }
    return false;
  }

  /** How long to watch for a reply still growing. */
  const GROWTH_SAMPLE_MS = 400;

  /**
   * How long the newest reply is, as a number that goes up while it is written.
   *
   * The signal of last resort for "is one still being written", and the one
   * nothing can take away: `isStreaming` reads two selectors, and a provider
   * that declares neither — or declares a `stop` selector that stops matching
   * when the site relabels its button — has no streaming signal whatsoever.
   *
   * That is not cosmetic. `isStreaming` is what keeps the next question out of
   * a composer whose send button is CURRENTLY a stop button, and on most chat
   * UIs those are one control in one place. So sending into a live generation
   * does not queue the question, it CANCELS the answer: measured on arena.ai,
   * where the turn showed "Generation stopped" with the question never sent,
   * and the run then waited out its response timeout for a reply to something
   * nobody had asked.
   *
   * `textContent.length` rather than `nodeText`: this runs before every send,
   * and building markdown for a whole node to compare two numbers is waste —
   * and unlike `innerText` it forces no layout on a page that may be mid-stream.
   * `-1` for an empty thread, which is not a length and must not compare equal
   * to one.
   */
  function replySize() {
    const nodes = assistantNodes();
    const last = nodes[nodes.length - 1];
    return last ? last.textContent.length : -1;
  }

  /**
   * Wait out a reply that is still growing but says nothing about it.
   *
   * Same shape as the settle rule on the reply side and for the same reason: a
   * pause mid-generation is indistinguishable from an ending, so stability has
   * to be seen more than once before it is believed.
   */
  async function waitForGrowthToStop(job) {
    let seen = replySize();
    let stable = 0;
    const until = Date.now() + 60000;

    while (stable < 2 && Date.now() < until) {
      await sleep(GROWTH_SAMPLE_MS);
      if (job.cancelled) return;
      const now = replySize();
      stable = now === seen ? stable + 1 : 0;
      seen = now;
    }
  }

  function isLoggedOut() {
    // Only trust the logged-out markers when there is no composer at all;
    // several providers keep a hidden "log in" link in a menu while signed in.
    if (pick('composer')) return false;
    return Boolean(pick('loggedOut'));
  }

  // --------------------------------------------------------------- driver ---

  let activeRun = null;

  function emit(payload) {
    // Embedded mode: reply down the private channel to the offscreen host that
    // framed us. Never broadcast — the same content script is also running in
    // whatever provider tabs the user has open themselves, and a broadcast
    // would be indistinguishable from those.
    if (embedded.active) {
      try {
        parent.postMessage(
          {
            type: FROM_ADAPTER,
            event: payload.state || 'event',
            url: location.href,
            ...payload
          },
          '*'
        );
      } catch {
        /* parent gone */
      }
      return;
    }

    try {
      chrome.runtime.sendMessage({
        type: 'ADAPTER_EVENT',
        providerId: cfgOf().provider?.id,
        ...payload
      });
    } catch {
      /* service worker asleep — the next event will wake it */
    }
  }

  /** Whatever is currently in the composer, field or rich editor. */
  function composerText() {
    const el = pick('composer');
    if (!el) return '';
    const isField = el.tagName === 'TEXTAREA' || el.tagName === 'INPUT';
    return (isField ? el.value : el.innerText) || '';
  }

  /**
   * Hold a Web Lock for the length of a run.
   *
   * A page holding a lock is a documented exemption from freezing, so Chrome's
   * Energy Saver cannot suspend this tab in the middle of an answer — which is
   * otherwise a real risk, because a long reply plus the anti-bot rests between
   * steps can easily leave the page hidden and idle for the five minutes it
   * takes to qualify.
   *
   * Nothing depends on the lock being granted: if `navigator.locks` is missing
   * or the request is refused, the run proceeds exactly as before.
   */
  function holdFreezeLock(job) {
    if (!navigator.locks?.request) return;
    try {
      navigator.locks
        .request('__sidebar_ai_run_active__', () =>
          new Promise((release) => {
            job.releaseLock = release;
          })
        )
        .catch(() => {});
    } catch {
      /* not available — carry on */
    }
  }

  async function run(reqId, text, image) {
    const s = settings();

    // A previous run still polling would compete for the same composer and can
    // report this turn's reply under its own request id.
    if (activeRun && !activeRun.cancelled) {
      activeRun.cancelled = true;
      activeRun.releaseLock?.();
    }

    const job = { reqId, cancelled: false };
    activeRun = job;
    holdFreezeLock(job);

    const fail = (message, state = 'error') => {
      job.releaseLock?.();
      if (job.cancelled) return;
      emit({ reqId, state, error: message });
    };

    // 1. Wait for the app shell.
    const ready = await waitFor(
      () => pick('ready') || pick('composer'),
      s.readyTimeoutMs || 45000
    );
    if (job.cancelled) return;

    if (!ready) {
      if (isLoggedOut()) return fail('Not signed in', 'need_login');
      return fail(
        'Could not find the chat input. The site layout may have changed — ' +
          'update the composer selector in Options.'
      );
    }

    if (isLoggedOut()) return fail('Not signed in', 'need_login');

    const composer = await waitFor(() => pick('composer'), 10000);
    if (job.cancelled) return;
    if (!composer) return fail('Chat input not found — check the composer selector in Options.');

    /**
     * 2. Wait for the previous answer to finish.
     *
     * While one is generating, the send control IS the stop control — so typing
     * a new question and "sending" it does nothing at all, silently. The run
     * then sits waiting for a reply to a message that was never delivered.
     */
    if (isStreaming()) {
      await waitFor(() => !isStreaming(), 60000, 300);
      if (job.cancelled) return;
      await sleep(300);
    } else if (!streamingMarkerSeen && replySize() > 0) {
      /**
       * No marker has ever fired here, so ask the text instead.
       *
       * Costs one `GROWTH_SAMPLE_MS` sample per turn, and only on a thread
       * that already has a reply in it and only for a provider whose markers
       * have never once worked — so it is free for ChatGPT, Gemini and Claude
       * after their first answer. Against a provider round trip of ten to forty
       * seconds that is a rounding error, and what it buys is not losing the
       * whole turn: see `replySize`.
       */
      const size = replySize();
      await sleep(GROWTH_SAMPLE_MS);
      if (job.cancelled) return;

      if (replySize() !== size) {
        await waitForGrowthToStop(job);
        if (job.cancelled) return;
        await sleep(300);
      }
    }

    // 3. Remember what was already on screen. Only the fallback paths below
    //    rely on this — see `freshText` for why it cannot be trusted alone.
    const priorCount = assistantNodes().length;
    const priorText = latestAssistantText();
    const priorUserCount = userMessageNodes().length;

    const fingerprint = normalise(text).slice(0, FINGERPRINT_CHARS);

    /**
     * Our own question, on screen — the only proof the send actually worked.
     *
     * `includes`, not `startsWith`: an attached file renders *inside* the user
     * bubble, so the node's text begins with the filename and our prompt starts
     * a line later. That mismatch cost the whole turn — no anchor means no
     * reply can be attributed to it, so a question ChatGPT had visibly answered
     * timed out, recovered, and asked again. The one turn it broke was the turn
     * carrying the CV, which is the turn that most needed the answer.
     *
     * The last match wins because a thread accumulates: our agent prompts all
     * begin with the same rules, and the newest one is ours.
     */
    /**
     * Cached on the one thing that can change the answer: a new user message.
     *
     * This runs on every poll of the reply loop, and the uncached version was
     * the single most expensive thing the adapter did to a provider tab. It
     * walks EVERY user message in the thread — and an agent run's messages are
     * the rules, the task and up to forty thousand characters of page text,
     * accumulating turn after turn in one conversation. Several times a second,
     * against a thread that only grows.
     *
     * What the user sees is the provider window itself going unresponsive:
     * clicks and scrolling in it do nothing while a run is working, and it
     * comes back a few minutes later when the run stops. The tab is not stuck,
     * it is busy — with us.
     *
     * `textContent`, not `nodeText`: matching a fingerprint needs characters,
     * while `nodeText` builds markdown for the whole node, and `innerText`
     * under it forces a layout flush on a page that is mid-stream and
     * relaying out constantly.
     *
     * Not cached on time, and not cached unconditionally. The count is what
     * makes it correct: our own message has not rendered yet on the early
     * polls, and every agent prompt in a run begins with the same eighty
     * characters — so a cache that held the FIRST match would pin the anchor to
     * the previous turn's message and attribute the last answer to this
     * question. `isConnected` covers the other direction, a provider re-rendering
     * the node it gave us.
     */
    let anchor = null;
    let anchorCount = -1;

    const findOurMessage = () => {
      const nodes = userMessageNodes();
      if (anchor && anchor.isConnected && nodes.length === anchorCount) return anchor;

      const remember = (node) => {
        if (node) {
          anchor = node;
          anchorCount = nodes.length;
        }
        return node;
      };

      for (let i = nodes.length - 1; i >= 0; i--) {
        if (normalise(nodes[i].textContent).includes(fingerprint)) return remember(nodes[i]);
      }

      // Nothing matched, but a user message appeared that was not there before
      // we typed — it is ours, whatever the provider has done to its text.
      // Long messages get collapsed behind "Show more", and more than one app
      // truncates the DOM rather than the display; without this, every one of
      // those turns is a five-minute timeout.
      const nodesNow = nodes.length;
      return nodesNow > priorUserCount ? remember(nodes[nodesNow - 1]) : null;
    };

    // 4. Attach first, then type — pasting a file after the text can wipe a
    //    rich-text composer's selection and take the prompt with it.
    const attachment = asAttachment(image);
    // Whether the file actually reached the provider. Reported with `submitted`
    // rather than thrown: the question is still worth asking without it, but an
    // answer written from the page alone must not look like one written from
    // the CV the user attached.
    const attached = attachment ? await attachFile(composer, attachment) : true;
    if (job.cancelled) return;

    /**
     * 5. Type and send, and then check that it went.
     *
     * `submit()` returning proves only that we clicked something. The send
     * button can be disabled, a keypress can be swallowed by a modal, focus can
     * be stolen — and every one of those looks identical to success from here.
     * Confirming delivery is what turns a silent no-op into a retry.
     *
     * The test is "our message appeared OR the composer emptied", deliberately
     * loose. The two failure modes are not symmetric: treating a real send as
     * failed makes us type it again and post a DUPLICATE, while treating a
     * failed send as real only costs a wait that the reply-side anchor will
     * catch anyway. So the weaker signal is allowed to count.
     */
    let delivered = false;

    for (let attempt = 1; attempt <= 3 && !delivered; attempt++) {
      if (job.cancelled) return;

      if (!composerText().trim()) {
        setComposerText(composer, text);
        await sleep(150);
      }

      if (!composerText().trim()) {
        return fail('Could not type into the chat input.');
      }

      /**
       * "The composer emptied" only proves delivery if it had something in it.
       *
       * Read immediately before the submit, because an empty read is otherwise
       * indistinguishable from a composer we were never reading correctly —
       * and one of those is real. Gemini's Quill editor keeps a SECOND
       * contenteditable beside the real one (`.ql-clipboard`, permanently
       * empty, `tabindex="-1"`), so a lookup that lands on it returns '' no
       * matter what was typed. The old test then read as "went empty →
       * delivered" on every single turn, which is exactly the failure seen: the
       * question still sitting in Gemini's box, the panel reporting Message
       * delivered, and the run waiting out a five-minute response timeout for a
       * reply to something that was never sent.
       *
       * Quill's own empty marker is the `ql-blank` class on `.ql-editor`, whose
       * empty content is `<p><br></p>` — so text-emptiness alone was never a
       * safe signal there.
       */
      const hadText = composerText().trim();

      await submit(composer);

      /**
       * Our own text, still sitting in the box — a hard NO, whatever the
       * thread looks like.
       *
       * `findOurMessage` falls back to "a user message appeared that was not
       * there before" (see its comment). That heuristic exists to ATTRIBUTE A
       * REPLY, where a wrong guess costs a wait; borrowed to PROVE A SEND, a
       * wrong guess costs the whole turn. Gemini re-renders its thread on its
       * own — a long message collapsing behind its chevron, the attachment
       * card, ordinary Angular churn — so the count ticks with nothing sent,
       * the fallback fires, and the panel reports "Message delivered" over a
       * question still visible in the composer. Measured on the Zoho run: the
       * text in Gemini's box, `submitted` posted, and the run waiting out its
       * five-minute response timeout for a reply to something never asked.
       *
       * Matched on the fingerprint, not on emptiness: a composer holding
       * SOMETHING ELSE is not our problem, and vetoing on that would make an
       * app with sticky placeholder text retype and post duplicates — the
       * expensive direction of this trade (see the asymmetry above).
       */
      const stillInBox = () => normalise(composerText()).includes(fingerprint);

      delivered = Boolean(
        await waitFor(
          () =>
            !stillInBox() &&
            (findOurMessage() || (hadText && !composerText().trim())),
          4000,
          200
        )
      );
    }

    if (job.cancelled) return;

    if (!delivered) {
      return fail(
        'Typed the question but the provider never accepted it. Its send button ' +
          'may be disabled or a dialog is in the way — open the provider window ' +
          'from the ⋮ menu to see what it is showing.'
      );
    }

    emit({
      reqId,
      state: 'submitted',
      url: location.href,
      // Absent when this turn carried no file at all, which is not the same as
      // a file that failed — the panel marks the chip from this, and an agent
      // run's later turns must not answer for the one that had the CV.
      attached: attachment ? attached : undefined,
      notice: attached
        ? null
        : `“${attachment.name}” could not be handed to ${
            cfgOf().provider?.name || 'the provider'
          } — the answer below was written without it.`
    });

    /**
     * Text of the CURRENT reply, or '' if this turn has not produced one yet.
     *
     * Anchoring on our own message (`findOurMessage`, above) is the only
     * reliable way to tell this turn's reply from the last one. Counting
     * assistant nodes is not: when the relay tab reopens a saved conversation
     * the composer becomes usable well before the message history finishes
     * painting — more so in a minimized window, where the renderer is throttled
     * — so the count is sampled as 0, the history then lands, and the *previous*
     * answer arrives looking like a brand-new node. That is exactly how a
     * question gets answered with the reply to the question before it.
     */
    /**
     * `nodeText` for the reply node, memoised on a cheap fingerprint.
     *
     * `htmlToMarkdown` walks the whole node and builds strings, and the loop
     * below asks for it several times a second against a node that only grows.
     * Between two streamed chunks nothing has changed and the conversion is
     * pure waste — paid on the provider tab's main thread, which is the tab the
     * user is trying to click on.
     *
     * Both halves of the fingerprint are needed and neither forces a layout the
     * way `innerText` would. Length moves on every streamed character; the
     * element count catches the re-renders that change markup without changing
     * text, which is exactly what a code block closing looks like — and
     * `openFence` below reads the markdown to decide whether a reply is
     * finished, so a stale conversion there would settle a turn mid-block.
     */
    let mdNode = null;
    let mdMark = '';
    let mdText = '';

    const replyText = (el) => {
      const mark = `${el.textContent.length}:${el.getElementsByTagName('*').length}`;
      if (el === mdNode && mark === mdMark) return mdText;
      mdNode = el;
      mdMark = mark;
      mdText = nodeText(el);
      return mdText;
    };

    const freshText = () => {
      const users = userMessageNodes();

      if (users.length) {
        const anchor = findOurMessage();
        // Our own message has not rendered, so nothing on screen can be its
        // answer — however finished the rest of the thread looks.
        if (!anchor) return '';

        const following = assistantNodes().filter(
          (n) =>
            anchor.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING
        );

        // Search backwards for content: providers park empty containers below a
        // finished reply, and reading one of those as "the answer" would end the
        // turn holding whatever partial text we had captured so far.
        for (let i = following.length - 1; i >= 0; i--) {
          const md = replyText(following[i]);
          if (md) return md;
        }
        return '';
      }

      // No `user` selector matched — the provider has no stable marker for its
      // own bubbles, or its DOM changed. Fall back to the weaker heuristic:
      // trust the newest assistant text once it differs from what was on screen
      // before we sent, or once a genuinely new node has appeared under it.
      const md = latestAssistantText();
      if (!md) return '';
      if (md === priorText && assistantNodes().length <= priorCount) return '';
      return md;
    };

    // 4. Wait for the reply to begin: either text attributable to this turn
    //    appears, or streaming kicks in.
    const started = await waitFor(
      () => Boolean(freshText()) || isStreaming(),
      45000,
      200
    );

    if (job.cancelled) return;
    if (!started) {
      return fail(
        'The provider never started a reply. It may be rate limiting, showing ' +
          'a captcha, or the send button selector is stale — open the relay ' +
          'window to check.'
      );
    }

    // 5. Poll the reply until it settles.
    const stabilityMs = s.stabilityMs || 1500;
    /** How long to wait on a code block that never closes. See `settled`. */
    const OPEN_FENCE_GRACE_MS = 8000;
    /**
     * How many consecutive polls must agree before we believe them.
     *
     * Every signal here is sampled, and one sample is not evidence. The stop
     * button vanishes for a frame whenever the provider re-renders its composer
     * — `isInteractable` reads that as "not streaming" — and a provider that
     * pauses between chunks looks, for that instant, exactly like one that has
     * finished. Two polls that agree cost a quarter of a second and turn both
     * of those into nothing. Sampled *time* is not a substitute: `idleFor` is
     * measured from the last change we happened to see, so when the relay
     * window is throttled to one poll a second, a single mid-stream sample
     * already satisfies a 600ms threshold and the turn ends holding a fragment
     * ("Hi! How" for "Hi! How can I help you?").
     */
    const AGREEING_POLLS = 2;
    /** How long a reply must stay finished-looking before we believe it. */
    const CONFIRM_MS = 700;

    /**
     * When to stop believing the streaming marker and believe the text instead.
     *
     * Everything below hangs off `stopped` — two consecutive reads where
     * `isStreaming()` is false. That is right when the marker is honest, and it
     * is a permanent hang when it is not: a provider that leaves a stop button
     * interactable after it has finished, or renames the testid we match on,
     * makes `isStreaming()` true forever. Nothing else in the loop can end the
     * turn, so it runs to the 5-minute `responseTimeoutMs`, recovers, and asks
     * again — three times. Fifteen minutes, for a reply that was complete on
     * screen the whole time and that the user is sitting there reading.
     *
     * The text is the more trustworthy signal at this timescale. A reply that
     * has been byte-identical for this long is not mid-generation: the longest
     * gap a provider leaves between chunks is a second or two, and a reasoning
     * pause still moves the DOM. So after a genuinely dead period the marker is
     * overruled.
     *
     * Two things keep this from becoming the truncation bug it could so easily
     * be. An unclosed code fence blocks it outright — that is the shape of a
     * provider that stalled halfway through a JSON action, and it must go on to
     * time out and retry rather than hand the loop half an action. And it is
     * confirmed with a longer re-read than the ordinary path, because it is the
     * branch with the least evidence behind it.
     */
    const STUCK_MARKER_MS = 45000;
    /** The confirm for that branch. Longer, because it is the weaker signal. */
    const STUCK_CONFIRM_MS = 2500;

    const hardDeadline = Date.now() + (s.responseTimeoutMs || 300000);

    let last = '';
    let lastChangeAt = Date.now();
    let sawStreaming = false;
    /** Consecutive polls that read back exactly what we already have. */
    let quiet = 0;
    /** Consecutive polls that saw no streaming marker. */
    let calm = 0;

    for (;;) {
      if (job.cancelled) return;

      if (Date.now() > hardDeadline) {
        // Never pass off the previous answer as this one on a timeout.
        if (!last) {
          return fail(
            'Timed out before the provider produced a reply we could match to ' +
              'this question. If it clearly answered in the relay window, the ' +
              'assistant or user selector is stale — update it in Options.'
          );
        }
        job.releaseLock?.();
        emit({ reqId, state: 'done', text: last, truncated: true });
        return;
      }

      const streaming = isStreaming();
      if (streaming) {
        sawStreaming = true;
        calm = 0;
      } else {
        calm++;
      }

      const now = freshText();
      if (now && now !== last) {
        last = now;
        lastChangeAt = Date.now();
        quiet = 0;
        emit({ reqId, state: 'streaming', text: last });
      } else if (now && now === last) {
        quiet++;
      } else {
        // An empty read is the provider re-rendering the message, not the
        // message standing still. Counting it as quiet would let a swap that
        // happens to straddle two polls end the turn.
        quiet = 0;
      }

      const idleFor = Date.now() - lastChangeAt;

      /**
       * Only finish while the reply is still readable and still says what we
       * last captured. A re-render that briefly empties the node would
       * otherwise look identical to a finished answer, and the turn would end
       * holding a fragment — a single streamed character, if it happened early.
       *
       * An odd number of ``` markers is the same thing one level up: the reply
       * is inside a code block that has not been closed. Settling there hands
       * the caller half a JSON action, which the agent loop then reports as a
       * reply it could not read. The grace period is because some sites render
       * the closing fence in a way `nodeText` never returns — waiting on it
       * forever would turn a cosmetic DOM difference into a five-minute hang.
       */
      const openFence = (last.match(/```/g) || []).length % 2 === 1;
      const settled =
        Boolean(last) &&
        quiet >= AGREEING_POLLS &&
        (!openFence || idleFor > OPEN_FENCE_GRACE_MS);
      const stopped = calm >= AGREEING_POLLS;

      /**
       * The reply has not moved for long enough that the marker is wrong.
       *
       * Deliberately not `stopped` — this branch exists precisely for the case
       * where `isStreaming()` never goes false. See STUCK_MARKER_MS.
       *
       * `!openFence` is spelled out rather than left to `settled`, which is not
       * the same test: `settled` gives up on an unclosed fence after
       * OPEN_FENCE_GRACE_MS, so routing this through it alone would commit a
       * reply that stopped halfway through a code block. Measured on a fixture
       * that stalls mid-action with the stop button stuck up: it ended the turn
       * holding `{"thought":"search jobs","action":"cli`. That is the one shape
       * where hanging is the better answer — the timeout recovers and asks
       * again, where committing hands the loop a fragment and hands a chat a
       * sentence that stops mid-word with nothing to say it was cut off.
       */
      const markerStuck = settled && !openFence && idleFor > STUCK_MARKER_MS;

      // Definitive: we watched it stream, streaming stopped, text has settled.
      // Fallback second, for providers with no usable stop/streaming marker.
      // Last, the marker-is-lying case, which is a hang rather than a wait.
      const finishing =
        (sawStreaming && stopped && settled && idleFor > 600) ||
        (stopped && settled && idleFor > stabilityMs) ||
        markerStuck;

      /**
       * Every signal above says the reply *looks* finished. Prove it before
       * committing, by waiting out the longest gap a provider leaves between
       * chunks and reading once more.
       *
       * Nothing on the page announces the end of a reply; we infer it from an
       * absence, and an absence is exactly what a pause looks like too. This
       * turns a wrong guess into a delay instead of a truncated answer, which
       * is the trade worth making: a fragment is indistinguishable from a
       * complete short reply once it reaches the panel, so nobody can tell it
       * went wrong. Charged once per reply, not per poll.
       *
       * The floor is deliberately the whole wait, so a mutation elsewhere on a
       * busy page cannot cut it short — but a worker TICK still lands it on
       * time in a throttled window, which is why it goes through `sleep` and
       * not a bare `setTimeout`.
       */
      if (finishing) {
        const confirmMs = markerStuck ? STUCK_CONFIRM_MS : CONFIRM_MS;
        await sleep(confirmMs, confirmMs);
        if (job.cancelled) return;

        const after = freshText();
        if (after === last) break;

        // It grew, or the node is mid-re-render. Either way this was not the
        // end — go round again rather than commit to what we had.
        if (after) {
          last = after;
          lastChangeAt = Date.now();
          emit({ reqId, state: 'streaming', text: last });
        }
        quiet = 0;
        continue;
      }

      /**
       * Note for anyone tempted to raise the 80ms floor here to spare the page.
       *
       * `sleep` returns early on any DOM mutation, so this wait — the one that
       * runs for the whole of every answer — actually turns over at the floor
       * while a reply streams, not at 250ms. Raising it to 200 was tried and
       * reverted: measured on a twelve-turn thread it cost ~100ms per turn in
       * detection latency (5.70s → 5.81s) and produced no measurable relief at
       * the other end — median and p95 frame gaps were identical to the digit.
       * The per-pass work is memoised instead, above.
       */
      await sleep(250);
    }

    job.releaseLock?.();
    if (job.cancelled) return;
    // Report the URL as well: providers rewrite it to the real conversation
    // path (/c/<id>, /chat/<uuid>, /app/<id>) once the first message lands, and
    // that is what lets a later session rejoin this thread instead of opening a
    // blank one.
    emit({ reqId, state: 'done', text: last, url: location.href });
    activeRun = null;
  }

  function stopGenerating() {
    activeRun?.releaseLock?.();
    const stop = pick('stop');
    if (isInteractable(stop)) stop.click();
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.target !== 'adapter') return;

    // An unthrottled heartbeat from the worker. Message delivery is a task, not
    // a timer, so this arrives on time even in a minimized window.
    if (msg.type === 'TICK') {
      wakeWaiters();
      sendResponse({ ok: true });
      return true;
    }

    if (msg.type === 'SUBMIT') {
      run(msg.reqId, msg.text, msg.image).catch((err) =>
        emit({ reqId: msg.reqId, state: 'error', error: String(err?.message || err) })
      );
      sendResponse({ ok: true });
      return true;
    }

    if (msg.type === 'CANCEL') {
      if (activeRun) activeRun.cancelled = true;
      stopGenerating();
      sendResponse({ ok: true });
      return true;
    }

    if (msg.type === 'PROBE') {
      sendResponse({
        ok: true,
        loggedOut: isLoggedOut(),
        hasComposer: Boolean(pick('composer')),
        streaming: isStreaming(),
        url: location.href
      });
      return true;
    }
  });

  // ------------------------------------------------- embedded transport ---

  function dispatch(command, msg) {
    // Same heartbeat as window mode, arriving down the offscreen channel.
    if (command === 'TICK') {
      wakeWaiters();
      return { ok: true };
    }
    if (command === 'SUBMIT') {
      run(msg.reqId, msg.text, msg.image).catch((err) =>
        emit({ reqId: msg.reqId, state: 'error', error: String(err?.message || err) })
      );
      return { ok: true };
    }
    if (command === 'CANCEL') {
      if (activeRun) activeRun.cancelled = true;
      stopGenerating();
      return { ok: true };
    }
    if (command === 'PROBE') {
      return {
        ok: true,
        loggedOut: isLoggedOut(),
        hasComposer: Boolean(pick('composer')),
        streaming: isStreaming(),
        url: location.href
      };
    }
    return { ok: false };
  }

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || typeof data !== 'object') return;

    // Only our own embedder may activate or drive this frame. `event.source`
    // being the parent window is the check that keeps a hostile page on the
    // same site from pretending to be the extension.
    if (event.source !== parent || parent === window) return;

    if (data.type === HANDSHAKE) {
      embedded.active = true;
      embedded.provider = data.provider;
      embedded.settings = data.settings;
      emit({ state: 'adapter_ready' });
      return;
    }

    if (data.type === TO_ADAPTER && embedded.active) {
      const result = dispatch(data.command, data);
      if (data.command === 'PROBE') {
        parent.postMessage(
          { type: FROM_ADAPTER, event: 'probe', reqId: data.reqId, ...result },
          '*'
        );
      }
    }
  });

  // Window mode only — in embedded mode the handshake emits this instead.
  if (!embedded.active && window.__SIDEBAR_AI) emit({ state: 'adapter_ready' });
})();
