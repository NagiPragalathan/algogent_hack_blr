/**
 * Runs on every page. Stays completely idle until the side panel asks for the
 * page's readable content, then returns a compact, model-friendly extract.
 */

(() => {
  if (window.__sidebarAIContextLoaded) return;
  window.__sidebarAIContextLoaded = true;

  /** Whole subtrees that are never page content. */
  const STRIP = [
    'script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe',
    'video', 'audio', 'object', 'embed',
    'nav', 'header', 'footer', 'aside', 'form', 'button', 'select', 'textarea',
    '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]',
    '[role="complementary"]', '[role="search"]', '[role="tablist"]',
    '[aria-hidden="true"]', '[hidden]',
    '.nav', '.navbar', '.menu', '.sidebar', '.footer', '.header',
    '.advert', '.ads', '.ad', '.cookie', '.newsletter', '.social-share',
    '.comments', '#comments', '.related-posts', '.breadcrumb'
  ].join(',');

  /**
   * Tags that start a new line of output. Everything else is inline and folds
   * into its nearest block ancestor's line.
   *
   * This distinction is the whole extractor. Reading only <p>, <li> and <h*>
   * throws away every card, grid and hero section on a modern page, because
   * those hold their text in <div>, <span> and <a> — which is how a
   * content-dense page comes back as three headings with nothing under them.
   */
  const BLOCK = new Set([
    'address', 'article', 'aside', 'blockquote', 'caption', 'dd', 'details',
    'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'li', 'main',
    'nav', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'tbody', 'td',
    'tfoot', 'th', 'thead', 'tr', 'ul'
  ]);

  /** Stop rather than hang a tab on a pathological DOM. */
  const NODE_BUDGET = 25000;

  /** Longest list item still worth folding onto one line. */
  const LIST_ITEM_CHARS = 400;

  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

  function skip(el) {
    // Cheapest test first: nothing to say, nothing to walk.
    if (!el.textContent || !el.textContent.trim()) return true;
    try {
      if (el.matches(STRIP)) return true;
    } catch {
      /* selector engine choked on an exotic element — keep the content */
    }
    // Collapsed accordions, inactive tab panes, off-canvas menus. Opacity is
    // deliberately not checked: fade-in animations would drop real content.
    if (
      el.checkVisibility &&
      !el.checkVisibility({ contentVisibilityAuto: true, visibilityProperty: true })
    ) {
      return true;
    }
    return false;
  }

  /**
   * Text belonging to this element itself — its own text nodes plus any inline
   * descendants, but not the text of nested blocks, which get their own lines.
   */
  function ownText(el) {
    let out = '';
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        out += node.textContent;
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const tag = node.tagName.toLowerCase();
        if (BLOCK.has(tag)) continue;
        if (skip(node)) continue;
        // An <a> wrapping a whole card is inline by this rule, so the card
        // arrives as one readable line instead of vanishing.
        out += node.innerText || node.textContent || '';
      }
    }
    return clean(out);
  }

  function walk(el, out, budget) {
    if (budget.visited++ > NODE_BUDGET) return;

    const tag = el.tagName.toLowerCase();

    if (tag === 'pre') {
      const raw = (el.innerText || el.textContent || '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      if (raw) out.push('```\n' + raw + '\n```');
      return;
    }

    if (/^h[1-6]$/.test(tag)) {
      const text = clean(el.innerText || el.textContent);
      if (text) out.push('\n' + '#'.repeat(Number(tag[1])) + ' ' + text);
      return;
    }

    /**
     * A list item is one thing, so it gets one line — the same reason a table row
     * does, and it matters more here.
     *
     * A job card split over four lines ("Python Developer", "Appglide Solutions",
     * "Chennai…", "Promoted · Easy Apply") loses which company the Easy Apply
     * belonged to. Worse, the label lines are identical across every card, so the
     * duplicate-line collapse below reduces twenty-five cards to one "Easy Apply"
     * — which is how "list every Easy Apply job here" gets answered with two.
     * One line per item is unique per item, so nothing collapses.
     *
     * An item long enough to be an article rather than a card falls through to
     * the ordinary walk, where its structure is worth keeping.
     */
    if (tag === 'li' || el.getAttribute('role') === 'listitem') {
      const text = clean(el.innerText || el.textContent);
      if (text && text.length <= LIST_ITEM_CHARS) {
        out.push('- ' + text);
        return;
      }
    }

    // Keep a table row on one line — a cell per line loses the association
    // between a value and the row it belongs to.
    if (tag === 'tr') {
      const cells = [];
      for (const cell of el.children) {
        if (skip(cell)) continue;
        const text = clean(cell.innerText || cell.textContent);
        if (text) cells.push(text);
      }
      if (cells.length) out.push('| ' + cells.join(' | ') + ' |');
      return;
    }

    const own = ownText(el);
    if (own) {
      if (tag === 'li') out.push('- ' + own);
      else if (tag === 'blockquote') out.push('> ' + own);
      else if (tag === 'td' || tag === 'th') out.push('| ' + own);
      else out.push(own);
    }

    for (const child of el.children) {
      if (!BLOCK.has(child.tagName.toLowerCase())) continue;
      if (skip(child)) continue;
      walk(child, out, budget);
    }
  }

  /** Collapse the duplicate lines boilerplate templates love to repeat. */
  function dedupe(lines) {
    const seen = new Set();
    return lines.filter((line) => {
      const key = line.trim();
      if (key.length < 12) return true;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function textLength(el) {
    return clean(el.innerText || '').length;
  }

  /** Share of an element's text that is link labels — a nav block scores ~1. */
  function linkDensity(el) {
    const total = textLength(el);
    if (!total) return 1;
    let links = 0;
    for (const a of el.querySelectorAll('a')) links += clean(a.innerText || '').length;
    return Math.min(1, links / total);
  }

  /**
   * Best content root. Scoring by prose volume rather than taking the first
   * candidate that clears a size bar matters on sites where `#content` or
   * `.content` wraps the navigation as well as the article.
   */
  function pickRoot() {
    const candidates = [
      'article', 'main', '[role="main"]', '#content', '#main',
      '.post-content', '.article-content', '.entry-content',
      '.markdown-body', '.content'
    ];

    let best = null;
    let bestScore = 0;

    for (const selector of candidates) {
      let matches;
      try {
        matches = document.querySelectorAll(selector);
      } catch {
        continue;
      }
      for (const el of matches) {
        const score = textLength(el) * (1 - linkDensity(el));
        if (score > bestScore) {
          bestScore = score;
          best = el;
        }
      }
    }

    // A candidate only wins if it is genuinely carrying prose. Otherwise the
    // body is the safer root — the strip list already keeps chrome out.
    return bestScore > 400 && best ? best : document.body;
  }

  /** The visible label a person would read next to a control. */
  function controlLabel(el) {
    const aria = el.getAttribute('aria-label');
    if (aria) return clean(aria);
    if (el.id) {
      try {
        const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (label?.innerText) return clean(label.innerText);
      } catch {
        /* exotic id */
      }
    }
    const wrapping = el.closest('label');
    if (wrapping?.innerText) return clean(wrapping.innerText);
    return clean(el.getAttribute('placeholder') || el.getAttribute('name') || '');
  }

  /**
   * A compact description of what is fillable on the page.
   *
   * Form controls are stripped from the prose above — a bare "Submit" in the
   * middle of an article is noise. But their *structure* is exactly what a
   * question like "what does this form want from me?" turns on, so it goes back
   * in as its own section rather than being lost.
   */
  function describeForms() {
    const groups = new Map();

    const controls = document.querySelectorAll(
      'input:not([type="hidden"]), select, textarea, button, [role="textbox"]'
    );

    for (const el of controls) {
      if (el.checkVisibility && !el.checkVisibility({ visibilityProperty: true })) continue;
      if (!el.getClientRects().length) continue;

      const form = el.closest('form');
      const key = form || 'page';
      if (!groups.has(key)) groups.set(key, []);
      const fields = groups.get(key);
      if (fields.length >= 30) continue;

      const tag = el.tagName.toLowerCase();
      const label = controlLabel(el);

      if (tag === 'button' || (tag === 'input' && /^(submit|button)$/.test(el.type))) {
        const text = clean(el.innerText || el.value || label);
        if (text) fields.push(`- button "${text}"`);
        continue;
      }

      const bits = [`- ${tag === 'input' ? `input type=${el.type || 'text'}` : tag}`];
      if (label) bits.push(`label="${label}"`);
      if (el.required) bits.push('required');
      if (el.value) bits.push(`current="${clean(el.value).slice(0, 40)}"`);
      if (tag === 'select') {
        const options = Array.from(el.options || [])
          .slice(0, 12)
          .map((o) => clean(o.textContent))
          .filter(Boolean);
        if (options.length) bits.push(`options=[${options.join(' | ')}]`);
      }
      fields.push(bits.join(' '));
    }

    const blocks = [];
    for (const [form, fields] of groups) {
      if (!fields.length) continue;
      if (blocks.length >= 8) break;
      const name =
        form === 'page'
          ? 'Controls not inside a form'
          : `Form${form.name ? ` "${form.name}"` : ''}${form.action ? ` (action=${form.action})` : ''}`;
      blocks.push(`${name}:\n${fields.join('\n')}`);
    }

    return blocks.join('\n\n');
  }

  /**
   * The raw rendered text, as a safety net.
   *
   * If the structured pass came back thin next to what is plainly on screen, the
   * page's layout beat our heuristics — a canvas app, a shadow DOM, an unusual
   * framework. innerText is noisier but complete, and complete is what the model
   * actually needs.
   */
  function rawFallback(body) {
    const raw = (document.body.innerText || '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    const beaten = body.length < 400 || body.length < raw.length * 0.35;
    return raw.length > body.length && beaten ? raw : body;
  }

  /** One place builds the context object, however the text was gathered. */
  function finish(body, { maxChars, passes }) {
    const selection = (window.getSelection?.().toString() || '').trim();

    let text = body;
    let truncated = false;
    if (text.length > maxChars) {
      text = text.slice(0, maxChars);
      truncated = true;
    }

    const meta =
      document.querySelector('meta[name="description"]')?.content ||
      document.querySelector('meta[property="og:description"]')?.content ||
      '';

    return {
      url: location.href,
      title: document.title || location.hostname,
      siteName:
        document.querySelector('meta[property="og:site_name"]')?.content ||
        location.hostname,
      description: meta.trim().slice(0, 400),
      selection: selection.slice(0, maxChars),
      hasSelection: selection.length > 0,
      forms: describeForms().slice(0, 4000),
      text,
      truncated,
      charCount: text.length,
      passes,
      extractedAt: Date.now()
    };
  }

  function extract(maxChars) {
    const lines = [];
    walk(pickRoot(), lines, { visited: 0 });
    const body = dedupe(lines).join('\n').replace(/\n{3,}/g, '\n\n').trim();

    return finish(rawFallback(body), { maxChars, passes: 1 });
  }

  // ------------------------------------------------------ deep page reading ---

  /**
   * Reading a page that only renders what you have scrolled past.
   *
   * A single DOM read is the whole page only on a document. On a feed, a search
   * result page or any virtualised list it is *the first screenful*, because the
   * rest either has not been fetched yet or has been recycled out of the DOM
   * entirely — which is how a LinkedIn jobs page with twenty-five results comes
   * back as three thousand characters and two Easy Apply jobs, and the model
   * then confidently answers with the two it was given.
   *
   * So: scroll it, top to bottom, harvesting after every step and merging by
   * line. Bounded three ways — passes, wall clock, and two consecutive
   * harvests that add nothing — because a page with an infinite feed has no
   * bottom to reach and we are spending the user's time on their own tab.
   */
  // A pass covers 0.8 of a screenful, so 16 was barely thirteen screens — short
  // for a result list, and it bound before the wall clock did on exactly the
  // pages this is for. The budget below is the honest limit; this is the
  // runaway guard behind it.
  const DEEP_MAX_PASSES = 30;
  const DEEP_BUDGET_MS = 7000;
  const LAZY_SETTLE_MS = 260;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * Everything on the page that scrolls on its own.
   *
   * The document is not always the thing that moves: app layouts put the list in
   * an `overflow-y:auto` pane with the window itself locked, so scrolling the
   * window alone reveals nothing at all.
   */
  function scrollers() {
    const found = [];
    const doc = document.scrollingElement || document.documentElement;

    if (doc.scrollHeight > doc.clientHeight + 100) found.push(doc);

    for (const el of document.querySelectorAll('div, ul, ol, section, main, aside')) {
      if (found.length >= 5) break;
      if (el.scrollHeight <= el.clientHeight + 100) continue;

      const rect = el.getBoundingClientRect();
      if (rect.width < 200 || rect.height < 200) continue;
      if (!/(auto|scroll|overlay)/.test(getComputedStyle(el).overflowY)) continue;

      found.push(el);
    }

    return found;
  }

  /**
   * Advance one pane by a screenful. False when it has nothing left to show.
   *
   * Driven by an absolute target we keep ourselves, never by "wherever the pane
   * is now, plus a screenful". A virtualised list re-renders on every scroll
   * event, and a re-render that empties its container for an instant collapses
   * the scroll height — the browser clamps the position, that fires another
   * scroll, and the pane can land at the bottom from a single step. Reading the
   * position back and continuing from it then means the walk agrees it is
   * finished, two passes in, having harvested the first screenful and the last
   * and nothing in between. Measured on exactly that list: jobs 1-8 and 19-25,
   * with 9-18 silently missing.
   *
   * Marching our own target instead makes the walk independent of what the page
   * does to the scrollbar: whatever it moved, the next pass asks for the place
   * we had always intended to read.
   */
  function stepDown(el, targets) {
    const max = Math.max(0, el.scrollHeight - el.clientHeight);
    const from = targets.has(el) ? targets.get(el) : el.scrollTop;

    if (from >= max - 4) return false;

    const next = Math.min(from + el.clientHeight * 0.8, max);
    targets.set(el, next);
    el.scrollTop = next;
    return true;
  }

  /**
   * Give whatever the scroll triggered a chance to render — and a second chance
   * if the DOM was still growing when the first wait ended, which is the
   * difference between catching a lazily-loaded batch and reading the skeleton
   * placeholders it replaced.
   */
  async function settleForLazyContent() {
    const before = document.querySelectorAll('*').length;
    await sleep(LAZY_SETTLE_MS);
    if (document.querySelectorAll('*').length !== before) await sleep(LAZY_SETTLE_MS);
  }

  async function deepExtract({ maxChars = 12000, budgetMs = DEEP_BUDGET_MS } = {}) {
    const deadline = Date.now() + budgetMs;

    /** Where every pane we touched was before we touched it. */
    const origins = new Map();

    /** Where each pane is meant to be next. See stepDown for why we keep it. */
    const marks = new Map();

    /** Lines already collected, so a pass only contributes what is new. */
    const seen = new Set();
    const lines = [];

    /**
     * Which panes to scroll, re-asked every pass.
     *
     * Asked once, this misses the pane that matters: a list holding its first
     * five cards is not yet taller than its own box, so it does not look
     * scrollable, and it never becomes scrollable because nothing ever scrolls it
     * — a deadlock that leaves a twenty-five item feed reading as five. Panes
     * also appear and grow as content loads.
     */
    const targets = () => {
      const found = scrollers();
      for (const el of found) if (!origins.has(el)) origins.set(el, el.scrollTop);
      return found;
    };

    /**
     * The body, not `pickRoot()`.
     *
     * pickRoot returns the densest prose on the page, which on an app layout is
     * one pane of several — the job description, and not the list of jobs beside
     * it. That is the whole of what the model was being given for a jobs page:
     * the article, none of the list. STRIP already keeps the chrome out, so the
     * body is both complete and clean enough.
     */
    const harvest = () => {
      const pass = [];
      walk(document.body, pass, { visited: 0 });

      let added = 0;
      for (const line of pass) {
        const key = line.trim();
        if (!key) continue;

        // Passes overlap by design, so the same content is walked repeatedly.
        // Items now arrive one line each and are unique per item, which is what
        // makes deduplicating by line safe here.
        if (key.length >= 8) {
          if (seen.has(key)) continue;
          seen.add(key);
        }

        lines.push(line);
        added += 1;
      }

      return added;
    };

    let passes = 0;
    let quiet = 0;

    try {
      harvest();
      passes = 1;

      while (passes < DEEP_MAX_PASSES && quiet < 2) {
        if (Date.now() > deadline) break;

        const panes = targets();
        if (!panes.length) break;
        if (!panes.map((el) => stepDown(el, marks)).some(Boolean)) break;

        await settleForLazyContent();

        // Put each pane back on its mark before reading it. The re-render the
        // step triggered may have moved it — see stepDown — and harvesting
        // wherever it happens to have landed is how a screenful goes unread.
        for (const el of panes) {
          const wanted = marks.get(el);
          if (wanted == null || Math.abs(el.scrollTop - wanted) <= 8) continue;
          el.scrollTop = wanted;
          await sleep(LAZY_SETTLE_MS);
        }

        const added = harvest();
        passes += 1;
        quiet = added ? 0 : quiet + 1;
      }
    } finally {
      // Put the page back where the user left it. Reading their tab is one
      // thing; leaving it scrolled somewhere they did not choose is another.
      for (const [el, top] of origins) el.scrollTop = top;
    }

    const body = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    return finish(rawFallback(body), { maxChars, passes });
  }

  // The agent content script shares this isolated world and needs the same
  // reader; exposing it beats shipping a second, worse extractor alongside.
  // The deep one matters more there than here: the agent's observation is the
  // only thing it knows about a page, so a feed read at one screenful is an
  // agent that confidently acts on two of twenty-five items.
  window.__sidebarAIExtract = extract;
  window.__sidebarAIDeepExtract = deepExtract;

  // ---------------------------------------------------------- element pick ---

  /**
   * Let the user point at the part of the page they mean.
   *
   * Whole-page context is a blunt instrument: on a dense app the one table or
   * card the question is about is a rounding error in six thousand characters.
   * Picking is the precise alternative, and it needs no heuristics at all —
   * the user already knows which element they mean.
   */
  let picking = null;

  function stopPicking(result) {
    if (!picking) return;
    const { overlay, onMove, onClick, onKey, resolve } = picking;
    picking = null;
    overlay.remove();
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey, true);
    resolve(result);
  }

  function startPicking() {
    if (picking) stopPicking({ ok: false, cancelled: true });

    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.style.cssText =
        'position:fixed;inset:0;z-index:2147483647;pointer-events:none;' +
        'box-shadow:inset 0 0 0 2px rgba(80,140,255,.9);';

      const box = document.createElement('div');
      box.style.cssText =
        'position:fixed;pointer-events:none;background:rgba(80,140,255,.18);' +
        'outline:2px solid rgba(80,140,255,.95);border-radius:3px;transition:all .04s;';
      overlay.append(box);

      const tip = document.createElement('div');
      tip.style.cssText =
        'position:fixed;left:50%;top:12px;transform:translateX(-50%);' +
        'background:#111;color:#fff;font:13px system-ui;padding:6px 12px;' +
        'border-radius:999px;pointer-events:none;';
      tip.textContent = 'Click the part you want to send · Esc to cancel';
      overlay.append(tip);

      document.documentElement.append(overlay);

      let current = null;

      const onMove = (e) => {
        // The overlay must not eat the hit test, hence pointer-events:none.
        const el = document.elementFromPoint(e.clientX, e.clientY);
        if (!el || el === current) return;
        current = el;
        const r = el.getBoundingClientRect();
        Object.assign(box.style, {
          left: r.left + 'px',
          top: r.top + 'px',
          width: r.width + 'px',
          height: r.height + 'px'
        });
      };

      const onClick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const el = current || document.elementFromPoint(e.clientX, e.clientY);
        if (!el) return stopPicking({ ok: false, cancelled: true });

        const lines = [];
        walk(el, lines, { visited: 0 });
        const text = dedupe(lines).join('\n').replace(/\n{3,}/g, '\n\n').trim();

        stopPicking({
          ok: true,
          label: clean(el.innerText || el.tagName).slice(0, 60),
          text: (text || clean(el.innerText || '')).slice(0, 20000),
          url: location.href,
          title: document.title
        });
      };

      const onKey = (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          stopPicking({ ok: false, cancelled: true });
        }
      };

      picking = { overlay, onMove, onClick, onKey, resolve };
      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('click', onClick, true);
      document.addEventListener('keydown', onKey, true);
    });
  }

  // ----------------------------------------------------------- region pick ---

  /**
   * Drag a box, send the picture inside it.
   *
   * The element picker sends what the page *says*; this sends what it *looks
   * like*, and the two answer different questions. A chart, a diagram, a
   * screenshot embedded in a doc, a layout that has gone wrong — none of those
   * have text worth extracting, and asking about them from the DOM produces a
   * confident answer about markup nobody was looking at.
   *
   * The rectangle comes back in CSS pixels relative to the viewport, because
   * that is the coordinate space `captureVisibleTab` photographs; the crop
   * itself happens in the worker, where the image actually is.
   */
  let dragging = null;

  function stopDragging(result) {
    if (!dragging) return;
    const { overlay, handlers, resolve } = dragging;
    dragging = null;
    overlay.remove();
    for (const [type, fn] of handlers) document.removeEventListener(type, fn, true);
    resolve(result);
  }

  function startRegionPick() {
    if (dragging) stopDragging({ ok: false, cancelled: true });

    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      // `pointer-events:auto` here, unlike the element picker: this one wants
      // the drag itself, not what is underneath it.
      overlay.style.cssText =
        'position:fixed;inset:0;z-index:2147483647;cursor:crosshair;' +
        'background:rgba(9,12,20,.42);';

      /**
       * Everything the tool draws, in one stylesheet rather than inline.
       *
       * A `<style>` in the overlay is scoped by the class prefix and lets the
       * selection have states — the handles, the marching outline, the pulse on
       * release — none of which fit in a cssText string that has to be rewritten
       * on every pointermove.
       */
      const style = document.createElement('style');
      style.textContent = `
        .sbai-box {
          position: fixed; display: none;
          border: 1.5px solid rgba(126,175,255,.98);
          border-radius: 3px;
          /* The punch-out: everything outside the selection stays dimmed, so
             the part you are choosing is the only bright thing on screen. */
          box-shadow: 0 0 0 9999px rgba(9,12,20,.42),
                      inset 0 0 0 1px rgba(255,255,255,.85),
                      0 0 26px rgba(90,150,255,.45);
          background: transparent;
        }
        .sbai-h {
          position: fixed; width: 9px; height: 9px;
          border-radius: 2px;
          background: #fff;
          box-shadow: 0 0 0 1.5px rgba(90,150,255,.95), 0 1px 4px rgba(0,0,0,.4);
          display: none;
        }
        .sbai-cross {
          position: fixed; background: rgba(126,175,255,.5); pointer-events: none;
        }
        .sbai-size {
          position: fixed; display: none;
          background: rgba(12,16,26,.94); color: #fff;
          font: 11px/1 ui-monospace, Menlo, Consolas, monospace;
          letter-spacing: .02em;
          padding: 5px 8px; border-radius: 7px;
          box-shadow: 0 6px 18px rgba(0,0,0,.4);
          pointer-events: none; white-space: nowrap;
        }
        .sbai-tip {
          position: fixed; left: 50%; top: 16px; transform: translateX(-50%);
          display: flex; align-items: center; gap: 9px;
          background: rgba(12,16,26,.94); color: #fff;
          font: 13px/1 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
          padding: 10px 14px; border-radius: 999px;
          box-shadow: 0 10px 30px rgba(0,0,0,.45);
          pointer-events: none;
          animation: sbai-tip-in 280ms cubic-bezier(.16,1,.3,1);
        }
        @keyframes sbai-tip-in { from { opacity: 0; transform: translate(-50%, -10px); } }
        .sbai-key {
          font: 11px/1 ui-monospace, Menlo, Consolas, monospace;
          border: 1px solid rgba(255,255,255,.3); border-radius: 5px;
          padding: 3px 6px; opacity: .85;
        }
        /* The selection taking, on release: it flashes and settles rather than
           just vanishing, so a drag that worked looks different from one that
           was too small to count. */
        .sbai-box.sbai-taken {
          animation: sbai-take 220ms cubic-bezier(.16,1,.3,1) forwards;
        }
        @keyframes sbai-take {
          0%   { background: rgba(255,255,255,0); }
          35%  { background: rgba(255,255,255,.5); }
          100% { background: rgba(255,255,255,0); transform: scale(.985); }
        }
        @media (prefers-reduced-motion: reduce) {
          .sbai-tip, .sbai-box.sbai-taken { animation-duration: 1ms; }
        }
      `;
      overlay.append(style);

      const box = document.createElement('div');
      box.className = 'sbai-box';
      overlay.append(box);

      // Four corner handles. They do nothing — the drag is the whole gesture —
      // but they are what makes a rectangle read as a selection you made rather
      // than as a box that appeared.
      const handles = ['nw', 'ne', 'sw', 'se'].map(() => {
        const h = document.createElement('div');
        h.className = 'sbai-h';
        overlay.append(h);
        return h;
      });

      // Crosshair guides before the drag starts: on a busy page the cursor
      // alone does not tell you what your top-left corner will line up with.
      const vLine = document.createElement('div');
      vLine.className = 'sbai-cross';
      vLine.style.cssText += 'top:0;bottom:0;width:1px;';
      const hLine = document.createElement('div');
      hLine.className = 'sbai-cross';
      hLine.style.cssText += 'left:0;right:0;height:1px;';
      overlay.append(vLine, hLine);

      const size = document.createElement('div');
      size.className = 'sbai-size';
      overlay.append(size);

      const tip = document.createElement('div');
      tip.className = 'sbai-tip';
      const tipText = document.createElement('span');
      tipText.textContent = 'Drag over the part you want to send';
      const esc = document.createElement('span');
      esc.className = 'sbai-key';
      esc.textContent = 'Esc';
      const escText = document.createElement('span');
      escText.textContent = 'to cancel';
      escText.style.opacity = '.7';
      tip.append(tipText, esc, escText);
      overlay.append(tip);

      document.documentElement.append(overlay);

      let from = null;

      const rectOf = (a, b) => ({
        x: Math.min(a.x, b.x),
        y: Math.min(a.y, b.y),
        width: Math.abs(a.x - b.x),
        height: Math.abs(a.y - b.y)
      });

      const draw = (r) => {
        Object.assign(box.style, {
          display: 'block',
          left: r.x + 'px',
          top: r.y + 'px',
          width: r.width + 'px',
          height: r.height + 'px'
        });

        const corners = [
          [r.x, r.y],
          [r.x + r.width, r.y],
          [r.x, r.y + r.height],
          [r.x + r.width, r.y + r.height]
        ];
        handles.forEach((h, i) => {
          h.style.display = 'block';
          h.style.left = corners[i][0] - 5 + 'px';
          h.style.top = corners[i][1] - 5 + 'px';
        });

        // Above the selection, unless it is against the top of the window.
        const above = r.y > 30;
        Object.assign(size.style, {
          display: 'block',
          left: r.x + 'px',
          top: (above ? r.y - 26 : r.y + r.height + 8) + 'px'
        });
        size.textContent = `${Math.round(r.width)} × ${Math.round(r.height)}`;
      };

      const onDown = (e) => {
        e.preventDefault();
        e.stopPropagation();
        from = { x: e.clientX, y: e.clientY };
        tip.style.display = 'none';
        vLine.style.display = 'none';
        hLine.style.display = 'none';
      };

      const onMove = (e) => {
        if (!from) {
          // Idle: the guides track the cursor.
          vLine.style.left = e.clientX + 'px';
          hLine.style.top = e.clientY + 'px';
          return;
        }
        e.preventDefault();
        draw(rectOf(from, { x: e.clientX, y: e.clientY }));
      };

      const onUp = (e) => {
        if (!from) return;
        e.preventDefault();
        e.stopPropagation();
        const r = rectOf(from, { x: e.clientX, y: e.clientY });
        from = null;

        // A click rather than a drag. Cancelling beats sending a 3px picture.
        if (r.width < 8 || r.height < 8) {
          tip.style.display = '';
          vLine.style.display = '';
          hLine.style.display = '';
          box.style.display = 'none';
          size.style.display = 'none';
          for (const h of handles) h.style.display = 'none';
          return;
        }

        // Let the take animation play before the overlay goes. 200ms is under
        // the time the worker needs to focus the tab and photograph it, so this
        // costs nothing in practice.
        box.classList.add('sbai-taken');
        size.style.display = 'none';
        for (const h of handles) h.style.display = 'none';

        setTimeout(
          () =>
            stopDragging({
              ok: true,
              rect: r,
              dpr: window.devicePixelRatio || 1,
              url: location.href,
              title: document.title
            }),
          200
        );
      };

      const onKey = (e) => {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        stopDragging({ ok: false, cancelled: true });
      };

      const handlers = [
        ['pointerdown', onDown],
        ['pointermove', onMove],
        ['pointerup', onUp],
        ['keydown', onKey]
      ];
      dragging = { overlay, handlers, resolve };
      for (const [type, fn] of handlers) document.addEventListener(type, fn, true);
    });
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    /**
     * Only the top frame answers a broadcast. The twin of the guard in
     * agent-page.js, and this file went without one for far too long.
     *
     * `chrome.tabs.sendMessage(tabId, msg)` with no frameId goes to EVERY frame
     * in the tab and settles on whoever calls sendResponse first. This script is
     * declared on the top frame only — which is why it looked safe — but
     * `reachFrames` injects it into every subframe the moment an agent run
     * starts, because the agent needs to see a form inside an iframe. From then
     * on, for the life of that tab, every EXTRACT_CONTEXT is a race that any
     * frame can win.
     *
     * Measured on a LinkedIn run: the context chip read
     * *Sharing "reCAPTCHA" — www.google.com · 12,000 chars*, on a tab showing
     * LinkedIn Jobs. A Google reCAPTCHA iframe had answered first, so the page
     * "shared" with the model was an invisible challenge widget from another
     * origin — and nothing anywhere said so except the chip, which names the
     * document it read and was therefore the only clue.
     *
     * Nothing sends EXTRACT_CONTEXT to a specific frame, so "top frame only" is
     * exactly the whole of what the chat path wants. The pickers are covered by
     * the same line and want the same thing: they draw an overlay across the
     * viewport, which is the top frame's to draw.
     */
    if (window.top !== window && !msg?.frameTargeted) return;

    if (msg?.type === 'PICK_ELEMENT') {
      startPicking().then(sendResponse, (err) =>
        sendResponse({ ok: false, error: String(err?.message || err) })
      );
      return true;
    }

    if (msg?.type === 'PICK_REGION') {
      startRegionPick().then(sendResponse, (err) =>
        sendResponse({ ok: false, error: String(err?.message || err) })
      );
      return true;
    }

    if (msg?.type !== 'EXTRACT_CONTEXT') return;

    const maxChars = msg.maxChars || 6000;

    // Deep reads scroll the page, so they are asked for explicitly — the panel
    // uses a plain read for the chip it shows while you type, and a deep one for
    // the question it actually sends.
    if (msg.deep) {
      deepExtract({ maxChars, budgetMs: msg.budgetMs }).then(
        (context) => sendResponse({ ok: true, context }),
        (err) => sendResponse({ ok: false, error: String(err?.message || err) })
      );
      return true;
    }

    try {
      sendResponse({ ok: true, context: extract(maxChars) });
    } catch (err) {
      sendResponse({ ok: false, error: String(err?.message || err) });
    }
    return true;
  });

  /* ---------------------------------------------------------- selection --- */

  /**
   * Tell the panel what you just highlighted.
   *
   * Highlighting something and then asking about it is the commonest thing
   * anyone does with an assistant beside a page, and until now it cost a trip
   * through the + menu and a click on the exact words again. The selection is
   * reported as it happens, so by the time you turn to the panel it is already
   * attached.
   *
   * `selectionchange` fires on every character as you drag, so this is
   * debounced and deduplicated: what matters is where the drag ENDED. Below the
   * minimum it is treated as noise — a double-click that caught one word is
   * usually someone reading, not someone asking.
   */
  const SELECTION_DEBOUNCE_MS = 320;
  const MIN_SELECTION = 8;
  const MAX_SELECTION = 8000;

  let selectionTimer = null;
  let lastReported = '';

  function reportSelection() {
    const raw = (window.getSelection?.().toString() || '').trim();
    const text = raw.length >= MIN_SELECTION ? raw.slice(0, MAX_SELECTION) : '';

    // Only on change: a click that clears a selection reports once, and then
    // scrolling or typing on the same page says nothing at all.
    if (text === lastReported) return;
    lastReported = text;

    try {
      chrome.runtime.sendMessage({
        type: 'PAGE_SELECTION',
        text,
        url: location.href,
        title: document.title
      });
    } catch {
      /* the worker is asleep or the extension reloaded — nothing to recover */
    }
  }

  document.addEventListener(
    'selectionchange',
    () => {
      clearTimeout(selectionTimer);
      selectionTimer = setTimeout(reportSelection, SELECTION_DEBOUNCE_MS);
    },
    { passive: true }
  );
})();
