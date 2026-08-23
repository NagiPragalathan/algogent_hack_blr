import { setHint } from '../ui/hint.js';

/**
 * The channel to the service worker.
 *
 * The worker is torn down after about 30 seconds idle, which disconnects this
 * port. A single long-lived reference captured at load time is therefore dead
 * for most of the panel's life, and every postMessage on it throws "Attempting
 * to use a disconnected port object" — which is what breaks asking, refreshing
 * context and New chat after the panel has been sitting open. Reconnect on
 * demand instead.
 */

let port = null;
let onMessage = () => {};

/** Register the router and open the first connection. */
export function connect(handler) {
  if (handler) onMessage = handler;
  port = chrome.runtime.connect({ name: 'sidepanel' });
  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(() => {
    // Drop the reference; the next send builds a fresh one.
    port = null;
  });
  return port;
}

export function send(message) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return (port || connect()).postMessage(message);
    } catch {
      port = null;
    }
  }
  setHint('Lost the connection to the extension. Close and reopen the panel.', 'error');
}
