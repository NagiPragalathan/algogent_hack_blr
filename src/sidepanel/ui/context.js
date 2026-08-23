import { els } from '../core/dom.js';
import { state } from '../core/state.js';
import { send } from '../core/port.js';

/**
 * The bar that says which page is being shared.
 *
 * It is the only honest answer to "what is this thing sending?", so it names
 * the page, the size and every modifier — a selection, extra tabs, truncation —
 * rather than a reassuring green tick.
 */

let contextRequestId = 0;

export function refreshContext() {
  contextRequestId += 1;
  els.ctxTitle.textContent = 'Reading page…';
  els.ctxMeta.textContent = '';
  send({
    type: 'GET_CONTEXT',
    requestId: contextRequestId,
    // An empty list means "whatever tab the user is looking at".
    tabIds: state.contextTabs.map((t) => t.id)
  });
}

export function faviconFor(url) {
  // Chrome's own favicon cache — no network request, no tracking.
  try {
    const target = new URL(chrome.runtime.getURL('/_favicon/'));
    target.searchParams.set('pageUrl', url);
    target.searchParams.set('size', '32');
    return target.href;
  } catch {
    return '';
  }
}

export function paintContext(result) {
  if (!result.ok) {
    state.pageContext = null;
    els.ctxTitle.textContent = 'Page unavailable';
    els.ctxMeta.textContent = result.error || '';
    els.ctxFavicon.style.backgroundImage = '';
    return;
  }

  const ctx = result.context;
  state.pageContext = ctx;
  els.ctxTitle.textContent = `Sharing “${ctx.title || ctx.url}”`;
  els.ctxFavicon.style.backgroundImage = `url("${faviconFor(ctx.url)}")`;

  const bits = [new URL(ctx.url).hostname, `${ctx.charCount.toLocaleString()} chars`];
  if (state.contextTabs.length > 1) bits.unshift(`+${state.contextTabs.length - 1} more tab(s)`);
  if (ctx.hasSelection) bits.push('selection included');
  if (ctx.truncated) bits.push('truncated');
  els.ctxMeta.textContent = bits.join(' · ');
}

/** Exactly what the model is about to be handed, verbatim. */
export function contextPreviewText() {
  const ctx = state.pageContext;
  if (!ctx) return 'Nothing captured yet.';
  const head = [`TITLE: ${ctx.title}`, `URL:   ${ctx.url}`];
  if (ctx.hasSelection) head.push(`\nSELECTION:\n${ctx.selection}`);
  return `${head.join('\n')}\n\nCONTENT:\n${ctx.text}`;
}

/**
 * Re-read the page whenever the user moves to a different tab or navigates.
 *
 * `info.url` matters as much as `info.status`: a single-page app routes with
 * the History API and never reports 'complete' again, so a status-only listener
 * leaves the panel showing — and sending — the page the tab was on when it
 * first loaded, however far the user has since browsed.
 */
let contextRefreshTimer = null;

export function queueContextRefresh() {
  if (!els.ctxOn.checked) return;
  clearTimeout(contextRefreshTimer);
  // SPA routing fires several updates per navigation; read once it lands.
  contextRefreshTimer = setTimeout(refreshContext, 350);
}
