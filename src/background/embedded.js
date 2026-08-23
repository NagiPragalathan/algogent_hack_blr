/**
 * Embedded transport — the no-window mode.
 *
 * Instead of driving a real tab in a minimized window, the provider apps run
 * inside an offscreen document: a real renderer with no window, no tab and
 * nothing in the taskbar. The site's own JavaScript still executes in a normal
 * Chrome renderer with the user's real session, so nothing about the traffic
 * looks automated — which is exactly why this is preferable to calling the
 * providers' private HTTP endpoints directly.
 */

const OFFSCREEN_PATH = 'src/offscreen/offscreen.html';

/** Single-flight, for the same reason window creation needs it. */
let creating = null;

async function offscreenExists() {
  if (!chrome.runtime.getContexts) return false;
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT']
  });
  return contexts.length > 0;
}

export async function ensureOffscreen() {
  if (await offscreenExists()) return true;
  if (creating) return creating;

  creating = (async () => {
    try {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_PATH,
        reasons: ['IFRAME_SCRIPTING', 'DOM_SCRAPING'],
        justification:
          'Runs the AI provider web apps in background frames so the side panel can relay questions and answers without opening a window.'
      });
      return true;
    } catch (err) {
      // "Only a single offscreen document may be created" means we raced with
      // ourselves and the document is there after all.
      if (String(err?.message || err).includes('single offscreen')) return true;
      throw err;
    } finally {
      creating = null;
    }
  })();

  return creating;
}

export async function closeOffscreen() {
  if (!(await offscreenExists())) return;
  await chrome.offscreen.closeDocument().catch(() => {});
}

function toOffscreen(message) {
  return chrome.runtime.sendMessage({ target: 'offscreen', ...message });
}

/** Create or re-point a provider's background frame. */
export async function ensureFrame(provider, settings, url) {
  await ensureOffscreen();
  return toOffscreen({
    type: 'ENSURE_FRAME',
    provider,
    settings,
    url: url || provider.homeUrl
  });
}

export async function submit(provider, settings, url, reqId, text, image = null) {
  await ensureFrame(provider, settings, url);
  return toOffscreen({
    type: 'SUBMIT',
    providerId: provider.id,
    reqId,
    text,
    image
  });
}

export async function cancel(providerId, reqId) {
  if (!(await offscreenExists())) return;
  await toOffscreen({ type: 'CANCEL', providerId, reqId }).catch(() => {});
}

/**
 * Nudge a frame's adapter so its poll loop does not wait on a throttled timer.
 *
 * Deliberately skips `offscreenExists()`: this is called several times a second
 * while a request is in flight, and the existence check is itself an async
 * round trip. A tick that misses costs nothing — the page's own timer is still
 * running underneath as the backstop.
 */
export function tick(providerId) {
  toOffscreen({ type: 'TICK', providerId }).catch(() => {});
}

export async function navigate(providerId, url) {
  if (!(await offscreenExists())) return false;
  const res = await toOffscreen({ type: 'NAVIGATE', providerId, url }).catch(() => null);
  return Boolean(res?.ok);
}

export async function dropFrame(providerId) {
  if (!(await offscreenExists())) return;
  await toOffscreen({ type: 'DROP_FRAME', providerId }).catch(() => {});
}

export async function status() {
  if (!(await offscreenExists())) return { frames: [] };
  return (await toOffscreen({ type: 'STATUS' }).catch(() => null)) || { frames: [] };
}

// ----------------------------------------------------------------- cookies ---

/**
 * Session cookies are almost always `SameSite=Lax`, and Lax cookies are NOT
 * sent on a cross-site subresource request — which is what a provider frame
 * inside an extension page is. Without this the frame simply shows a signed-out
 * page no matter how many times the user logs in.
 *
 * Relaxing them to SameSite=None is a real reduction in the account's CSRF
 * protection, so it is opt-in and never runs unless the user turns it on.
 */
export async function relaxCookiesForFrames(provider) {
  let host;
  try {
    host = new URL(provider.homeUrl).hostname;
  } catch {
    return { changed: 0, failed: 0 };
  }

  const domain = host.replace(/^www\./, '');
  let cookies = [];
  try {
    cookies = await chrome.cookies.getAll({ domain });
  } catch {
    return { changed: 0, failed: 0 };
  }

  let changed = 0;
  let failed = 0;

  for (const cookie of cookies) {
    if (cookie.sameSite === 'no_restriction') continue;

    // A cookie sent cross-site must also be Secure, or Chrome rejects it.
    const scheme = 'https://';
    const bareDomain = cookie.domain.replace(/^\./, '');

    try {
      await chrome.cookies.set({
        url: scheme + bareDomain + cookie.path,
        name: cookie.name,
        value: cookie.value,
        // Only send `domain` back for cookies that were host-agnostic to begin
        // with; passing it for a host-only cookie widens its scope.
        domain: cookie.domain.startsWith('.') ? cookie.domain : undefined,
        path: cookie.path,
        secure: true,
        httpOnly: cookie.httpOnly,
        sameSite: 'no_restriction',
        expirationDate: cookie.expirationDate,
        storeId: cookie.storeId
      });
      changed++;
    } catch {
      failed++;
    }
  }

  return { changed, failed };
}
