import { resolveUserTab, isRelayOwned, isOrdinaryUrl } from '../state/user-tabs.js';

/**
 * Reading pages for the model.
 *
 * Both content scripts are injected together on the retry path: injecting half
 * the pair leaves a tab that answers EXTRACT_CONTEXT but silently ignores the
 * agent's messages, and agent runs on that tab then fail before their first step.
 */
const PAGE_SCRIPTS = ['src/content/page-context.js', 'src/content/agent-page.js'];

/**
 * `explicitTabId` is the tab the user picked from the "+" sheet; without one we
 * fall back to whatever page they are actually looking at.
 *
 * `deep` scrolls the page to the bottom before reading it, which is the only way
 * to see a lazily-rendered list — and costs a few seconds of visible scrolling on
 * the user's own tab, so it is for the question being sent, not for the preview
 * chip that updates while they type.
 */
export async function capturePageContext(
  settings,
  explicitTabId = null,
  strict = false,
  { deep = false } = {}
) {
  let tab = null;

  if (explicitTabId != null) {
    try {
      const picked = await chrome.tabs.get(explicitTabId);
      if (!isRelayOwned(picked) && isOrdinaryUrl(picked.url)) tab = picked;
    } catch {
      // The chosen tab was closed — fall through to the active one.
    }
  }

  if (!tab && !strict) tab = await resolveUserTab();

  if (!tab) {
    return { ok: false, error: 'No ordinary web page is open to read.' };
  }

  const ask = () =>
    chrome.tabs.sendMessage(tab.id, {
      type: 'EXTRACT_CONTEXT',
      deep,
      // A deep read gathers several screenfuls, so the ordinary budget would
      // throw away most of what the scrolling just paid for.
      maxChars: deep
        ? settings.deepContextChars || settings.maxContextChars
        : settings.maxContextChars,
      budgetMs: settings.deepReadBudgetMs
    });

  try {
    const res = await ask();
    if (res?.ok) return { ok: true, context: res.context };
    throw new Error(res?.error || 'Extraction failed');
  } catch {
    // Content script not present yet (installed mid-session, or the tab
    // pre-dates the extension). Inject and retry once.
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: PAGE_SCRIPTS
      });
      const res = await ask();
      if (res?.ok) return { ok: true, context: res.context };
      return { ok: false, error: res?.error || 'Extraction failed' };
    } catch (err) {
      return {
        ok: false,
        error:
          'Cannot read this page (' +
          String(err?.message || err) +
          '). Browser-internal and Web Store pages are off limits.'
      };
    }
  }
}

/**
 * Read several tabs at once.
 *
 * The first one is the "current page" for display purposes; the rest ride along
 * as additional <page> blocks. One failing tab must not sink the others — a
 * closed or restricted tab is reported and skipped, not fatal.
 */
export async function capturePages(settings, tabIds = [], { deep = false } = {}) {
  if (!tabIds.length) {
    const single = await capturePageContext(settings, null, false, { deep });
    return single.ok ? { ok: true, contexts: [single.context] } : single;
  }

  const results = await Promise.all(
    tabIds.map((id) => capturePageContext(settings, id, true, { deep }))
  );
  const contexts = results.filter((r) => r.ok).map((r) => r.context);

  if (!contexts.length) {
    return { ok: false, error: results[0]?.error || 'None of those tabs could be read.' };
  }
  return { ok: true, contexts };
}
