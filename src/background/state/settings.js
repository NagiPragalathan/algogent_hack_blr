import {
  DEFAULT_SETTINGS,
  mergeProviders
} from '../../providers/config.js';
import { registerProviderHosts } from '../relay.js';

/**
 * Settings and the provider list, read fresh on every use.
 *
 * Not cached: a service worker is torn down and restarted constantly, so a
 * cached copy is either stale or pointless, and the options page can change
 * these at any moment. `chrome.storage.local` is a local read.
 */
/**
 * Marks that the stored `directTransport` has been looked at once since
 * `'strict'` existed.
 *
 * Changing a DEFAULT does nothing for anybody who has ever pressed Save: their
 * copy of the old default is stored, and stored always wins over
 * `DEFAULT_SETTINGS`. So the people most likely to be watching windows open —
 * the ones who went to Options about it — would be the only ones the new
 * default never reached.
 *
 * Rewriting a value somebody chose is not something to do casually, and this is
 * the narrow case where it is honest: `'auto'` was the only setting that existed
 * until `'strict'` was added, so a stored `'auto'` is a default someone
 * inherited rather than a preference they expressed. Guarded by the marker so it
 * happens exactly once — set `'auto'` back afterwards and it stays.
 */
const TRANSPORT_DEFAULT_REVIEWED = 'directTransportReviewed';

export async function loadState() {
  const stored = await chrome.storage.local.get([
    'settings',
    'providerOverrides',
    TRANSPORT_DEFAULT_REVIEWED
  ]);

  if (!stored[TRANSPORT_DEFAULT_REVIEWED]) {
    const settings = stored.settings || {};
    if (settings.directTransport === 'auto') {
      settings.directTransport = 'strict';
      stored.settings = settings;
      await chrome.storage.local.set({ settings });
    }
    await chrome.storage.local.set({ [TRANSPORT_DEFAULT_REVIEWED]: true });
  }

  const providers = mergeProviders(stored.providerOverrides || {});

  // Let the relay recognise stray provider popups left over from a crash or an
  // older build, so Hide and Close can still reach them.
  registerProviderHosts(
    Object.values(providers).map((p) => {
      try {
        return new URL(p.homeUrl).hostname;
      } catch {
        return null;
      }
    })
  );

  return {
    settings: { ...DEFAULT_SETTINGS, ...(stored.settings || {}) },
    providers
  };
}

/** Background frames (the default) or a minimized window with real tabs. */
export const isEmbedded = (settings) =>
  (settings.providerMode || 'embedded') === 'embedded';
