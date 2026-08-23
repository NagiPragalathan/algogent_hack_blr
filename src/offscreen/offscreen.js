/**
 * Offscreen host for the provider frames.
 *
 * This document is never displayed — no window, no tab, no taskbar entry — but
 * it is a real renderer, so the provider's own web app runs inside it exactly
 * as it would in a tab. That is the point: the traffic, the fingerprint and the
 * JavaScript are the site's own, so nothing about it looks automated.
 *
 * Providers block framing with X-Frame-Options / frame-ancestors; the
 * declarativeNetRequest rules in rules/frame-rules.json strip those headers,
 * scoped to sub_frame loads of the provider hosts only.
 *
 * Addressing: the adapter runs as a content script inside each frame, and there
 * may well be other tabs on the same site (the user's own). Rather than
 * broadcasting — which would type into the user's real ChatGPT tab — this
 * document handshakes with its own frames over postMessage, and every command
 * travels down that private channel.
 */

const HANDSHAKE = '__sidebar_ai_handshake__';
const TO_ADAPTER = '__sidebar_ai_to_adapter__';
const FROM_ADAPTER = '__sidebar_ai_from_adapter__';

const host = document.getElementById('frames');

/** providerId -> { iframe, provider, settings, ready, queue } */
const frames = new Map();

function post(message) {
  chrome.runtime.sendMessage({ from: 'offscreen', ...message }).catch(() => {});
}

function handshake(entry) {
  entry.iframe.contentWindow?.postMessage(
    {
      type: HANDSHAKE,
      providerId: entry.provider.id,
      provider: entry.provider,
      settings: entry.settings
    },
    '*'
  );
}

/**
 * Create or update the frame for a provider. Navigating an existing frame keeps
 * the conversation in place instead of spawning a second one.
 */
function ensureFrame(provider, settings, url) {
  let entry = frames.get(provider.id);

  if (!entry) {
    const iframe = document.createElement('iframe');
    iframe.dataset.provider = provider.id;
    // Everything the provider app needs to behave like a normal top-level page.
    iframe.allow = 'clipboard-read; clipboard-write; microphone';
    entry = { iframe, provider, settings, ready: false };
    frames.set(provider.id, entry);
    host.append(iframe);

    iframe.addEventListener('load', () => {
      entry.ready = false;
      // The content script announces itself; this is a belt-and-braces nudge
      // for the case where our handshake would otherwise arrive first.
      handshake(entry);
      setTimeout(() => handshake(entry), 400);
      setTimeout(() => handshake(entry), 1500);
    });

    iframe.src = url;
    return entry;
  }

  entry.provider = provider;
  entry.settings = settings;

  const current = entry.iframe.getAttribute('src');
  if (url && !sameUrl(current, url) && !sameUrl(entry.lastKnownUrl, url)) {
    entry.ready = false;
    entry.iframe.src = url;
  } else {
    handshake(entry);
  }
  return entry;
}

function sameUrl(a, b) {
  if (!a || !b) return false;
  try {
    const x = new URL(a);
    const y = new URL(b);
    return x.origin + x.pathname.replace(/\/+$/, '') === y.origin + y.pathname.replace(/\/+$/, '');
  } catch {
    return a === b;
  }
}

function sendToFrame(providerId, message) {
  const entry = frames.get(providerId);
  if (!entry) return false;
  entry.iframe.contentWindow?.postMessage({ type: TO_ADAPTER, ...message }, '*');
  return true;
}

// Adapter -> this document -> service worker.
window.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || data.type !== FROM_ADAPTER) return;

  // Only accept messages from frames we created.
  const entry = [...frames.values()].find((f) => f.iframe.contentWindow === event.source);
  if (!entry) return;

  if (data.event === 'adapter_ready') {
    entry.ready = true;
    if (data.url) entry.lastKnownUrl = data.url;
    return;
  }

  if (data.url) entry.lastKnownUrl = data.url;

  post({
    type: 'ADAPTER_EVENT',
    providerId: entry.provider.id,
    reqId: data.reqId,
    state: data.state,
    text: data.text,
    error: data.error,
    truncated: data.truncated,
    url: data.url
  });
});

// Service worker -> this document.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return;

  switch (msg.type) {
    case 'ENSURE_FRAME': {
      ensureFrame(msg.provider, msg.settings, msg.url);
      sendResponse({ ok: true });
      break;
    }

    // TICK rides the same private channel: it is only a wake-up, so a frame
    // that has not handshaken yet simply misses it.
    case 'TICK':
    case 'SUBMIT':
    case 'CANCEL':
    case 'PROBE': {
      const delivered = sendToFrame(msg.providerId, {
        command: msg.type,
        reqId: msg.reqId,
        text: msg.text,
        image: msg.image
      });
      sendResponse({ ok: delivered });
      break;
    }

    case 'NAVIGATE': {
      const entry = frames.get(msg.providerId);
      if (entry && msg.url) {
        entry.ready = false;
        entry.iframe.src = msg.url;
      }
      sendResponse({ ok: Boolean(entry) });
      break;
    }

    case 'DROP_FRAME': {
      const entry = frames.get(msg.providerId);
      entry?.iframe.remove();
      frames.delete(msg.providerId);
      sendResponse({ ok: true });
      break;
    }

    case 'STATUS': {
      sendResponse({
        ok: true,
        frames: [...frames.entries()].map(([id, f]) => ({
          providerId: id,
          ready: f.ready,
          url: f.lastKnownUrl || f.iframe.getAttribute('src')
        }))
      });
      break;
    }

    default:
      return;
  }

  return true;
});

post({ type: 'OFFSCREEN_READY' });
