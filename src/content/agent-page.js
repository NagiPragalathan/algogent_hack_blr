/**
 * The agent's hands and eyes on a page.
 *
 * Idle until the background agent loop asks for something, then it either
 * describes the page (OBSERVE), judges a proposed action (PLAN) or carries one
 * out (ACT).
 *
 * The contract with the model is index-based: every interactive element gets a
 * number, the model says `{"action":"click","id":12}`, and the number is
 * resolved back to an element here. Handing the model raw CSS selectors instead
 * is what makes browser agents brittle — it invents plausible-looking selectors
 * that match nothing, and every step becomes a retry.
 */

(() => {
  if (window.__sidebarAIAgentLoaded) return;
  window.__sidebarAIAgentLoaded = true;

  const INTERACTIVE = [
    'a[href]', 'button', 'input:not([type="hidden"])', 'select', 'textarea',
    'summary', '[contenteditable="true"]',
    '[role="button"]', '[role="link"]', '[role="tab"]', '[role="checkbox"]',
    '[role="radio"]', '[role="menuitem"]', '[role="combobox"]',
    '[role="option"]', '[role="switch"]', '[onclick]'
  ].join(',');

  /**
   * Actions whose consequences the user cannot simply undo by going back.
   * Matched against an element's own label, so it reads what the user reads.
   */
  const RISKY_LABEL =
    /\b(submit|send|pay|buy|purchase|order|checkout|place order|delete|remove|discard|destroy|confirm|apply|subscribe|publish|post|tweet|transfer|withdraw|book|reserve|deactivate|unsubscribe|sign in|sign up|log in|login|register|authori[sz]e|grant access|continue with|sign out|log out)\b/i;

  /** Index -> element for the current observation. Rebuilt on every OBSERVE. */
  let registry = new Map();

  /** How many elements to describe. Enough to act, few enough to stay cheap. */
  const MAX_ELEMENTS = 120;

  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

  function visible(el) {
    if (!el.getClientRects().length) return false;
    if (el.checkVisibility && !el.checkVisibility({ visibilityProperty: true })) return false;
    if (el.disabled) return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    return true;
  }

  /** What a person would call this control. */
  function labelFor(el) {
    // Callers reach here with a point that hit nothing, or an element that has
    // just been removed. Returning '' is right for both, and the alternative is
    // a raw TypeError reported as if the user's step had failed.
    if (!el?.getAttribute) return '';

    const aria = el.getAttribute('aria-label');
    if (aria) return clean(aria);

    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const text = by
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.innerText || '')
        .join(' ');
      if (clean(text)) return clean(text);
    }

    const tag = el.tagName.toLowerCase();

    if (tag === 'input' && /^(submit|button|reset)$/.test(el.type)) {
      if (el.value) return clean(el.value);
    }

    if (el.id) {
      try {
        const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (label?.innerText) return clean(label.innerText);
      } catch {
        /* exotic id — fall through */
      }
    }

    const wrapping = el.closest('label');
    if (wrapping?.innerText) return clean(wrapping.innerText);

    const own = clean(el.innerText || '');
    if (own) return own;

    return clean(
      el.getAttribute('placeholder') ||
        el.getAttribute('title') ||
        el.getAttribute('alt') ||
        el.getAttribute('name') ||
        ''
    );
  }

  /** One compact line the model can act on. */
  function describe(el, index, labelText = labelFor(el), inView = true) {
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role');
    const label = cut(labelText, 90);

    let kind = tag;
    if (tag === 'a') kind = 'link';
    else if (tag === 'input') kind = `input type=${el.type || 'text'}`;
    else if (el.isContentEditable) kind = 'editable';
    else if (role && tag === 'div') kind = role;

    const bits = [`[${index}] ${kind}`];
    if (label) bits.push(`"${label}"`);

    if (tag === 'input' || tag === 'textarea') {
      if (el.value) bits.push(`value="${cut(clean(el.value), 40)}"`);
      if (el.required) bits.push('required');
    }
    if (tag === 'select') {
      const options = Array.from(el.options || [])
        .slice(0, 8)
        .map((o) => clean(o.textContent))
        .filter(Boolean);
      if (options.length) bits.push(`options=[${options.join(' | ')}]`);
    }
    if (el.getAttribute('aria-expanded')) {
      bits.push(`expanded=${el.getAttribute('aria-expanded')}`);
    }
    if (el.checked) bits.push('checked');
    // Clicking it still works — act() scrolls first — but "the answer may be
    // further down" is something the model can only know if we say so.
    if (!inView) bits.push('off-screen');

    return bits.join(' ');
  }

  /** How many of the task's words this label uses. Ties are broken by order. */
  function relevance(label, wanted) {
    if (!label || !wanted.length) return 0;
    const hay = label.toLowerCase();
    return wanted.reduce((score, term) => score + (hay.includes(term) ? 1 : 0), 0);
  }

  function onScreen(el) {
    const r = el.getBoundingClientRect();
    return (
      r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth
    );
  }

  /**
   * Number the controls inside `scope`, on-screen ones first.
   *
   * Two passes, because a document-order cut at MAX_ELEMENTS is worse than no
   * cut at all on a big site: 260 nav links fill the list and every button the
   * user is actually looking at falls off the end, so the model chooses from a
   * list that has nothing to do with the screen. What is visible wins the cap
   * first, then whatever off-screen controls the task actually named — a page
   * with a nav that long is also a page where "Easy Apply to …" sits below the
   * fold, and dropping it is what sends the run round in circles. Document order
   * only decides the numbering, so the list still reads top-to-bottom.
   */
  function indexElements(scope, query) {
    registry = new Map();

    const wanted = terms(query);
    const found = [];

    for (const el of scope.querySelectorAll(INTERACTIVE)) {
      if (!visible(el)) continue;

      // A control with no label and no value is noise the model cannot use.
      const label = labelFor(el);
      const hasValue = 'value' in el && el.value;
      if (!label && !hasValue) continue;

      found.push({
        el,
        label,
        order: found.length,
        visible: onScreen(el),
        score: relevance(label, wanted)
      });
    }

    const offScreen = found.filter((c) => !c.visible);
    const kept =
      found.length <= MAX_ELEMENTS
        ? found
        : [
            ...found.filter((c) => c.visible),
            ...offScreen.filter((c) => c.score > 0).sort((a, b) => b.score - a.score),
            ...offScreen.filter((c) => c.score === 0)
          ]
            .slice(0, MAX_ELEMENTS)
            .sort((a, b) => a.order - b.order);

    const lines = kept.map((candidate, index) => {
      registry.set(index, candidate.el);
      return describe(candidate.el, index, candidate.label, candidate.visible);
    });

    return { lines, omitted: found.length - kept.length };
  }

  // ----------------------------------------------------------------- modals ---

  const DIALOGS = 'dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]';

  /**
   * The dialog the page has put in front of everything, if there is one.
   *
   * This is the fix for the failure that made "apply to this job" runs spin: the
   * site opens a modal whose buttons live at the very end of the document, a
   * document-order element list is therefore all background page, and the model
   * — unable to see the Submit it was told to press — re-clicks the thing that
   * opened the dialog instead. Scoping the observation to the dialog also
   * matches the truth of the screen: while a modal is open, nothing behind it
   * can be clicked, so listing it is listing lies.
   */
  function modalScope() {
    const viewport = Math.max(1, window.innerWidth * window.innerHeight);
    let best = null;

    for (const el of document.querySelectorAll(DIALOGS)) {
      if (!visible(el)) continue;

      const rect = el.getBoundingClientRect();
      const covers = (rect.width * rect.height) / viewport;

      // A cookie strip is a role="dialog" too, and scoping to one would blind
      // the agent to the page it came to read. Either the page states that it is
      // modal, or it is big enough that whatever is behind it is unusable anyway.
      const declared = el.getAttribute('aria-modal') === 'true' || isModalDialog(el);
      if (!declared && covers < 0.2) continue;

      if (!best || covers > best.covers) best = { el, covers };
    }

    return best?.el || null;
  }

  function isModalDialog(el) {
    try {
      return el.matches('dialog:modal');
    } catch {
      return el.tagName === 'DIALOG' && el.hasAttribute('open');
    }
  }

  /**
   * Name the dialog the way its heading does — not with labelFor, whose
   * innerText fallback would return the entire contents of the dialog.
   */
  function dialogLabel(el) {
    const aria = clean(el.getAttribute('aria-label'));
    if (aria) return cut(aria, 80);

    const by = el.getAttribute('aria-labelledby');
    const titled = by && clean(document.getElementById(by.split(/\s+/)[0])?.innerText || '');
    if (titled) return cut(titled, 80);

    const heading = clean(el.querySelector('h1, h2, h3, [role="heading"]')?.innerText || '');
    return heading ? cut(heading, 80) : '';
  }

  // ------------------------------------------------------------- retrieval ---

  const STOPWORDS = new Set([
    'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'her', 'was',
    'one', 'our', 'out', 'has', 'his', 'how', 'its', 'who', 'did', 'with',
    'this', 'that', 'from', 'they', 'have', 'what', 'when', 'where', 'which',
    'will', 'your', 'about', 'there', 'their', 'would', 'could', 'should'
  ]);

  function terms(query) {
    return [
      ...new Set(
        (query || '')
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .filter((t) => t.length > 2 && !STOPWORDS.has(t))
      )
    ];
  }

  /**
   * Return the parts of `text` that actually bear on `query`, within `budget`.
   *
   * A whole page rarely fits, and truncating from the top throws away the answer
   * whenever it lives further down. Scoring paragraph-sized chunks against the
   * question and keeping the best ones is the cheap version of retrieval that
   * needs no embedding service and no network call.
   */
  function retrieve(text, query, budget) {
    if (!text) return '';
    if (text.length <= budget) return text;

    const wanted = terms(query);
    if (!wanted.length) return text.slice(0, budget);

    // Chunk on blank lines first so a chunk is usually a coherent section.
    const chunks = [];
    for (const block of text.split(/\n{2,}/)) {
      if (block.length <= 1200) {
        chunks.push(block);
        continue;
      }
      for (let i = 0; i < block.length; i += 1000) chunks.push(block.slice(i, i + 1000));
    }

    const scored = chunks.map((body, order) => {
      const hay = body.toLowerCase();
      let hits = 0;
      let distinct = 0;
      for (const term of wanted) {
        const count = hay.split(term).length - 1;
        if (count) {
          distinct += 1;
          hits += count;
        }
      }
      // Distinct terms matter more than raw repetition: a chunk mentioning
      // every part of the question beats one repeating a single word.
      return { body, order, score: distinct * 3 + Math.min(hits, 12) };
    });

    const keep = [];
    let used = 0;
    for (const chunk of [...scored].sort((a, b) => b.score - a.score)) {
      if (chunk.score <= 0) break;
      if (used + chunk.body.length > budget) continue;
      keep.push(chunk);
      used += chunk.body.length;
    }

    if (!keep.length) return text.slice(0, budget);

    // Back into reading order — a jumbled set of excerpts is harder to follow.
    keep.sort((a, b) => a.order - b.order);

    const gaps = keep.some((c, i) => i > 0 && c.order !== keep[i - 1].order + 1);
    return keep.map((c) => c.body).join('\n\n') + (gaps ? '\n\n[…other sections omitted…]' : '');
  }

  function pageText(scope, query, budget) {
    // Inside a dialog, the dialog is the page: the extractor would hand back the
    // article behind it, which is exactly the text the model must stop reading.
    // Not clean()'d: retrieve() chunks on blank lines, so flattening the
    // whitespace here would leave it one 3000-character paragraph to cut blind.
    if (scope !== document) return retrieve((scope.innerText || '').trim(), query, budget);

    // page-context.js runs in the same isolated world and already knows how to
    // read a page well; no reason to keep a second, worse extractor here.
    const context = window.__sidebarAIExtract?.(200000);
    const raw = context?.text || document.body.innerText || '';
    return retrieve(raw.trim(), query, budget);
  }

  // --------------------------------------------------------------- observe ---

  /**
   * The thing that actually scrolls inside a dialog, if anything does.
   *
   * A modal is its own scrolling world: Naukri's apply dialog is a chat panel
   * with the recruiter's questions in a pane and Save pinned under it, and the
   * document behind it does not move at all. Everything that reasons about
   * scrolling has to ask this first, or it reasons about the wrong box.
   *
   * The largest scrollable descendant wins, not the first: dialogs wrap their
   * body in two or three overflow containers and the innermost is often a
   * 40px strip that happens to clip.
   */
  function scrollableIn(root) {
    if (!root || root === document) return null;

    let best = null;
    for (const el of [root, ...root.querySelectorAll('*')]) {
      const room = el.scrollHeight - el.clientHeight;
      if (room <= 4) continue;
      if (!/(auto|scroll|overlay)/.test(getComputedStyle(el).overflowY)) continue;
      if (!best || room > best.room) best = { el, room };
    }
    return best?.el || null;
  }

  /**
   * Where we are in whatever is being read, and whether there is more of it.
   *
   * `pane` is the dialog's scroller when one is open. Reporting the window's
   * position while a modal is up is not a rounding error, it is the wrong
   * answer: the confirmation page behind Naukri's dialog is one screenful, so
   * SCROLL read "0% (at end)" while the recruiter's questions sat unread below
   * the fold of the dialog — and the run finished saying there were no
   * questions on the page, with the question visible on screen.
   */
  function scrollPosition(pane) {
    const height = pane ? pane.clientHeight : window.innerHeight;
    const total = pane ? pane.scrollHeight : document.documentElement.scrollHeight;
    const at = pane ? pane.scrollTop : window.scrollY;

    const max = Math.max(1, total - height);
    return {
      percent: Math.min(100, Math.round((at / max) * 100)),
      more: at + height < total - 4
    };
  }

  /**
   * `maxChars: 0` returns the element list alone.
   *
   * Page text is the expensive half of an observation and is usually unchanged
   * between steps — resending it on every one of twenty steps is what makes a
   * browser agent slow and expensive, so the loop asks for it only when what is
   * in front of the user is no longer the page the model has already read.
   *
   * `sentTextFor` is that page, as {url, modal}. The caller cannot tell whether
   * either has changed without asking, so it says "text unless we are still
   * here" and gets the answer in one round trip instead of probing and then
   * asking again. The modal half matters as much as the URL: a dialog opening
   * replaces everything the page says without touching its address, and keying
   * on the URL alone left the model re-reading the page behind a modal it could
   * not see.
   */
  /**
   * `deep` scrolls the page top to bottom before reading it.
   *
   * Without it the agent's whole knowledge of a feed, a search-results page or
   * any virtualised list is its first screenful — which is how "apply to five
   * Easy Apply jobs" on a page holding twenty-five of them becomes a run that
   * acts on the two it can see and then reports success. The scroll pass also
   * *renders* the rest, so it runs before indexElements: controls that only
   * exist once you have scrolled past them are then real elements with numbers,
   * not text the model can read but cannot click.
   *
   * Skipped while a dialog is open — the document behind a modal is not the page
   * any more, and scrolling it would move something the user cannot even see.
   */
  async function deepText(maxChars, budgetMs) {
    const read = window.__sidebarAIDeepExtract;
    if (!read) return null;
    try {
      return await read({ maxChars, budgetMs });
    } catch {
      // A page that fights being scrolled is not a reason to lose the step —
      // the shallow read below still describes what is on screen.
      return null;
    }
  }

  async function observe({
    query = '',
    maxChars = 4000,
    sentTextFor = null,
    deep = false,
    budgetMs
  } = {}) {
    let harvested = null;

    if (deep && !modalScope()) {
      harvested = await deepText(Math.max(maxChars, 4000), budgetMs);
    }

    // Re-asked after the scroll: a pass that loaded more of the list may also
    // have opened a dialog, and the observation has to describe the page as it
    // is now, not as it was when the pass started.
    const dialog = modalScope();
    const scope = dialog || document;
    const modal = dialog ? dialogLabel(dialog) || 'dialog' : '';

    const { lines, omitted } = indexElements(scope, query);
    const { percent, more } = scrollPosition(dialog ? scrollableIn(dialog) : null);

    const stale =
      !sentTextFor || sentTextFor.url !== location.href || sentTextFor.modal !== modal;

    return {
      url: location.href,
      title: document.title,
      modal,
      scroll: percent,
      moreBelow: more,
      elements: lines,
      omitted,
      // A deep read was asked for explicitly, so it is never suppressed as
      // "already sent" — the whole point is that it says more than last time.
      text: harvested
        ? harvested.text
        : maxChars > 0 && stale
          ? pageText(scope, query, maxChars)
          : '',
      passes: harvested?.passes || 0,
      visual: visualCensus(scope),
      frames: frameCensus(),
      // The screenshot is exactly this window, so these are also the units a
      // `click_at` is given in. Sent every time rather than only with a
      // picture: the model may ask for a screenshot next turn, and by then
      // this observation is what it is reading.
      viewport: { width: window.innerWidth, height: window.innerHeight }
    };
  }

  /**
   * What is on this page that reading it cannot reach.
   *
   * The observation's silence is ambiguous: a page with no text is either
   * genuinely empty or a chart, a map, a PDF viewer, a canvas app, a scan — and
   * those two want opposite responses. The first means "go somewhere else", the
   * second means "look at it". Counting the elements that hold pixels instead
   * of characters is what lets the loop tell them apart, and it is four
   * querySelectorAll calls rather than another round trip.
   *
   * Small images are skipped on purpose: every page has icons and avatars, and
   * counting those would call every page visual.
   */
  /**
   * The iframes on this page, which are pages this script is not in.
   *
   * This is the single most confusing shape a run can hit, because the failure
   * has no symptom: an embedded form, a chat widget, a payment box or a booking
   * calendar is a whole document of its own, and everything in it is absent
   * from the element list with nothing saying it was left out. The model is
   * handed a complete-looking page, cannot find the field it was told to fill,
   * and concludes there is no such field — which is exactly what it reports.
   * Measured on a Naukri application: the recruiter's question and its Save
   * button lived in a frame, and two runs in a row finished with "there are no
   * recruiter questions available on this page" while the question was on
   * screen.
   *
   * Counted here and named in the observation so the model can ask to go into
   * one. Small and invisible frames are skipped — trackers and ad slots are
   * frames too, and listing thirty of them would bury the one that matters.
   */
  const MEANINGFUL_FRAME = 120;

  function frameCensus() {
    const out = [];

    for (const el of document.querySelectorAll('iframe, frame')) {
      const rect = el.getBoundingClientRect();
      if (rect.width < MEANINGFUL_FRAME || rect.height < MEANINGFUL_FRAME) continue;
      if (!visible(el)) continue;

      let src = '';
      try {
        src = el.src ? new URL(el.src, location.href).href : '';
      } catch {
        src = el.getAttribute('src') || '';
      }

      out.push({
        // The label is what the model has to recognise it by, and the src is
        // often a signed URL with nothing readable in it — so the title and
        // the accessible name come first.
        name: cut(
          clean(el.getAttribute('title') || el.getAttribute('aria-label') || '') ||
            hostOf(src) ||
            'frame',
          60
        ),
        url: cut(src, 120),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        // Whether it is on screen decides whether it is worth entering: an
        // off-screen frame is usually a footer widget, not the task.
        onScreen: rect.bottom > 0 && rect.top < window.innerHeight
      });
    }

    return out;
  }

  function hostOf(url) {
    try {
      return new URL(url).host;
    } catch {
      return '';
    }
  }

  const MEANINGFUL_IMAGE = 180;

  function visualCensus(scope) {
    const root = scope === document ? document.body || document : scope;
    if (!root.querySelectorAll) return { canvas: 0, image: 0, video: 0, embed: 0, chars: 0 };

    const big = (el) => {
      const r = el.getBoundingClientRect();
      return r.width >= MEANINGFUL_IMAGE && r.height >= MEANINGFUL_IMAGE;
    };

    return {
      canvas: [...root.querySelectorAll('canvas')].filter(big).length,
      image: [...root.querySelectorAll('img,svg')].filter(big).length,
      video: root.querySelectorAll('video').length,
      // A PDF in a viewer, a slide deck, an embedded app — all frames we cannot
      // read into and all things a screenshot can.
      embed: root.querySelectorAll('embed,object,iframe').length,
      // Cheap and approximate; the loop only needs "was there anything to read".
      chars: clean(root.innerText || '').length
    };
  }

  // ------------------------------------------------------------------ plan ---

  function resolve(action) {
    if (action.id == null) return null;
    return registry.get(Number(action.id)) || null;
  }

  /** null when the step is ordinary, otherwise why it needs a confirmation. */
  function riskOf(action, el) {
    if (action.action === 'type' && action.submit) return 'submits the form';

    // A click aimed by coordinate is judged on what is actually under the
    // point, not on the number pair — the same test as any other click.
    if (action.action === 'click_at') {
      const aimed = elementAtPoint(Number(action.x), Number(action.y));
      const aimedLabel = aimed ? labelFor(aimed) || clean(aimed.textContent) : '';
      return RISKY_LABEL.test(aimedLabel) ? `performs “${cut(aimedLabel, 60)}”` : null;
    }

    if (action.action !== 'click' || !el) return null;

    const label = labelFor(el);
    const tag = el.tagName.toLowerCase();

    const submits =
      (tag === 'input' && el.type === 'submit') ||
      (tag === 'button' && el.form && el.type !== 'button' && el.type !== 'reset');
    if (submits) return `submits the “${el.form?.name || 'page'}” form`;

    if (RISKY_LABEL.test(label)) return `performs “${cut(label, 60)}”`;

    return null;
  }

  /**
   * The value, as it should appear in the run's step list.
   *
   * Showing what was typed is the difference between a step you can check and
   * one you can only trust: "Typed into that field" tells you an action
   * happened, not whether it put the right answer in the right box, which is
   * the only thing anyone watching a form being filled actually wants to know.
   *
   * A password is the one value that must never come back. Masking by field
   * type rather than by guessing at the label, because "PIN", "secret" and
   * "passcode" are all fields whose type says password and whose label does
   * not.
   */
  function shownValue(el, text) {
    const value = String(text ?? '');
    if (!value) return '""';
    const type = (el?.type || '').toLowerCase();
    if (type === 'password') return '•'.repeat(Math.min(value.length, 12));
    return `"${cut(value, 60)}"`;
  }

  /**
   * What to call a field, trying every place a name can hide.
   *
   * `labelFor` alone returned nothing for the chat box on a real application
   * form, so the step read `Typed into "that field" at (1165, 201)` — three
   * numbers and no information. The fallbacks are ordered by how much a person
   * would recognise them: the visible label, then the placeholder they can see
   * in the empty box, then the name the page uses internally.
   */
  function fieldName(el) {
    if (!el) return '';
    return (
      labelFor(el) ||
      clean(el.getAttribute?.('placeholder') || '') ||
      clean(el.getAttribute?.('aria-label') || '') ||
      clean(el.getAttribute?.('name') || '') ||
      clean(el.id || '') ||
      ''
    );
  }

  function plan(action) {
    const el = resolve(action);
    if (action.id != null && !el) {
      return { ok: false, error: `No element [${action.id}] on this page. Observe again.` };
    }
    const label = el ? labelFor(el) : '';

    /**
     * Built per action, not as one object of every description.
     *
     * An object literal evaluates all of its values, so a `click_at` line that
     * reads what is under the point ran for *every* action — including the ones
     * with no point, where `elementFromPoint(NaN, NaN)` is null. Every type and
     * click in a run then failed with "Cannot read properties of null", one
     * layer away from anything that mentions coordinates.
     */
    const describeAction = () => {
      switch (action.action) {
        case 'click':
          return `Click [${action.id}] ${label ? `“${cut(label, 60)}”` : ''}`;
        case 'click_at': {
          // A coordinate click has no element until it lands, so the prompt
          // names what is under the point — "Click at (520, 554)" is not
          // something a user can agree or object to.
          const aimed = elementAtPoint(Number(action.x), Number(action.y));
          // Landing on the page itself is landing on nothing in particular —
          // quoting the body's text back would describe the whole screen.
          const bare = !aimed || aimed === document.body || aimed === document.documentElement;
          const what = bare
            ? 'that point'
            : labelFor(aimed) || clean(aimed.textContent || '') || 'that point';
          return `Click “${cut(what, 60)}” at (${action.x}, ${action.y})`;
        }
        case 'type': {
          const field = action.id == null
            ? fieldAtPoint(Number(action.x), Number(action.y))
            : el;
          const what = fieldName(field) || (action.id == null ? 'that field' : `[${action.id}]`);
          return (
            `Type ${shownValue(field, action.text)} into “${cut(what, 40)}”` +
            (action.submit ? ', then submit' : '')
          );
        }
        case 'select':
          return `Choose “${action.value}” in [${action.id}]`;
        case 'scroll':
          return `Scroll ${action.direction || 'down'}`;
        default:
          return action.action;
      }
    };

    return { ok: true, description: describeAction(), risk: riskOf(action, el) };
  }

  // ------------------------------------------------------------------- act ---

  /**
   * Write into a field the way a person would. Frameworks track their own copy
   * of the value, so assigning `.value` leaves React and friends convinced the
   * field is still empty — the native setter plus a bubbling input event is
   * what actually registers.
   */
  function setValue(el, text) {
    el.focus();

    if (el.isContentEditable) {
      const range = document.createRange();
      range.selectNodeContents(el);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      if (!document.execCommand('insertText', false, text)) {
        el.textContent = text;
      }
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
      return;
    }

    const proto =
      el.tagName === 'TEXTAREA'
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;

    if (setter) setter.call(el, text);
    else el.value = text;

    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /* ------------------------------------------------------------ overlay --- */

  /**
   * Showing the user what the agent just touched.
   *
   * A page that rearranges itself with no cursor moving and no click anywhere
   * is indistinguishable from a page misbehaving, and the honest reaction to
   * that is to stop the run. A ring on the element and a ripple where it was
   * clicked make the cause visible.
   *
   * Three things keep it from becoming part of the page it is drawn on:
   * `pointer-events: none` (it must never eat the next real click), a
   * `2147483647` z-index in its own stacking context, and removal on a timer
   * rather than on any page event. It is also never present during a
   * screenshot — see AGENT_FLASH, which fires only after the capture.
   */
  const OVERLAY_ID = '__sidebar_ai_agent_overlay';
  const HIGHLIGHT_MS = 900;

  /** Mirrors `agentHighlight`. Read once, then kept live by onChanged. */
  let highlightOn = true;

  chrome.storage?.local?.get('settings', (stored) => {
    if (stored?.settings && 'agentHighlight' in stored.settings) {
      highlightOn = Boolean(stored.settings.agentHighlight);
    }
  });
  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    const next = changes.settings.newValue || {};
    highlightOn = next.agentHighlight !== false;
  });

  function overlayRoot() {
    let root = document.getElementById(OVERLAY_ID);
    if (root) return root;

    root = document.createElement('div');
    root.id = OVERLAY_ID;
    root.setAttribute('aria-hidden', 'true');
    root.style.cssText =
      'position:fixed;inset:0;pointer-events:none;z-index:2147483647;' +
      'contain:layout style size;';

    // A shadow root so the host page's CSS cannot restyle any of this, and
    // ours cannot leak into the page we are meant to be observing.
    const shadow = root.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      :host { all: initial; }
      .ring, .ripple, .flash, .tag { position: fixed; pointer-events: none; }
      .ring {
        border: 2px solid #4c8dff;
        border-radius: 8px;
        box-shadow: 0 0 0 3px rgba(76,141,255,.22), 0 0 18px rgba(76,141,255,.5);
        animation: ring 900ms cubic-bezier(.16,1,.3,1) forwards;
      }
      @keyframes ring {
        from { opacity: 0; transform: scale(1.06); }
        20%  { opacity: 1; transform: scale(1); }
        to   { opacity: 0; transform: scale(1); }
      }
      .ripple {
        width: 14px; height: 14px; margin: -7px 0 0 -7px;
        border-radius: 50%;
        background: rgba(76,141,255,.55);
        animation: ripple 700ms cubic-bezier(.16,1,.3,1) forwards;
      }
      @keyframes ripple {
        from { opacity: .9; transform: scale(.4); }
        to   { opacity: 0; transform: scale(7); }
      }
      /**
       * The agent's own pointer.
       *
       * A ring appearing around a field says something happened there; a cursor
       * travelling to it says *the agent* did it, which is the question anyone
       * watching their own browser fill itself in is actually asking. It
       * persists between steps and moves — one element, transformed — so the
       * eye follows a single object instead of re-finding a new highlight each
       * time.
       *
       * The move is never awaited. A 220ms travel per action is 1.8s on an
       * eight-action batch, and slowing the agent down to animate it would be
       * paying real time for a decoration.
       */
      .cursor {
        position: fixed;
        left: 0; top: 0;
        width: 22px; height: 22px;
        pointer-events: none;
        transform: translate(-40px, -40px);
        transition: transform 220ms cubic-bezier(.16,1,.3,1);
        filter: drop-shadow(0 3px 6px rgba(0,0,0,.45));
        z-index: 2;
      }
      /* Drifting is not reaching, and they must not look the same.
         A purposeful move is the 220ms snap above — it has a target and it
         arrives. Idle drift is slow and even, with no arrival: that contrast is
         the whole reason a run reads as deliberate rather than twitchy, and
         giving both the same easing turns every reach into another wander. */
      .cursor.drift { transition: transform 1150ms cubic-bezier(.45,.05,.55,.95); }
      .cursor svg { display: block; width: 100%; height: 100%; }

      /* What the pointer is saying. Anchored to the cursor and travelling with
         it, because a caption elsewhere on the page is a second thing to watch
         — the whole point is that one object holds your attention. */
      /**
       * A sibling of the pointer, not a child of it.
       *
       * It began as a child, which put its containing block at 22 by 22 pixels
       * — the size of the cursor — so an absolutely positioned box offset by
       * left:26px had a *negative* width available to it and shrank to one word
       * per line, unreadable, on top of the form the agent was filling in. It
       * also inherited the pointer's drop-shadow filter, which is why the text
       * came out looking smeared rather than sitting on its panel.
       *
       * Fixing that with width:max-content works and is still one rule away
       * from breaking: anything that gives .cursor a size or a filter reaches
       * the caption too. A sibling positioned in the viewport has no such
       * relationship — it is moved to follow the pointer by the same code that
       * moves the pointer, which is one line and cannot be undone by a
       * stylesheet.
       */
      .saying {
        position: fixed;
        left: 0;
        top: 0;
        width: max-content;
        max-width: min(340px, 46vw);
        padding: 7px 11px;
        border-radius: 10px;
        background: rgba(17,20,28,.94);
        color: #eef1f6;
        font: 400 12px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
        box-shadow: 0 8px 26px rgba(0,0,0,.4);
        pointer-events: none;
        opacity: 0;
        /* The transform is the POSITION now, set from JS. It is still animated,
           and with the SAME timing as the pointer — a caption that snaps to the
           destination while the arrow is still travelling reads as two separate
           things rather than as one object with a label. */
        transition: opacity 220ms ease-out, transform 220ms cubic-bezier(.16,1,.3,1);
        z-index: 3;
      }
      .saying.drift { transition: opacity 220ms ease-out, transform 1150ms cubic-bezier(.45,.05,.55,.95); }
      .saying.show { opacity: 1; }
      /* A question is not a fact, and it must not look like one. */
      .saying.asking {
        background: rgba(35,26,10,.96);
        color: #ffe9bd;
        font-weight: 500;
        box-shadow: 0 8px 26px rgba(0,0,0,.45), inset 0 0 0 1px rgba(255,196,84,.35);
      }
      @media (prefers-reduced-motion: reduce) {
        .saying { transition: none; }
      }
      /* The press: the pointer dips and a halo leaves it. Both on the same
         element so they cannot drift apart on a slow frame. */
      .cursor .halo {
        position: absolute;
        left: 1px; top: 1px;
        width: 12px; height: 12px;
        margin: -6px 0 0 -6px;
        border-radius: 50%;
        border: 2px solid #4c8dff;
        opacity: 0;
      }
      /* The halo takes the pointer's own colour, or a click in the aurora
         pointer flashes the same blue as every other one and the style stops
         being a style. */
      .cursor.is-aurora .halo { border-color: #ff5fa2; }
      .cursor.is-ink .halo,
      .cursor.is-tap .halo { border-color: #161b2e; }
      /* The pointing hand clicks with its fingertip, which is at the top of the
         glyph rather than its corner. */
      .cursor.is-tap .halo { left: 9px; top: 3px; }

      .cursor.press svg { animation: cursor-dip 260ms cubic-bezier(.16,1,.3,1); }
      .cursor.press .halo { animation: cursor-halo 480ms cubic-bezier(.16,1,.3,1); }
      /* The hand presses by pushing forward, the way a finger does — a scale
         dip on a pointing hand reads as the hand shrinking, not tapping. */
      .cursor.is-tap.press svg { animation: cursor-tap 300ms cubic-bezier(.16,1,.3,1); }
      @keyframes cursor-tap {
        0%, 100% { transform: translate(0, 0); }
        45% { transform: translate(1px, 3px); }
      }
      @keyframes cursor-dip {
        0%, 100% { transform: scale(1); }
        45% { transform: scale(.82); }
      }
      @keyframes cursor-halo {
        from { opacity: .85; transform: scale(.5); }
        to   { opacity: 0; transform: scale(3.4); }
      }
      @media (prefers-reduced-motion: reduce) {
        .cursor { transition: none; }
        .cursor.press svg, .cursor.press .halo { animation: none; }
      }

      .tag {
        font: 500 11px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
        color: #fff;
        background: #1a56db;
        padding: 3px 8px;
        border-radius: 999px;
        white-space: nowrap;
        box-shadow: 0 4px 14px rgba(0,0,0,.35);
        animation: tag 900ms cubic-bezier(.16,1,.3,1) forwards;
      }
      @keyframes tag {
        from { opacity: 0; transform: translateY(4px); }
        18%  { opacity: 1; transform: none; }
        75%  { opacity: 1; transform: none; }
        to   { opacity: 0; transform: translateY(-2px); }
      }
      .flash {
        inset: 0;
        background: #fff;
        animation: flash 380ms ease-out forwards;
      }
      @keyframes flash { from { opacity: .55; } to { opacity: 0; } }

      /* --- the captured shot, popping into the corner --- */

      .shot {
        position: fixed;
        right: 20px;
        bottom: 20px;
        width: 216px;
        padding: 8px 8px 7px;
        border-radius: 14px;
        background: rgba(18,21,28,.96);
        box-shadow: 0 18px 44px rgba(0,0,0,.5), 0 0 0 1px rgba(255,255,255,.08);
        animation:
          shot-in 480ms cubic-bezier(.16,1,.3,1),
          shot-out 420ms cubic-bezier(.6,0,.9,.2) 1500ms forwards;
      }
      /* Lands from below with a little overshoot, the way a photograph dropped
         on a desk settles — then leaves TOWARDS the panel on the right, which
         is where it just went. */
      @keyframes shot-in {
        0%   { opacity: 0; transform: translate(18px, 42px) scale(.72) rotate(2.5deg); }
        60%  { opacity: 1; transform: translate(0, -4px) scale(1.03) rotate(-.6deg); }
        100% { opacity: 1; transform: none; }
      }
      @keyframes shot-out {
        to { opacity: 0; transform: translate(90px, -10px) scale(.86); }
      }
      .shot img {
        display: block;
        width: 100%;
        max-height: 150px;
        object-fit: cover;
        object-position: top left;
        border-radius: 8px;
        background: #0b0e14;
      }
      .shot .cap {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 7px 3px 1px;
        font: 500 11.5px/1 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
        color: #d7dde8;
      }
      .shot .cap b { font-weight: 600; color: #fff; }
      .shot .cap i {
        width: 6px; height: 6px; border-radius: 50%;
        background: #4c8dff; font-style: normal;
        animation: live 1.6s cubic-bezier(.16,1,.3,1) infinite;
      }
      /* A hairline that fills as the card's time runs out: the card leaving is
         not an error, and a progress edge says so before it happens. */
      .shot .bar {
        height: 2px;
        margin: 6px 2px 0;
        border-radius: 2px;
        background: rgba(255,255,255,.14);
        overflow: hidden;
      }
      .shot .bar span {
        display: block; height: 100%; width: 100%;
        background: linear-gradient(90deg, #4c8dff, #9b6cff);
        transform-origin: left center;
        animation: shot-bar 1900ms linear forwards;
      }
      @keyframes shot-bar { from { transform: scaleX(1); } to { transform: scaleX(0); } }

      @media (prefers-reduced-motion: reduce) {
        .shot { animation: shot-out 1ms linear 1900ms forwards; }
        .shot .bar span, .shot .cap i { animation: none; }
      }

      /* --- the control curtain --- */

      .curtain {
        position: fixed;
        inset: 0;
        pointer-events: auto;
        cursor: not-allowed;
        /* Darkened at the edges only: the middle of the page has to stay
           readable, because watching it is the entire point. */
        background: radial-gradient(
          ellipse at center,
          rgba(8,12,24,0) 45%,
          rgba(8,12,24,.10) 75%,
          rgba(8,12,24,.22) 100%
        );
        animation: curtain-in 260ms cubic-bezier(.16,1,.3,1);
      }
      @keyframes curtain-in { from { opacity: 0; } }

      /* A moving border, the way a screen share marks a shared window — the
         one visual language people already read as "this is being driven".

         Five designs, because this is the mark that is visible wherever you
         happen to be looking, and the right amount of movement is not the same
         for everyone: a border that travels is found by the eye immediately and
         is also the first thing to look wrong in a screen recording. They are
         all built from transform and opacity where they can be — this is
         painted over someone else's page for the whole of a run, and a border
         that costs a repaint of the viewport every frame is a tax on the site
         the agent is trying to drive.

         Common geometry only; each design supplies its own paint. */
      .frame {
        position: fixed;
        inset: 0;
        pointer-events: none;
      }

      /* The ring trick: a transparent border, a background painted to the
         border box, and a mask that subtracts the padding box — so what is left
         is the border and nothing else. Shared by every design that wants a
         gradient *in* the border rather than a shadow behind it. */
      .frame.beam,
      .frame.liquid {
        border: 2px solid transparent;
        -webkit-mask:
          linear-gradient(#000 0 0) padding-box,
          linear-gradient(#000 0 0);
        -webkit-mask-composite: xor;
        mask-composite: exclude;
      }

      /* Beam — the original. A gradient sliding along the border. */
      .frame.beam {
        background:
          linear-gradient(90deg, #4c8dff, #9b6cff, #4c8dff) border-box;
        background-size: 200% 100%;
        animation: frame-slide 3s linear infinite;
      }
      @keyframes frame-slide { to { background-position: 200% 0; } }

      /* Liquid — one light source travelling around the frame, so the colour at
         any given corner keeps changing. A conic gradient rotated by its own
         angle, which needs the angle to be a registered property: a plain
         custom property is a string to the animation engine and interpolates in
         one jump at 50%, which reads as a flicker rather than a rotation.

         Registration is document-wide even from in here, hence the deliberately
         unshareable name. If it fails the gradient simply holds still — a
         static aurora border, which is a fair-looking fallback rather than a
         missing indicator. */
      @property --sai-frame-angle {
        syntax: '<angle>';
        initial-value: 0deg;
        inherits: false;
      }
      .frame.liquid {
        --sai-frame-angle: 0deg;
        background:
          conic-gradient(
            from var(--sai-frame-angle),
            #4c8dff, #21d4c2, #9b6cff, #ff5fa2, #4c8dff
          ) border-box;
        animation: liquid-turn 6s linear infinite;
      }
      @keyframes liquid-turn { to { --sai-frame-angle: 360deg; } }

      /* Aurora — the page is *lit* from its edges rather than outlined.
         A border says "there is a boundary here"; a wash says "this whole
         surface is in a different state", which is the thing actually being
         communicated while a run has the clicks. Four coloured lights sit at
         the corners, and a mask cuts the middle out of them — the centre of the
         page has to stay honest, because watching it is the entire point.

         Drift is a transform on an already-painted layer, so the animation is
         compositor work and not a full-viewport repaint every frame. The scale
         is small and the rotation smaller: this is up for minutes at a time
         behind text somebody is reading, and anything faster reads as a fault
         in the page rather than as a state. */
      .frame.aurora {
        box-shadow: inset 0 0 0 1.5px rgba(120,160,255,.5);
      }
      .frame.aurora::before {
        content: '';
        position: absolute;
        inset: 0;
        background:
          radial-gradient(58% 52% at 6% 4%,   rgba(76,141,255,.55), transparent 70%),
          radial-gradient(52% 58% at 96% 18%, rgba(33,212,194,.42), transparent 70%),
          radial-gradient(62% 54% at 88% 97%, rgba(155,108,255,.5),  transparent 70%),
          radial-gradient(54% 50% at 12% 94%, rgba(255,95,162,.38),  transparent 70%);
        -webkit-mask: radial-gradient(ellipse 76% 72% at 50% 50%, transparent 40%, #000 92%);
        mask: radial-gradient(ellipse 76% 72% at 50% 50%, transparent 40%, #000 92%);
        transform-origin: center;
        animation: aurora-drift 13s ease-in-out infinite alternate;
      }
      @keyframes aurora-drift {
        from { transform: scale(1) rotate(0deg);      opacity: .78; }
        to   { transform: scale(1.1) rotate(3.5deg);  opacity: 1; }
      }

      /* Glow — no travel at all: the edge of the page breathes. The bloom is an
         inset shadow so it falls INTO the page and fades, which is what makes it
         read as light rather than as a thick border. */
      .frame.glow {
        box-shadow:
          inset 0 0 0 2px rgba(108,140,255,.8),
          inset 0 0 26px rgba(108,140,255,.26),
          inset 0 0 72px rgba(155,108,255,.12);
        animation: glow-breathe 2.8s ease-in-out infinite;
      }
      @keyframes glow-breathe {
        50% {
          box-shadow:
            inset 0 0 0 2px rgba(155,108,255,.95),
            inset 0 0 44px rgba(108,140,255,.44),
            inset 0 0 120px rgba(155,108,255,.2);
        }
      }

      /* Pulse — a still rule with a wave shed inward from it every couple of
         seconds, the way a radar sweep marks a live reading. The wave is a
         pseudo scaling and fading, so the animation is compositor-only. */
      .frame.pulse {
        box-shadow: inset 0 0 0 2px rgba(76,141,255,.7);
      }
      .frame.pulse::before {
        content: '';
        position: absolute;
        inset: 0;
        box-shadow:
          inset 0 0 0 2px rgba(155,108,255,.9),
          inset 0 0 26px rgba(155,108,255,.34);
        animation: pulse-wave 2.4s cubic-bezier(.16,1,.3,1) infinite;
      }
      @keyframes pulse-wave {
        0%   { transform: scale(1);    opacity: .95; }
        70%  { transform: scale(.962); opacity: 0; }
        100% { transform: scale(.962); opacity: 0; }
      }

      /* Corners — a viewfinder. The border is drawn all the way round and then
         masked down to four squares, so what survives is the bracket at each
         corner. The quietest of the five: nothing crosses the page edges the
         user is reading along, and it barely moves. */
      .frame.corners {
        border: 2px solid rgba(90,150,255,.95);
        box-shadow: inset 0 0 18px rgba(76,141,255,.16);
        -webkit-mask:
          linear-gradient(#000 0 0) 0 0     / 86px 86px no-repeat,
          linear-gradient(#000 0 0) 100% 0  / 86px 86px no-repeat,
          linear-gradient(#000 0 0) 0 100%  / 86px 86px no-repeat,
          linear-gradient(#000 0 0) 100% 100% / 86px 86px no-repeat;
        mask:
          linear-gradient(#000 0 0) 0 0     / 86px 86px no-repeat,
          linear-gradient(#000 0 0) 100% 0  / 86px 86px no-repeat,
          linear-gradient(#000 0 0) 0 100%  / 86px 86px no-repeat,
          linear-gradient(#000 0 0) 100% 100% / 86px 86px no-repeat;
        animation: corners-breathe 2.6s ease-in-out infinite;
      }
      @keyframes corners-breathe {
        0%, 100% { opacity: .62; }
        50%      { opacity: 1; }
      }

      /* The line under the tab strip, as far as an extension can draw it.
         Chrome paints its own blue rule there for a captured or debugged tab
         and there is no API to ask for that one, so this sits at the top of
         the page instead — the same signal, one toolbar lower. Thin on
         purpose: it reads as browser chrome, not as content, and it is
         position:fixed so it does not shift the page's layout by a pixel. */
      /* Panel open, nothing driving: a still line, dimmer, no animation. It
         must not look like the agent is working — that is what the moving
         gradient means, and a page that appears to be under control when it is
         not is worse than no marker. */
      .topline.idle {
        opacity: .9;
        animation: topline-in 320ms cubic-bezier(.16,1,.3,1);
        background: linear-gradient(90deg, #3f7ae0, #6f7cff 55%, #3f7ae0);
        box-shadow: 0 0 8px rgba(76,141,255,.3), 0 1px 0 rgba(0,0,0,.2);
      }
      /* No sweep when nothing is running. A moving indicator over a page the
         agent is not touching says the opposite of what is true. */
      .topline.idle::after { display: none; }

      .topline {
        position: fixed;
        top: 0; left: 0; right: 0;
        height: 3px;
        pointer-events: none;
        background: linear-gradient(90deg, #4c8dff, #9b6cff, #4c8dff);
        background-size: 200% 100%;
        box-shadow: 0 0 10px rgba(76,141,255,.55), 0 1px 0 rgba(0,0,0,.25);
        animation: frame-slide 3s linear infinite;
      }
      /* A brighter head running along the rail, so the line reads as PROGRESS
         rather than as a decorative stripe. One extra element, drawn with a
         pseudo so the bar itself stays a single node. */
      .topline::after {
        content: '';
        position: absolute;
        inset: 0;
        background: linear-gradient(
          90deg,
          transparent 0%,
          rgba(255,255,255,.85) 50%,
          transparent 100%
        );
        width: 28%;
        animation: topline-sweep 1.9s cubic-bezier(.55,0,.45,1) infinite;
      }
      @keyframes topline-sweep {
        from { transform: translateX(-40%); }
        to   { transform: translateX(400%); }
      }
      /* It grows in from the middle rather than appearing: a 3px bar that
         simply exists on the next frame is easy to miss entirely, and missing
         it is the whole failure this indicator was added for. */
      .topline { animation: frame-slide 3s linear infinite, topline-in 320ms cubic-bezier(.16,1,.3,1); }
      @keyframes topline-in {
        from { clip-path: inset(0 50% 0 50%); opacity: .4; }
        to   { clip-path: inset(0 0 0 0); opacity: 1; }
      }

      /**
       * Waiting on the user is a third state, and it is the one that costs
       * something to miss.
       *
       * Attached (still line) and driving (moving line) both mean "nothing is
       * required of you". A run stopped on a question is the opposite: it will
       * sit there forever, and from the page it looks identical to a run that
       * is simply thinking — same line, same motion, same colour. Amber is the
       * one colour already understood as "your turn" and it is not either of
       * the other two states.
       *
       * The sweep stops as well as the colour changing. Motion means work is
       * happening; leaving it running under a question says the opposite of
       * what is true, and colour alone is not a signal everyone receives.
       */
      .topline.asking {
        background: linear-gradient(90deg, #f0a020, #ffc45a 55%, #f0a020);
        box-shadow: 0 0 12px rgba(240,160,32,.6), 0 1px 0 rgba(0,0,0,.25);
        animation: topline-in 320ms cubic-bezier(.16,1,.3,1);
      }
      .topline.asking::after {
        /* A slow pulse, not a sweep: it is waiting, not working. */
        animation: asking-breathe 1.6s ease-in-out infinite;
        background: rgba(255,255,255,.5);
        width: 100%;
      }
      @keyframes asking-breathe {
        0%, 100% { opacity: 0; }
        50%      { opacity: .5; }
      }
      @media (prefers-reduced-motion: reduce) {
        .topline.asking::after { animation: none; opacity: .35; }
      }

      .pill {
        position: fixed;
        left: 50%;
        bottom: 22px;
        transform: translateX(-50%);
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 9px 10px 9px 14px;
        border-radius: 999px;
        background: rgba(17,20,28,.92);
        color: #eef1f6;
        font: 500 12.5px/1 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
        box-shadow: 0 10px 34px rgba(0,0,0,.45);
        pointer-events: auto;
        animation: pill-in 320ms cubic-bezier(.16,1,.3,1);
      }
      @keyframes pill-in {
        from { opacity: 0; transform: translate(-50%, 12px); }
      }
      .pill .live {
        width: 8px; height: 8px; border-radius: 50%;
        background: #4c8dff;
        box-shadow: 0 0 0 0 rgba(76,141,255,.6);
        animation: live 1.6s cubic-bezier(.16,1,.3,1) infinite;
      }
      @keyframes live {
        0%   { box-shadow: 0 0 0 0 rgba(76,141,255,.55); }
        70%  { box-shadow: 0 0 0 9px rgba(76,141,255,0); }
        100% { box-shadow: 0 0 0 0 rgba(76,141,255,0); }
      }
      .pill .what { opacity: .78; font-weight: 400; }
      .pill button {
        pointer-events: auto;
        border: 1px solid rgba(255,255,255,.22);
        background: transparent;
        color: inherit;
        font: inherit;
        font-size: 12px;
        padding: 5px 11px;
        border-radius: 999px;
        cursor: pointer;
      }
      .pill button:hover { background: rgba(255,255,255,.12); }

      @media (prefers-reduced-motion: reduce) {
        .curtain, .pill { animation-duration: 1ms; }
        .frame, .pill .live, .topline, .topline::after { animation: none; }
        .topline { clip-path: none; opacity: 1; }
        /* Every design still has to SHOW, which is not the same as holding
           still: the pulse is entirely its wave, and a stopped wave sits at
           whatever opacity the first frame had — invisible. Each one keeps a
           static form that says the page is being driven. */
        .frame.pulse::before { animation: none; opacity: .85; transform: none; }
        .frame.corners { animation: none; opacity: 1; }
        .frame.glow { animation: none; }
        .frame.aurora::before { animation: none; opacity: .9; transform: none; }
      }

      /* The page's reader gets a say here too: this is decoration on top of
         someone else's site, and it is the most motion-heavy thing we draw. */
      @media (prefers-reduced-motion: reduce) {
        .ring, .ripple, .tag, .flash { animation-duration: 1ms; }
      }
    `;
    shadow.append(style);
    (document.body || document.documentElement).append(root);
    return root;
  }

  function paint(node, ms = HIGHLIGHT_MS) {
    overlayRoot().shadowRoot.append(node);
    setTimeout(() => node.remove(), ms);
  }

  /** Ring the element, name what is happening, ripple if it was a click. */
  function showAction(el, label, clicked) {
    if (!highlightOn) return;

    try {
      const box = el?.getBoundingClientRect?.();
      if (!box || !box.width || !box.height) return;

      // The pointer goes to the left-hand side of a wide control rather than
      // its middle: a text field is 320px of nothing much, and an arrow parked
      // in the centre of it does not look like it is aiming at anything.
      moveCursor(Math.min(box.left + 18, box.left + box.width / 2), box.top + box.height / 2, clicked);

      const ring = document.createElement('div');
      ring.className = 'ring';
      // 3px of slack so the ring sits outside the element rather than on its
      // own border, which on a bordered control reads as a style change.
      ring.style.cssText =
        `left:${box.left - 3}px;top:${box.top - 3}px;` +
        `width:${box.width + 6}px;height:${box.height + 6}px;`;
      paint(ring);

      if (label) {
        const tag = document.createElement('div');
        tag.className = 'tag';
        tag.textContent = label;
        // Above the element, unless it is at the top of the viewport.
        const above = box.top > 26;
        tag.style.cssText =
          `left:${Math.max(6, box.left)}px;` +
          `top:${above ? box.top - 24 : box.bottom + 8}px;`;
        paint(tag);
      }

      if (clicked) {
        const ripple = document.createElement('div');
        ripple.className = 'ripple';
        ripple.style.cssText =
          `left:${box.left + box.width / 2}px;top:${box.top + box.height / 2}px;`;
        paint(ripple, 700);
      }
    } catch {
      /* decoration must never break the step it is decorating */
    }
  }

  /**
   * The same ring and ripple, around a point rather than an element.
   *
   * A coordinate click has no element to draw around until it lands, and the
   * user watching still has to see where the agent aimed — a page that
   * rearranges itself with nothing visibly clicked is the exact thing the
   * overlay exists to prevent.
   */
  /**
   * The pointer, moved to a point and optionally pressed there.
   *
   * Lives for the whole run rather than being created per action: a cursor that
   * is deleted and re-made cannot animate between two places, and travelling is
   * the entire point of it.
   */
  let cursor = null;

  /**
   * Five pointers, because one never suits every page.
   *
   * A white arrow vanishes on a white form and a dark one vanishes on a dark
   * dashboard, so this is not decoration — a pointer you cannot see on the page
   * you are watching tells you nothing about what the agent just did. Each has
   * a light and a dark half so it survives either background: `ink` is a dark
   * body with a white keyline, `classic` the reverse, and the rest carry their
   * own contrast in the fill.
   *
   * Drawn at 24x24 with the hotspot at (0,0) — the tip of every one of these
   * sits at the top-left of its box, so `translate(x, y)` puts the point
   * exactly where the click lands. Move the artwork and that stops being true.
   */
  const BLADE_PATH = '<path d="M4 2.2 18.4 11.6a1 1 0 0 1-.42 1.83l-6.06.9-2.6 5.6a1 1 0 0 1-1.9-.3z" fill="#161b2e" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/>';

  const CURSORS = {
    // The reverse of `ink`: for dark pages and dark dashboards.
    classic:
      '<svg viewBox="0 0 24 24" aria-hidden="true">' +
      '<path d="M5 2l14 8.5-6.1 1.2 3.4 6.8-2.8 1.4-3.4-6.8L5 18z" ' +
      'fill="#fff" stroke="#1a56db" stroke-width="1.4" stroke-linejoin="round"/></svg>',

    // The macOS-style solid pointer: highest contrast on a light page, which
    // is what most forms are.
    ink:
      '<svg viewBox="0 0 24 24" aria-hidden="true">' +
      '<path d="M4 1.5l15.5 9.2-6.7 1.3 3.7 7.4-3.1 1.6-3.7-7.4L4 18.6z" ' +
      'fill="#161b2e" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>',

    // Gradient, with a tail — the one that reads as "software is driving this"
    // rather than "someone is using the mouse".
    aurora:
      '<svg viewBox="0 0 24 24" aria-hidden="true">' +
      '<defs><linearGradient id="ag" x1="0" y1="0" x2="1" y2="1">' +
      '<stop offset="0" stop-color="#ff5fa2"/><stop offset=".5" stop-color="#a855f7"/>' +
      '<stop offset="1" stop-color="#ffab3d"/></linearGradient></defs>' +
      '<path d="M4 1.5l15.5 9.2-6.7 1.3 3.7 7.4-3.1 1.6-3.7-7.4L4 18.6z" ' +
      'fill="url(#ag)" stroke="#fff" stroke-width="1.3" stroke-linejoin="round"/>' +
      '<circle cx="20.5" cy="19" r="1.9" fill="#ff5fa2" opacity=".85"/>' +
      '<circle cx="22.6" cy="15.4" r="1.2" fill="#a855f7" opacity=".6"/></svg>',

    // A pointing hand: unmistakably "this is being clicked", and the shape
    // people already read as an active click target.
    tap:
      '<svg viewBox="0 0 24 24" aria-hidden="true">' +
      '<path d="M8.6 11V3.6a1.7 1.7 0 013.4 0V10h.6V8.2a1.5 1.5 0 013 0V10h.6V9a1.4 1.4 0 012.8 0v6.4c0 3.4-2.2 5.8-5.6 5.8-2.9 0-4.4-1.2-5.6-3.4l-2-3.7a1.5 1.5 0 012.4-1.7z" ' +
      'fill="#161b2e" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>',

    /**
     * The arrowhead alone — the "<", without the "-" the classic pointer
     * trails behind it.
     *
     * Every desktop pointer is a head plus a leg hanging off its bottom-left,
     * and at 22px on a busy page that leg is the part that reads as clutter:
     * it is the widest thing about the glyph and it points at nothing. Cutting
     * it leaves a shape that is all direction — which is the only job a
     * pointer has.
     */
    blade:
      '<svg viewBox="0 0 24 24" aria-hidden="true">' + BLADE_PATH + '</svg>',

    // Almost nothing: a ring and a dot. For anyone who finds a drawn pointer on
    // their own page distracting but still wants to see where it went.
    halo:
      '<svg viewBox="0 0 24 24" aria-hidden="true">' +
      '<circle cx="6" cy="6" r="4.6" fill="none" stroke="#4c8dff" stroke-width="2"/>' +
      '<circle cx="6" cy="6" r="4.6" fill="none" stroke="#fff" stroke-width="0.8"/>' +
      '<circle cx="6" cy="6" r="1.5" fill="#4c8dff"/></svg>'
  };

  /** Mirrors `agentCursor`. Read once, kept live by onChanged, like the rest. */
  let cursorStyle = 'ink';

  chrome.storage?.local?.get('settings', (stored) => {
    const chosen = stored?.settings?.agentCursor;
    if (chosen && CURSORS[chosen]) cursorStyle = chosen;
  });
  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    const chosen = changes.settings.newValue?.agentCursor;
    if (!chosen || !CURSORS[chosen] || chosen === cursorStyle) return;
    cursorStyle = chosen;
    // Rebuilt rather than re-skinned: the styles differ in shape, not just
    // colour, and swapping innerHTML on the live element mid-travel leaves the
    // old artwork's transform running under the new one.
    cursor?.remove();
    cursor = null;
  });

  /**
   * The border designs, by name. The value is the class the frame carries.
   *
   * A set rather than a free string, for the same reason as CURSORS: this comes
   * out of storage, which can hold a value from a build that shipped a design
   * we have since dropped, and an unrecognised class would leave the frame
   * painted with the shared geometry and no colour at all — an invisible
   * border, which is exactly the failure the border exists to prevent.
   */
  const FRAMES = new Set(['aurora', 'liquid', 'beam', 'glow', 'pulse', 'corners']);
  const DEFAULT_FRAME = 'aurora';

  /** Mirrors `agentFrame`. Read once, kept live by onChanged, like the rest. */
  let frameStyle = DEFAULT_FRAME;

  chrome.storage?.local?.get('settings', (stored) => {
    const chosen = stored?.settings?.agentFrame;
    if (chosen && FRAMES.has(chosen)) frameStyle = chosen;
  });
  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    const chosen = changes.settings.newValue?.agentFrame;
    if (!chosen || !FRAMES.has(chosen) || chosen === frameStyle) return;
    frameStyle = chosen;
    // Applied live rather than at the next run. Someone picking a border is
    // looking at one, and the only way to see it is with the agent driving —
    // so a choice that took effect on the *next* run would be chosen blind.
    const showing = curtain?.querySelector('.frame');
    if (showing) showing.className = `frame ${frameStyle}`;
  });

  /**
   * Where the pointer is now.
   *
   * Kept rather than read back off the element, because the transform is
   * mid-transition most of the time this is asked and `getComputedStyle` would
   * answer with wherever the animation had got to. The next move has to start
   * from the last place we *sent* it, or a reach interrupted by a drift lands
   * short.
   */
  let cursorAt = null;

  /** Mirrors `agentIdleCursor`. */
  let idleCursorOn = true;
  let idleTimer = null;

  chrome.storage?.local?.get('settings', (stored) => {
    if (stored?.settings && 'agentIdleCursor' in stored.settings) {
      idleCursorOn = Boolean(stored.settings.agentIdleCursor);
    }
  });
  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    idleCursorOn = changes.settings.newValue?.agentIdleCursor !== false;
    if (idleCursorOn) startIdling();
    else stopIdling();
  });

  const wantsLessMotion = () => {
    try {
      return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    } catch {
      return false;
    }
  };

  function moveCursor(x, y, pressed, drifting = false) {
    if (!highlightOn) return;

    try {
      const shadow = overlayRoot()?.shadowRoot;
      if (!shadow) return;

      if (!cursor || !cursor.isConnected) {
        cursor = document.createElement('div');
        cursor.className = `cursor is-${cursorStyle}`;
        cursor.innerHTML =
          '<span class="halo"></span>' + (CURSORS[cursorStyle] || CURSORS.ink);
        shadow.append(cursor);
      }

      cursor.classList.toggle('drift', Boolean(drifting));
      cursorAt = { x, y };
      cursor.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
      // The caption is a sibling, so it has to be carried — same frame and same
      // easing as the pointer, or the two visibly come apart on every move.
      if (saying?.isConnected) {
        saying.classList.toggle('drift', Boolean(drifting));
        placeSaying();
      }

      if (pressed) {
        // Restart the animation: without the reflow, two clicks in a row on the
        // same spot play it once.
        cursor.classList.remove('press');
        void cursor.offsetWidth;
        cursor.classList.add('press');
      }

      /**
       * A hand does not wander while it is reaching for something.
       *
       * So a real move stops the drift outright and restarts it a beat later,
       * rather than the two taking turns to set the same transform — which
       * looks, precisely, like a fight over the cursor. The restart is what
       * makes the pause between a batch's last action and the provider's next
       * reply feel occupied rather than hung.
       */
      if (!drifting) {
        stopIdling();
        startIdling(900);
      }
    } catch {
      /* decoration must never break the step it is decorating */
    }
  }

  /**
   * The pointer stays alive between actions.
   *
   * Most of a run is spent waiting on a provider round trip — ten to forty
   * seconds in which the curtain is up, the page cannot be clicked, and
   * absolutely nothing on screen moves. A frozen arrow through all of that is
   * the single thing that makes a working run look hung, and the honest
   * reaction to a hung run is to press Stop on one that was fine.
   *
   * It only ever runs while a run holds the page (`curtain`), which is what
   * makes it truthful rather than theatre: the claim it makes is "this page is
   * still mine", and that claim is true for exactly as long as the curtain is
   * up. Nothing drifts on a page the agent is not driving.
   */
  /**
   * What the pointer says while it waits.
   *
   * `notes` are facts about this site, worked out during the planning turn
   * because that is the one moment the whole page is already in front of the
   * model. They are shown one at a time through the dead stretches, which are
   * most of a run — a pointer that drifts says "still working", and a pointer
   * that tells you something says the wait bought something.
   */
  let notes = [];
  let noteAt = 0;

  /**
   * What to say before there is anything to say.
   *
   * The notes are a product of the planning turn, so during the planning turn
   * itself there are none — and that is the longest single wait in a run: a
   * whole-page capture, an upload, and a full provider round trip before one
   * character is typed anywhere. It is also the wait most likely to be read as
   * a hang, because nothing has visibly happened yet at all.
   *
   * These say what is actually going on rather than filling the space. They
   * are replaced the moment real notes arrive, and never mixed with them —
   * "reading the page" is untrue once the page has been read.
   */
  const WARMUP = [
    'Reading the whole page before touching anything.',
    'Working out a route, so the steps after this are quick.',
    'Checking what is below the fold as well as on screen.',
    'Looking for the fields and buttons this task needs.',
    'Deciding what can be done in one go and what cannot.',
    'Thinking it through once now, rather than at every step.'
  ];
  let saying = null;
  let sayingTimer = null;

  /**
   * Asking, said several ways.
   *
   * The same sentence every time stops being read after the second run — it
   * becomes furniture, which is the opposite of what a question needs. These
   * all mean "this one is yours to decide" and none of them says what the
   * decision IS: the panel has the actual question, and repeating it in a
   * bubble on the page invites answering it in the wrong place.
   */
  const ASK_LINES = [
    'Your call — the answer is in the panel.',
    'Waiting on you. Check the side panel to decide.',
    'This one is yours to choose. Have a look at the panel.',
    'Paused for your decision — the panel is asking.',
    'Over to you: say yes or no in the panel.',
    'Not mine to decide. Your answer is needed in the panel.',
    'Holding here until you choose in the panel.',
    'Your decision, whenever you are ready — see the panel.'
  ];
  let lastAsk = -1;

  function say(text, kind) {
    if (!highlightOn || !cursor) return;

    try {
      const shadow = overlayRoot()?.shadowRoot;
      if (!shadow) return;

      if (!saying || !saying.isConnected) {
        saying = document.createElement('div');
        saying.className = 'saying';
        shadow.append(saying);
      }

      saying.textContent = text;
      saying.classList.toggle('asking', kind === 'asking');
      // Placed before it is shown, not after: a bubble that appears in the
      // wrong place and then jumps has already failed at being read.
      placeSaying();
      saying.classList.add('show');
    } catch {
      /* a caption is the least important thing on this page */
    }
  }

  /**
   * Put the caption beside the pointer, on whichever side it fits.
   *
   * Measured rather than guessed at: the bubble's own width decides whether it
   * would run off the right edge, and a caption drawn off-screen is a caption
   * that silently does not exist. Same for the bottom, where the run's own
   * "Agent is in control" pill sits.
   */
  function placeSaying() {
    if (!saying || !cursorAt) return;

    const box = saying.getBoundingClientRect();
    const width = box.width || 260;
    const height = box.height || 34;

    const right = cursorAt.x + 26;
    const x = right + width > window.innerWidth - 12 ? Math.max(8, cursorAt.x - 8 - width) : right;
    const y = Math.min(cursorAt.y + 6, window.innerHeight - height - 74);

    saying.style.transform = `translate(${Math.round(x)}px, ${Math.round(Math.max(8, y))}px)`;
  }

  function hush() {
    if (sayingTimer) clearTimeout(sayingTimer);
    sayingTimer = null;
    saying?.classList.remove('show');
  }

  /** The next line, in order, wrapping — so a long wait works through them. */
  function nextNote() {
    const list = notes.length ? notes : WARMUP;
    const note = list[noteAt % list.length];
    noteAt += 1;
    return note;
  }

  /**
   * The question the run is waiting on, held up until it is answered.
   *
   * Not on a timer like the notes: an approval that scrolled away after four
   * seconds is worse than none, because the run then looks stopped for no
   * stated reason. It stays until `AGENT_ASKING` says the answer arrived.
   */
  let asking = false;

  function startIdling(delay) {
    stopIdling();
    if (!idleCursorOn || !highlightOn || !curtain || wantsLessMotion()) return;
    idleTimer = setTimeout(idleStep, delay ?? nextIdleWait());
  }

  function stopIdling() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
  }

  /**
   * Never a fixed interval.
   *
   * An evenly-timed twitch is the tell — it is the one thing a hand never does,
   * and a metronome reads as a progress indicator rather than as a person.
   */
  const nextIdleWait = () => 700 + Math.random() * 1900;

  function idleStep() {
    idleTimer = null;
    if (!curtain || !idleCursorOn || !highlightOn) return;

    try {
      const margin = 14;
      const maxX = Math.max(margin, window.innerWidth - 30);
      // Clear of the "Agent is in control" pill: the pointer is
      // pointer-events:none so it cannot block Take over, but parking on top of
      // the one control the user has is still the wrong place to rest.
      const maxY = Math.max(margin, window.innerHeight - 110);
      const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

      const from = cursorAt || { x: window.innerWidth * 0.5, y: window.innerHeight * 0.55 };

      /**
       * Mostly small, occasionally not.
       *
       * Idle hand movement is not uniform noise: it is long stretches of tiny
       * drift with the occasional deliberate reposition. Sampling one range for
       * both gives a pointer that vibrates in place, which reads as a fault.
       */
      const big = Math.random() < 0.22;
      const reach = big ? 60 + Math.random() * 130 : 5 + Math.random() * 16;
      const angle = Math.random() * Math.PI * 2;

      const to = {
        x: clamp(from.x + Math.cos(angle) * reach, margin, maxX),
        y: clamp(from.y + Math.sin(angle) * reach, margin, maxY)
      };

      if (big) {
        /**
         * A long move goes in an arc, because a straight line is the giveaway.
         *
         * Two legs with the waypoint pushed off the line between them is enough
         * — at this duration the eye reads the corner as a curve. A real path
         * would need a JS animation loop running for the whole of every wait,
         * which is a frame budget spent on a decoration.
         */
        const midX = (from.x + to.x) / 2 + Math.cos(angle + Math.PI / 2) * reach * 0.28;
        const midY = (from.y + to.y) / 2 + Math.sin(angle + Math.PI / 2) * reach * 0.28;
        moveCursor(clamp(midX, margin, maxX), clamp(midY, margin, maxY), false, true);
        setTimeout(() => {
          if (curtain && idleCursorOn) moveCursor(to.x, to.y, false, true);
        }, 560);
      } else {
        moveCursor(to.x, to.y, false, true);
      }

      /**
       * A note every few moves, not every one.
       *
       * Back to back they are a feed, which is something to keep up with rather
       * than something to glance at — and a bubble that changes as fast as the
       * pointer moves is unreadable anyway. On a big reposition it stays quiet:
       * a caption dragged across the page is the one way to make a smooth move
       * look like a glitch.
       */
      if (!asking && !big && Math.random() < 0.42) {
        const note = nextNote();
        if (note) {
          say(note);
          if (sayingTimer) clearTimeout(sayingTimer);
          sayingTimer = setTimeout(() => {
            if (!asking) saying?.classList.remove('show');
          }, 5200);
        }
      }

      // The second leg has to land before the next wander is scheduled, or a
      // long move gets interrupted halfway and reads as a stumble.
      idleTimer = setTimeout(idleStep, nextIdleWait() + (big ? 560 : 0));
      return;
    } catch {
      /* a wandering pointer is the least important thing on the page */
    }

    idleTimer = setTimeout(idleStep, nextIdleWait());
  }

  function showActionAt(x, y, label) {
    if (!highlightOn) return;

    try {
      moveCursor(x, y, true);

      const size = 34;
      const ring = document.createElement('div');
      ring.className = 'ring';
      ring.style.cssText =
        `left:${x - size / 2}px;top:${y - size / 2}px;width:${size}px;height:${size}px;`;
      paint(ring);

      if (label) {
        const tag = document.createElement('div');
        tag.className = 'tag';
        tag.textContent = label;
        tag.style.cssText = `left:${Math.max(6, x - 20)}px;top:${y > 30 ? y - 30 : y + 20}px;`;
        paint(tag);
      }

      const ripple = document.createElement('div');
      ripple.className = 'ripple';
      ripple.style.cssText = `left:${x}px;top:${y}px;`;
      paint(ripple, 700);
    } catch {
      /* decoration must never break the step it is decorating */
    }
  }

  function showFlash() {
    if (!highlightOn) return;
    const flash = document.createElement('div');
    flash.className = 'flash';
    paint(flash, 420);
  }

  /**
   * The picture that was just taken, shown to the person it was taken from.
   *
   * Both paths end here — the region you dragged, and the screenshot the agent
   * decided to take on its own — because both raise the same question and it is
   * not a small one: *what* exactly got sent. A flash says a photograph
   * happened; only the photograph says what is in it. It lands bottom-right and
   * leaves towards the panel on the right, which is where it went.
   */
  function showShot(image, label) {
    if (!highlightOn || !image) return;

    const card = document.createElement('div');
    card.className = 'shot';

    const img = document.createElement('img');
    img.src = image;
    img.alt = '';

    const cap = document.createElement('div');
    cap.className = 'cap';
    const dot = document.createElement('i');
    const strong = document.createElement('b');
    strong.textContent = label || 'Screenshot';
    const tail = document.createElement('span');
    tail.textContent = 'sent to the assistant';
    tail.style.opacity = '.72';
    cap.append(dot, strong, tail);

    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.append(document.createElement('span'));

    card.append(img, cap, bar);
    // Slightly longer than the exit animation ends, so it is never cut mid-fade.
    paint(card, 2050);
  }

  /* ------------------------------------------------------------ control --- */

  /**
   * "The agent is driving this page, so you are not."
   *
   * Two clicks landing on the same page from two directions is not a race the
   * user can win: the model decided what to click from an observation taken
   * before your click changed the page, so it acts on a page that no longer
   * exists — and the run then reports something that never happened. The
   * curtain stops that by taking the clicks itself.
   *
   * It is a curtain and not a lock. `Take over` releases it immediately,
   * because a page that traps you until a background process finishes is worse
   * than any mis-click, and the run itself is stopped from the side panel.
   */
  let curtain = null;

  function blockTrusted(event) {
    // `isTrusted` is the whole reason this is safe to install: the agent's own
    // clicks and its Enter-to-submit are synthetic, so they pass straight
    // through while a real one is stopped.
    if (!event.isTrusted) return;

    /**
     * Everything except our own pill.
     *
     * This listener is on `window` with capture, so it runs *before* the event
     * reaches anything — including the "Take over" button inside the overlay.
     * `stopImmediatePropagation` then killed the one click that exists to let
     * the user out, and the button did nothing at all: a curtain with a
     * decorative exit is worse than a curtain with none, because the user
     * presses it and concludes the whole extension has hung.
     *
     * The exemption is the *pill*, not the overlay: the curtain is in the
     * overlay too, it covers the whole window, and letting anything through
     * that touches the overlay would let everything through — including the
     * wheel events the curtain is there to swallow.
     *
     * `composedPath` is what sees through the shadow root; `event.target` from
     * out here is only ever the host element.
     */
    const path = event.composedPath?.() || [];
    if (path.some((node) => node?.classList?.contains?.('pill'))) return;

    event.stopImmediatePropagation();
    event.preventDefault();
  }

  /**
   * Clicks *and* scrolling.
   *
   * Blocking clicks alone leaves the page scrollable, and a page that scrolls
   * under the agent is the same failure the curtain was written for: the model
   * picked an element from an observation taken at one scroll position and
   * clicks it at another. Wheel and touch have to be registered non-passive or
   * `preventDefault` is ignored — Chrome makes them passive by default on
   * window, which is exactly the silent no-op this looked like.
   *
   * The agent scrolls with `window.scrollTo`, which no event can block.
   */
  const BLOCKED_EVENTS = [
    'pointerdown', 'mousedown', 'click', 'keydown', 'keypress',
    'wheel', 'touchstart', 'touchmove'
  ];

  const BLOCK_OPTIONS = { capture: true, passive: false };

  /**
   * Mark the tab itself, not just the page inside it.
   *
   * Chrome's own "this tab is being driven" rule in the tab strip is not
   * something an extension can ask for — there is no API for the strip at all.
   * The favicon is the one pixel of it we own, so a controlled tab gets a dot
   * burned into the corner of its icon. That is what makes a background tab
   * the agent opened identifiable while you are looking at a different one;
   * the line at the top of the page can only be seen once you are already
   * there.
   *
   * The originals are kept rather than reconstructed: plenty of sites swap
   * their own favicon for unread counts, and putting back a guess would leave
   * the page permanently wrong in a way nobody would connect to us.
   */
  let faviconWas = null;

  function markFavicon() {
    if (faviconWas) return;

    const links = [...document.querySelectorAll('link[rel~="icon" i]')];
    faviconWas = links.map((el) => ({ el, href: el.getAttribute('href') }));

    const source =
      links.map((el) => el.href).find(Boolean) || new URL('/favicon.ico', location.href).href;

    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 32;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(image, 0, 0, 32, 32);
        ctx.beginPath();
        ctx.arc(23, 23, 9, 0, Math.PI * 2);
        ctx.fillStyle = '#0f1320';
        ctx.fill();
        ctx.beginPath();
        ctx.arc(23, 23, 6.5, 0, Math.PI * 2);
        ctx.fillStyle = '#4c8dff';
        ctx.fill();
        applyFavicon(canvas.toDataURL('image/png'));
      } catch {
        // A cross-origin icon taints the canvas and `toDataURL` throws. The
        // dot is a nicety; the line at the top of the page is the indicator
        // that has to work, so this failing changes nothing that matters.
      }
    };
    // A missing or unreachable icon is not worth a console error.
    image.onerror = () => {};
    image.src = source;
  }

  function applyFavicon(dataUrl) {
    if (!faviconWas) return;

    if (faviconWas.length) {
      for (const { el } of faviconWas) el.setAttribute('href', dataUrl);
      return;
    }

    // No icon of its own — Chrome is showing the default. Add one, and
    // remember to remove rather than restore it.
    const link = document.createElement('link');
    link.rel = 'icon';
    link.setAttribute('href', dataUrl);
    document.head.appendChild(link);
    faviconWas = [{ el: link, href: null, added: true }];
  }

  function restoreFavicon() {
    for (const { el, href, added } of faviconWas || []) {
      if (added) el.remove();
      else if (href == null) el.removeAttribute('href');
      else el.setAttribute('href', href);
    }
    faviconWas = null;
  }

  /**
   * The "this tab has the assistant attached" line, on its own.
   *
   * Separate from the curtain because the two states are separate and the user
   * has to be able to tell them apart: the panel being OPEN on this tab is
   * ambient and takes no clicks, while the agent DRIVING it stops the page
   * responding to you. Before this there was no mark for the first state at
   * all — the panel looks identical on every tab, so which page it was reading
   * was unanswerable from the screen.
   *
   * It reuses `.topline`, with `.control` added while a run is in charge, so
   * one element moves between the two states instead of two elements fighting
   * over the same three pixels.
   */
  let panelLine = null;
  let panelOpen = false;

  function showPanelMark(on) {
    panelOpen = Boolean(on);
    drawPanelLine();
  }

  /**
   * One line at a time. The curtain draws its own, animated; this draws the
   * still one. Both at once is two gradients stacked in the same three pixels,
   * and the idle one showing through a run says the opposite of what is true.
   */
  function drawPanelLine() {
    const wanted = panelOpen && highlightOn && !curtain;

    if (!wanted) {
      panelLine?.remove();
      panelLine = null;
      // The favicon dot is shared: the curtain wants it while a run is going,
      // the panel wants it whenever it is attached here. Only give it back
      // when neither does.
      if (!curtain && !panelOpen) restoreFavicon();
      return;
    }

    if (panelLine) return;

    panelLine = document.createElement('div');
    panelLine.className = 'topline idle';
    overlayRoot().shadowRoot.append(panelLine);
    markFavicon();
  }

  function takeControl() {
    if (!highlightOn || curtain) return;

    const shadow = overlayRoot().shadowRoot;

    curtain = document.createElement('div');
    curtain.className = 'curtain';

    const frame = document.createElement('div');
    frame.className = `frame ${frameStyle}`;

    const topline = document.createElement('div');
    topline.className = 'topline';

    const pill = document.createElement('div');
    pill.className = 'pill';

    const live = document.createElement('span');
    live.className = 'live';

    const text = document.createElement('span');
    text.textContent = 'Agent is in control';

    const what = document.createElement('span');
    what.className = 'what';
    what.textContent = 'clicks are paused';

    const give = document.createElement('button');
    give.type = 'button';
    give.textContent = 'Take over';
    give.addEventListener('click', (event) => {
      event.stopPropagation();
      releaseControl();
    });

    pill.append(live, text, what, give);
    curtain.append(frame, topline, pill);
    shadow.append(curtain);

    markFavicon();
    // The run owns the line now; the still one would sit under the moving one.
    drawPanelLine();

    /**
     * The pointer exists from the moment control is taken, not from the first
     * action. The longest wait of a run is the one before anything has happened
     * — the survey turn and the first decision — and that is exactly the stretch
     * that used to have nothing on screen moving at all. It rests low and
     * centre, where a hand would be, rather than at the origin.
     */
    if (idleCursorOn) {
      moveCursor(window.innerWidth * 0.5, window.innerHeight * 0.62, false, true);
      startIdling();
    }

    for (const type of BLOCKED_EVENTS) {
      window.addEventListener(type, blockTrusted, BLOCK_OPTIONS);
    }
  }

  function releaseControl() {
    for (const type of BLOCKED_EVENTS) {
      window.removeEventListener(type, blockTrusted, BLOCK_OPTIONS);
    }
    curtain?.remove();
    curtain = null;
    // Order matters: the curtain has to be gone before this decides whether
    // the still line comes back, and before restoreFavicon is allowed to run.
    drawPanelLine();
    if (!panelOpen) restoreFavicon();
    // The pointer belongs to the run, not to the page. Leaving it behind is an
    // arrow sitting on a page nothing is driving any more — and a *drifting*
    // one left behind is worse, because it claims a run is still going.
    stopIdling();
    hush();
    saying = null;
    asking = false;
    notes = [];
    cursor?.remove();
    cursor = null;
    cursorAt = null;
  }

  /** Page actions that are meaningless without something to do them to. */
  const NEEDS_ELEMENT = new Set(['click', 'type', 'select']);

  /**
   * A control that answers with a list rather than with a value.
   *
   * Typing "LinkedIn" into one of these is not filling it in — it filters a
   * list that then has to be *chosen* from, and until something is chosen the
   * field is empty as far as the form is concerned. That is the whole of the
   * Workday failure: type, submit, "is required and must have a value", repeat.
   * Whatever comes next depends on what the list turns out to contain, so a
   * plan cannot be written past this point and the batch stops here.
   */
  function opensAChooser(el) {
    if (!el?.getAttribute) return false;

    const role = (el.getAttribute('role') || '').toLowerCase();
    if (
      role === 'combobox' ||
      el.getAttribute('aria-haspopup') ||
      el.getAttribute('aria-autocomplete') ||
      el.hasAttribute('aria-expanded') ||
      el.getAttribute('aria-controls') ||
      el.closest('[role="combobox"], [role="listbox"]')
    ) {
      return true;
    }

    /**
     * The same control, built by a framework that never heard of ARIA.
     *
     * Workday's source picker is the case this was written from: an `<input
     * placeholder="Search">` with no role, no aria-expanded and no
     * aria-haspopup — nothing an accessibility-shaped test can see. What it
     * does have is `data-uxi-widget-type="selectinput"` inside a
     * `data-automation-id="multiSelectContainer"`, and every enterprise form
     * builder leaves marks like these because its own test suite needs them.
     * Matching on "does this attribute mention selecting" is loose on purpose:
     * a false positive costs one extra observation, a false negative costs the
     * run.
     */
    // Data attributes only. `class` looks tempting and is a trap: Tailwind
    // ships `select-none` and `user-select-none` on half the elements of a
    // modern page, and every batch would stop on the first field it touched.
    const marks = ['data-uxi-widget-type', 'data-automation-id', 'data-testid'];
    const CHOOSER = /(multi)?select|combobox|autocomplete|typeahead|dropdown|picker|prompt|lookup/i;

    for (const attr of marks) {
      const own = el.getAttribute(attr);
      if (own && CHOOSER.test(own)) return true;
    }

    return Boolean(
      el.closest(
        '[data-uxi-widget-type*="select" i], [data-automation-id*="select" i], ' +
          '[data-automation-id*="prompt" i], [data-automation-id*="searchbox" i], ' +
          '[data-testid*="select" i], [data-testid*="combobox" i]'
      )
    );
  }

  /**
   * A click at a point, for what the element list cannot reach.
   *
   * Some things are only ever visible in a picture: an option rendered into a
   * portal at the end of the document, a canvas control, a custom widget that
   * carries no role and no label. The screenshot the loop already attaches
   * shows exactly where they are, so the model can aim at them directly.
   *
   * The full pointer sequence, not `el.click()`: a menu built out of divs
   * usually commits on `pointerdown`/`mouseup` and ignores a bare click, and
   * the ones that listen for click get it anyway at the end of the sequence.
   */
  /**
   * What the user would hit at this point — not what we put in the way.
   *
   * The curtain is a full-screen element with `pointer-events: auto`, and it is
   * up for the whole of every run, so `elementFromPoint` answers "the agent's
   * own overlay" every single time. A coordinate click would then land on our
   * blocker instead of the page: the ring drew, the ripple played, the cursor
   * pressed, and nothing happened. `elementsFromPoint` gives the whole stack,
   * and the first entry that is not ours is the page underneath.
   */
  function elementAtPoint(x, y) {
    const stack = document.elementsFromPoint(x, y) || [];
    return stack.find((el) => el.id !== OVERLAY_ID && !el.closest?.(`#${OVERLAY_ID}`)) || null;
  }

  /**
   * Everything a real click is, aimed at one element.
   *
   * `el.click()` dispatches a single `click` event and nothing else, and that
   * is not what a browser does. Workday's option rows commit on `pointerdown`;
   * so do most menus, comboboxes and drag-aware controls built out of divs.
   * They ignored the click entirely, which is why every attempt at that list —
   * by id, by coordinate, by anything — appeared to do nothing at all.
   *
   * The sequence ends with a `click`, so native activation behaviour (a submit
   * button, a link, a label) still happens: the browser walks up from the
   * event's target to find it, which also means dispatching on an inner span
   * submits its form exactly as clicking the span would.
   */
  function press(target, x, y) {
    const common = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: x,
      clientY: y
    };

    target.dispatchEvent(new PointerEvent('pointerover', { ...common, isPrimary: true }));
    target.dispatchEvent(new MouseEvent('mouseover', common));
    target.dispatchEvent(new PointerEvent('pointerdown', { ...common, isPrimary: true, buttons: 1 }));
    target.dispatchEvent(new MouseEvent('mousedown', { ...common, buttons: 1 }));
    target.dispatchEvent(new PointerEvent('pointerup', { ...common, isPrimary: true }));
    target.dispatchEvent(new MouseEvent('mouseup', common));
    target.dispatchEvent(new MouseEvent('click', common));
    return target;
  }

  function clickAtPoint(x, y) {
    const target = elementAtPoint(x, y);
    if (!target) return null;
    return press(target, x, y);
  }

  /**
   * Click an element the way the mouse would: at its centre, on whatever is
   * innermost there.
   *
   * The second half matters as much as the pointer sequence. A listed element
   * is the one that carries the role and the label — Workday's option row is a
   * `role="option"` wrapper — while the handler often sits on a child of it,
   * and an event dispatched on the wrapper never reaches a child, because
   * events go up, not down. A real click's target is the innermost element
   * under the cursor, so that is what this aims at; `contains` keeps it honest
   * when something unrelated is covering the point.
   */
  function clickElement(el) {
    const box = el.getBoundingClientRect();
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;

    const inner = elementAtPoint(x, y);
    const target = inner && (inner === el || el.contains(inner)) ? inner : el;

    press(target, x, y);
    return target;
  }

  /**
   * The field at a point, for typing from a screenshot.
   *
   * Aiming at a picture lands on whatever is drawn there — a wrapper, a
   * placeholder span, the field's own border — and none of those take text. So
   * the search goes outwards then inwards from what was hit, which is how a
   * person's click on the padding of an input still puts the caret in it.
   *
   * Without this the coordinate escape hatch stops half way: `click_at` can
   * reach a field the numbered list cannot address, and then there is no way to
   * put anything in it.
   */
  const FIELDS = 'input:not([type="hidden"]), textarea, [contenteditable="true"]';

  function fieldAtPoint(x, y) {
    const hit = elementAtPoint(x, y);
    if (!hit) return null;

    // The point is on the field, or on something inside one.
    if (hit.matches?.(FIELDS)) return hit;
    const around = hit.closest?.(FIELDS);
    if (around) return around;

    /**
     * Last resort: a wrapper drawn over its own input, which is how several
     * form builders hide the real control. Bounded hard, because the obvious
     * version of this is a trap — `body.querySelector('input')` answers "the
     * first field on the page" for a coordinate that hit nothing at all, and a
     * miss then silently types the address into the name box. A field wrapper
     * is small and is never the document itself.
     */
    if (hit === document.body || hit === document.documentElement) return null;
    const box = hit.getBoundingClientRect();
    if (box.height > 200) return null;

    return hit.querySelector?.(FIELDS) || null;
  }

  /**
   * The `input[type=file]` a visible uploader stands for.
   *
   * Sites hide the real input and dress a button or a label as the control, so
   * what is in the element list is never the thing that takes the file. Ordered
   * cheapest-first and stops at the form: reaching further would find the
   * unrelated input of some other uploader further up the page, and attaching a
   * CV to the wrong field looks like success from every angle.
   */
  function fileInputFor(el) {
    if (!el) return null;
    if (el.tagName === 'INPUT' && el.type === 'file') return el;
    if (el.control?.type === 'file') return el.control;               // <label for>
    const within = el.querySelector?.('input[type="file"]');
    if (within) return within;
    const label = el.closest?.('label');
    if (label?.control?.type === 'file') return label.control;
    const scope = el.closest?.('form, fieldset, section, div');
    return scope?.querySelector('input[type="file"]') || null;
  }

  /** Does `accept` allow this file? Extension or MIME, either is enough. */
  function acceptsFile(accept, name = '', type = '') {
    const ext = '.' + String(name).split('.').pop().toLowerCase();
    return String(accept)
      .split(',')
      .map((rule) => rule.trim().toLowerCase())
      .filter(Boolean)
      .some((rule) => {
        if (rule === '*/*' || rule === '*') return true;
        if (rule.startsWith('.')) return rule === ext;
        if (rule.endsWith('/*')) return String(type).startsWith(rule.slice(0, -1));
        return rule === String(type).toLowerCase();
      });
  }

  function act(action) {
    let el = resolve(action);

    if (action.id != null && !el) {
      return { ok: false, error: `No element [${action.id}] on this page. Observe again.` };
    }

    // A coordinate is the other way to name an element. `type` accepts it so
    // the screenshot path can finish what it starts.
    const x = Number(action.x);
    const y = Number(action.y);
    if (!el && action.action === 'type' && Number.isFinite(x) && Number.isFinite(y)) {
      el = fieldAtPoint(x, y);
      if (!el) {
        return {
          ok: false,
          error: `Nothing at (${x}, ${y}) can be typed into. Click the field first, or aim at the box itself.`
        };
      }
    }

    // No id at all. Saying so is the difference between the model re-observing
    // and the loop reporting a raw "Cannot read properties of null" — which
    // tells it nothing about what to do differently.
    if (!el && NEEDS_ELEMENT.has(action.action)) {
      return {
        ok: false,
        error:
          `“${action.action}” needs an element id from the last observation` +
          (action.action === 'type' ? ', or an x/y from the screenshot' : '') +
          '.'
      };
    }

    if (el) el.scrollIntoView({ block: 'center', behavior: 'instant' });

    switch (action.action) {
      case 'click': {
        // Drawn before the click, measured before the click: a click that
        // navigates or opens a dialog leaves nothing to measure afterwards.
        showAction(el, 'Agent clicked', true);
        const chooser = opensAChooser(el);
        const hit = clickElement(el);
        return {
          ok: true,
          // The row the click landed on may be the one carrying the widget's
          // marks, so ask both: the listed wrapper and what was actually hit.
          opened: chooser || opensAChooser(hit),
          note: `Clicked [${action.id}] “${cut(labelFor(el), 60)}”`
        };
      }

      case 'click_at': {
        const x = Number(action.x);
        const y = Number(action.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          return { ok: false, error: 'click_at needs numeric x and y from the screenshot.' };
        }
        if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) {
          return {
            ok: false,
            error:
              `(${x}, ${y}) is outside the ${window.innerWidth}×${window.innerHeight} ` +
              'window. Coordinates are the screenshot\'s own, measured from its top-left.'
          };
        }

        showActionAt(x, y, 'Agent clicked');
        const target = clickAtPoint(x, y);
        if (!target) return { ok: false, error: `Nothing is at (${x}, ${y}).` };

        return {
          ok: true,
          opened: opensAChooser(target),
          note: `Clicked at (${x}, ${y}) — “${cut(labelFor(target) || clean(target.textContent), 60)}”`
        };
      }

      case 'type': {
        showAction(el, 'Agent typing', false);
        // A field aimed at by coordinate has not been clicked, and a widget
        // that only wakes up on focus would take the value and drop it.
        if (action.id == null) clickElement(el);
        setValue(el, String(action.text ?? ''));
        if (action.submit) {
          const form = el.form || el.closest('form');
          if (form?.requestSubmit) form.requestSubmit();
          else {
            for (const type of ['keydown', 'keypress', 'keyup']) {
              el.dispatchEvent(
                new KeyboardEvent(type, {
                  key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
                  bubbles: true, cancelable: true
                })
              );
            }
          }
        }
        return {
          ok: true,
          // Typing into a chooser filters a list; it does not choose from it.
          opened: !action.submit && opensAChooser(el),
          // The value first, then where it went. A run that fills six fields
          // produces six of these, and read as a list they are a record of what
          // was actually entered — which is the only form of "did it work" a
          // person can check without redoing the form themselves.
          note:
            `Typed ${shownValue(el, action.text)} into ` +
            `“${cut(fieldName(el) || 'that field', 40)}”` +
            `${action.id != null ? ` [${action.id}]` : ''}` +
            `${action.submit ? ' and submitted' : ''}`
        };
      }

      case 'select': {
        showAction(el, 'Agent choosing', false);
        const wanted = String(action.value ?? '');
        const option = Array.from(el.options || []).find(
          (o) => o.value === wanted || clean(o.textContent) === wanted
        );
        if (!option) {
          return { ok: false, error: `No option “${wanted}” in [${action.id}]` };
        }
        el.value = option.value;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return {
          ok: true,
          note: `Selected “${wanted}” in “${cut(fieldName(el) || `[${action.id}]`, 40)}”`
        };
      }

      /**
       * Put a real file into a file input.
       *
       * The model's instinct here is to type the path, and it is right that
       * this cannot work — `input.value` is read-only for file inputs and no
       * amount of clicking opens the OS picker from script. Left with only
       * those two moves it burns the rest of the run alternating between them
       * and finishes with "the browser cannot programmatically select a local
       * file", which is true and useless: the extension is holding the user's
       * file as bytes the whole time.
       *
       * `DataTransfer` is the route that IS allowed — it is how a drop puts a
       * file into an input — and from a content script it needs no permission
       * the extension does not already have.
       */
      case 'upload': {
        const file = action.file;
        if (!file?.dataUrl) {
          return {
            ok: false,
            error:
              'No file is attached to this run. Ask the user for one with ' +
              '{"action":"ask","question":"…","fields":[{"name":"cv","type":"file"}]} ' +
              'rather than typing a path — a path can never work.'
          };
        }

        /**
         * The listed element is almost never the input itself.
         *
         * A styled uploader is a button or a label with the real
         * `input[type=file]` hidden behind it, so that is what the model can
         * see and therefore what it aims at. Walk from what it picked to the
         * input that actually takes the file: itself, its own label target,
         * something inside it, then the nearest one in the surrounding form.
         */
        const input = fileInputFor(el);
        if (!input) {
          return { ok: false, error: `No file input at or near [${action.id}]` };
        }
        if (input.accept && !acceptsFile(input.accept, file.name, file.type)) {
          return {
            ok: false,
            error: `That input only accepts ${input.accept} — “${file.name}” does not match.`
          };
        }

        showAction(el, 'Agent attaching', false);

        let blob;
        try {
          // atob, not fetch(dataUrl): a content-script fetch is one more thing
          // a strict site can block, and its only symptom is a file that never
          // appears. Same reasoning as the provider-side attachment path.
          const [meta, b64] = String(file.dataUrl).split(',');
          const bin = atob(b64);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          blob = new Blob([bytes], {
            type: file.type || meta.match(/:(.*?);/)?.[1] || 'application/octet-stream'
          });
        } catch {
          return { ok: false, error: 'The attached file could not be decoded.' };
        }

        try {
          const dt = new DataTransfer();
          dt.items.add(new File([blob], file.name || 'upload', { type: blob.type }));
          input.files = dt.files;
        } catch {
          return { ok: false, error: 'The page refused the file.' };
        }

        // Both events, in this order. A plain listener wants `change`; React
        // and Vue bind `input` — firing one leaves half the web showing an
        // input whose `files` is set and whose UI still says "no file chosen".
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));

        return {
          ok: true,
          note: `Attached “${cut(file.name || 'file', 60)}” to “${cut(
            fieldName(input) || fieldName(el) || `[${action.id}]`,
            40
          )}”`
        };
      }

      case 'scroll': {
        const dir = action.direction || 'down';

        /**
         * Scroll what the model is actually looking at.
         *
         * With a dialog open the observation describes the dialog, so a scroll
         * that moves the window moves the one box the model cannot see and
         * leaves the one it is reading exactly where it was. Nothing reports
         * that as a failure either: the action succeeds, the page behind does
         * move, and the next observation is identical — so the model reads it
         * as "there is nothing more here" and stops. Measured on Naukri's
         * apply dialog: the recruiter's question was below the fold of the
         * pane for the whole run, and the run ended saying there were no
         * questions to answer.
         */
        const dialog = modalScope();
        const pane = dialog && scrollableIn(dialog);

        /**
         * Smooth, because this scroll is watched.
         *
         * A jump cut moves the page a screenful between two frames and the eye
         * has to re-find everything; an animated scroll carries the same
         * information and stays legible, which is the entire difference between
         * a run you can follow and one that flickers. It is only the *action*
         * that animates. The deep-read walk in `loadAll` and `AGENT_SCROLL_TO`
         * stay `instant` on purpose: they are measured, they step by exact
         * amounts, and a smooth scroll still in flight when the next
         * measurement is taken reports a position the page has not reached —
         * which is the clamp bug that walk was written to avoid.
         *
         * The step afterwards waits on `settle`, which is what gives this the
         * room to finish without costing the run a decision.
         */
        const glide = wantsLessMotion() ? 'auto' : 'smooth';

        if (pane) {
          if (dir === 'top') pane.scrollTo({ top: 0, behavior: glide });
          else if (dir === 'bottom') pane.scrollTo({ top: pane.scrollHeight, behavior: glide });
          else {
            pane.scrollBy({
              top: (dir === 'up' ? -1 : 1) * pane.clientHeight * 0.85,
              behavior: glide
            });
          }
          return { ok: true, note: `Scrolled ${dir} inside “${dialogLabel(dialog) || 'the dialog'}”` };
        }

        // A dialog with nothing scrollable in it is already whole, and
        // scrolling the document under it is worse than doing nothing: it
        // moves the page the user will come back to and tells the model the
        // position changed when what it is reading did not.
        if (dialog) {
          return {
            ok: false,
            error:
              'The open dialog is not scrollable — all of it is already in the ' +
              'observation. Act on it rather than scrolling.'
          };
        }

        if (dir === 'top') window.scrollTo({ top: 0, behavior: glide });
        else if (dir === 'bottom') {
          window.scrollTo({ top: document.body.scrollHeight, behavior: glide });
        } else {
          window.scrollBy({
            top: (dir === 'up' ? -1 : 1) * window.innerHeight * 0.85,
            behavior: glide
          });
        }
        return { ok: true, note: `Scrolled ${dir}` };
      }

      default:
        return { ok: false, error: `Unknown page action “${action.action}”` };
    }
  }

  /** What a whole-page capture needs to know before it starts. */
  function metrics() {
    const doc = document.documentElement;
    return {
      ok: true,
      scrollY: window.scrollY,
      innerHeight: window.innerHeight,
      innerWidth: window.innerWidth,
      // The document, not the viewport: `body.scrollHeight` misses a page whose
      // scrolling container is the html element, and vice versa.
      scrollHeight: Math.max(
        doc.scrollHeight,
        document.body?.scrollHeight || 0,
        window.innerHeight
      ),
      dpr: window.devicePixelRatio || 1
    };
  }

  /**
   * Walk to the bottom and back, so everything that renders on scroll has.
   *
   * The same rule as the deep read: march the position we *intend* to be at,
   * never "where we are now plus a screenful". A virtualised list re-renders on
   * every scroll event, a re-render that empties its container collapses the
   * scroll height for an instant, the browser clamps the position, and one step
   * lands at the bottom — after which the walk agrees it has finished, having
   * seen the first screenful and the last.
   */
  async function loadAll() {
    const step = Math.max(200, window.innerHeight * 0.9);
    const started = window.scrollY;
    let target = 0;

    for (let pass = 0; pass < 24; pass++) {
      window.scrollTo({ top: target, behavior: 'instant' });
      await new Promise((r) => setTimeout(r, 220));

      const doc = document.documentElement;
      const height = Math.max(doc.scrollHeight, document.body?.scrollHeight || 0);
      if (target + window.innerHeight >= height - 4) break;
      target += step;
    }

    window.scrollTo({ top: started, behavior: 'instant' });
    await new Promise((r) => setTimeout(r, 120));
    return { ok: true, ...metrics() };
  }

  /**
   * A cheap fingerprint of "has this page stopped changing yet".
   *
   * Deliberately avoids innerText and getClientRects — this is polled several
   * times per step, and forcing layout on every poll would cost more than the
   * fixed sleep it replaces.
   */
  function pulse() {
    return {
      ok: true,
      url: location.href,
      ready: document.readyState,
      nodes: document.querySelectorAll('*').length
    };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.target !== 'agent-page') return;

    /**
     * Only the top frame answers a broadcast. Frames answer when addressed.
     *
     * `chrome.tabs.sendMessage(tabId, msg)` with no frameId goes to EVERY frame
     * in the tab, and the promise settles on whichever calls sendResponse
     * first. Once this script is injected into subframes — which it has to be,
     * or a form inside an iframe is invisible to the agent — that turns every
     * observation into a race the ad iframe can win. `frameTargeted` is set by
     * the background only when it also passes an explicit `{frameId}`, so it
     * is belt and braces on top of Chrome's own routing rather than the only
     * thing keeping the two apart.
     */
    if (window.top !== window && !msg.frameTargeted) return;

    try {
      if (msg.type === 'AGENT_PULSE') sendResponse(pulse());
      // observe() is async because a deep read scrolls the page and waits for
      // what that loads, so this branch answers later than the others. The
      // `return true` below already keeps the channel open for it.
      else if (msg.type === 'AGENT_OBSERVE') {
        observe(msg).then(
          (observation) => sendResponse({ ok: true, observation }),
          (err) => sendResponse({ ok: false, error: String(err?.message || err) })
        );
      } else if (msg.type === 'AGENT_METRICS') sendResponse(metrics());
      else if (msg.type === 'AGENT_SCROLL_TO') {
        window.scrollTo({ top: Number(msg.y) || 0, behavior: 'instant' });
        sendResponse({ ok: true, scrollY: window.scrollY });
      } else if (msg.type === 'AGENT_LOAD_ALL') {
        loadAll().then(sendResponse, () => sendResponse({ ok: false }));
        return true;
      } else if (msg.type === 'AGENT_PLAN') sendResponse(plan(msg.action));
      else if (msg.type === 'AGENT_ACT') sendResponse(act(msg.action));
      else if (msg.type === 'AGENT_FLASH') {
        // Sent AFTER the capture, never before: the model is supposed to be
        // looking at the page, not at our overlay lying on top of it.
        showFlash();
        sendResponse({ ok: true });
      } else if (msg.type === 'AGENT_SHOT') {
        // The shutter and the print, in that order — the flash is what makes
        // the card read as the result of it rather than as a notification.
        showFlash();
        setTimeout(() => showShot(msg.image, msg.label), 150);
        sendResponse({ ok: true });
      } else if (msg.type === 'AGENT_NOTES') {
        // Sent once, after the planning turn. Replaced rather than appended:
        // they describe the page that was surveyed, and a run that navigates
        // gets a new set or none.
        notes = Array.isArray(msg.notes) ? msg.notes.filter((n) => typeof n === 'string') : [];
        // Back to the start: the warm-up lines and the real notes are two
        // different lists, and carrying an index across them would open on
        // note four of twenty for no reason.
        noteAt = 0;
        sendResponse({ ok: true, notes: notes.length });
      } else if (msg.type === 'AGENT_ASKING') {
        asking = Boolean(msg.on);
        // The line is the mark you can see from anywhere on the page, so the
        // state change belongs there as much as in the bubble beside the
        // pointer — which is only visible if you happen to be looking at it.
        curtain?.querySelector('.topline')?.classList.toggle('asking', asking);
        if (asking) {
          /**
           * Never the same line twice running.
           *
           * A fixed sentence is read once and skipped forever after, which is
           * how a prompt becomes furniture. Re-rolling on a repeat costs
           * nothing and keeps it a thing someone actually reads.
           */
          let pick = Math.floor(Math.random() * ASK_LINES.length);
          if (pick === lastAsk) pick = (pick + 1) % ASK_LINES.length;
          lastAsk = pick;
          if (sayingTimer) clearTimeout(sayingTimer);
          say(ASK_LINES[pick], 'asking');
        } else {
          hush();
        }
        sendResponse({ ok: true });
      } else if (msg.type === 'AGENT_PANEL') {
        showPanelMark(msg.on);
        sendResponse({ ok: true });
      } else if (msg.type === 'AGENT_CONTROL') {
        if (msg.on) takeControl();
        else releaseControl();
        sendResponse({ ok: true });
      } else if (msg.type === 'AGENT_OVERLAY') {
        // Everything we draw, hidden for the length of a screenshot. The
        // curtain stays *installed* — its listeners keep blocking — it just
        // stops being in the photograph the model is about to be shown.
        const root = document.getElementById(OVERLAY_ID);
        if (root) root.style.display = msg.visible === false ? 'none' : '';
        sendResponse({ ok: true });
      } else sendResponse({ ok: false, error: 'Unknown agent message' });
    } catch (err) {
      sendResponse({ ok: false, error: String(err?.message || err) });
    }
    return true;
  });
})();
