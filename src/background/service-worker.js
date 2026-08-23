/**
 * Service worker — the coordinator.
 *
 * Side panel  --port-->  service worker  --tabs.sendMessage-->  adapter (relay tab)
 *                                       <--runtime.sendMessage--
 *
 * This file is only the wiring. Every listener it installs is one line, so what
 * the worker responds to is visible at a glance; the behaviour lives next door:
 *
 *   state/      settings, remembered conversations, which tab the user is on
 *   context/    reading pages and turning them into a prompt
 *   transport/  talking to a provider and keeping the worker alive to hear back
 *   agent/      the browse-and-act loop
 *   channel/    the side panel's port and every message it can send
 *   relay.js    the hidden window that hosts provider tabs
 *
 * Nothing here runs at import time except listener registration — MV3 restarts
 * this file constantly, and anything heavier would run on every wake-up.
 */

import { DEFAULT_PROVIDERS, DEFAULT_SETTINGS, PROVIDER_ORDER } from '../providers/config.js';
import { loadState } from './state/settings.js';
import { watchUserTabs } from './state/user-tabs.js';
import { watchAdapterEvents, watchWatchdogAlarm } from './transport/inflight.js';
import { watchPinnedTabs } from './transport/keep-awake.js';
import { watchContextMenus, watchPageSelection } from './context/handoff.js';
import { watchPanelConnections } from './channel/panel.js';
import { watchPanelTabs } from './state/panel-tabs.js';
import { directStatus } from './transport/direct/index.js';
import { installDirectHeaders } from './transport/direct/headers.js';

// The toolbar click is handled in state/panel-tabs.js rather than by Chrome:
// a per-tab panel needs the tab enabled before it is opened, and Chrome's own
// handler cannot do that. See the comment there.

watchUserTabs();
watchPanelTabs();
watchAdapterEvents();
watchWatchdogAlarm();
watchPinnedTabs(loadState);
watchContextMenus();
watchPageSelection();
watchPanelConnections();

/**
 * Session rules, so a direct request carries the headers the provider's own
 * page carries rather than the ones a service worker gets by default.
 *
 * Called at import time because session rules die with the browser and the
 * worker restarts constantly — it is idempotent (the ids are replaced, never
 * appended) and it never throws. Not awaited: a request going out before the
 * rules land is a request with the old headers, which is what every one of them
 * looked like before this existed.
 */
installDirectHeaders();

// Surface defaults to the options page without duplicating them there.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'GET_DEFAULTS') return;
  sendResponse({
    defaults: DEFAULT_PROVIDERS,
    order: PROVIDER_ORDER,
    settings: DEFAULT_SETTINGS
  });
  return true;
});

/**
 * "Why did a window open for a provider that is supposed to be fast?"
 *
 * The direct transport falls back silently on purpose, so that question cannot
 * be answered from the screen. This is how the options page asks it. Kept here
 * with GET_DEFAULTS rather than on the panel's port because the options page is
 * a separate document with no port of its own.
 */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'DIRECT_STATUS') return;

  loadState()
    .then(({ settings, providers }) => directStatus(settings, providers))
    .then((items) => sendResponse({ items }))
    .catch((err) => sendResponse({ items: [], error: String(err?.message || err) }));

  return true; // keep the channel open for the async reply
});
