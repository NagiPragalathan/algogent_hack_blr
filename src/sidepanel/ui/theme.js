/**
 * Which palette the panel is wearing.
 *
 * Two independent choices, and they are separate on purpose: light/dark is
 * about the room you are sitting in, the accent is about the extension. Folding
 * them into one list ("Dark Teal", "Light Teal", …) multiplies out to fourteen
 * options for two decisions, and the one people change often — following the
 * system at dusk — gets buried among thirteen they will set once.
 *
 * Everything below writes attributes onto <html> and nothing else. The colours
 * themselves live in `styles/tokens.css`, which is the only file allowed to
 * hold a raw hex; a value set from here would be a second palette that drifts
 * from the first and is invisible to anyone reading the stylesheet.
 */

/** Kept in step with the `[data-accent]` rules in tokens.css. */
export const ACCENTS = [
  { id: 'blue', name: 'Default', hint: 'The blue the panel shipped with' },
  { id: 'teal', name: 'Teal', hint: 'Calm, reads as a tool' },
  { id: 'violet', name: 'Violet', hint: 'Closest to the provider UIs' },
  { id: 'rose', name: 'Rose', hint: 'Warm, high contrast' },
  { id: 'amber', name: 'Amber', hint: 'Warmest — good on dark' },
  { id: 'green', name: 'Green', hint: 'Quiet, low urgency' },
  { id: 'slate', name: 'Graphite', hint: 'No colour at all' }
];

export const THEMES = [
  { id: 'system', name: 'System', hint: 'Follows your OS setting' },
  { id: 'light', name: 'Light', hint: 'Always light' },
  { id: 'dark', name: 'Dark', hint: 'Always dark' }
];

const THEME_IDS = new Set(THEMES.map((t) => t.id));
const ACCENT_IDS = new Set(ACCENTS.map((a) => a.id));

/**
 * Paint the choice onto the document.
 *
 * `system` REMOVES the attribute rather than setting `data-theme="system"`,
 * because the stylesheet's rule is `:not([data-theme='light'])` inside a
 * `prefers-color-scheme` query — an attribute of any other value would satisfy
 * that `:not` and work, but only by accident, and the first person to add a
 * `[data-theme='system']` rule would find two things claiming to mean "no
 * override". Absent means absent.
 *
 * An unknown value falls back rather than being written through. These come
 * from `chrome.storage`, which is shared with an options page and survives
 * downgrades, so a preset this build no longer ships is a real case — and
 * writing it through would leave the panel with no accent rule matching at all.
 */
export function applyTheme({ theme, accent } = {}, root = document.documentElement) {
  const mode = THEME_IDS.has(theme) ? theme : 'system';
  const hue = ACCENT_IDS.has(accent) ? accent : 'blue';

  if (mode === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', mode);

  root.setAttribute('data-accent', hue);
}

/**
 * Apply the stored choice, then keep applying it.
 *
 * Read straight from `chrome.storage` rather than waiting for the port's INIT,
 * and awaited as the first thing `boot()` does. INIT is a round trip to a
 * service worker that MV3 may have to start from cold, which is hundreds of
 * milliseconds of the panel sitting there in the wrong palette — and a panel
 * that flashes white before going dark is the single most noticeable way to get
 * this wrong. A local storage read is about a millisecond.
 *
 * The `onChanged` half is what makes the options page usable at all: the two
 * are separate documents, so there is no other way for a radio over there to
 * reach the panel over here, and a theme that only applied on the next reopen
 * would be chosen blind. It is the same reasoning as the agent frame designs
 * applying live to a running curtain.
 */
export async function watchTheme() {
  const read = async () => {
    try {
      const { settings } = await chrome.storage.local.get('settings');
      applyTheme({ theme: settings?.panelTheme, accent: settings?.panelAccent });
    } catch {
      // Storage unavailable — the defaults in tokens.css are already correct.
    }
  };

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    const next = changes.settings.newValue || {};
    applyTheme({ theme: next.panelTheme, accent: next.panelAccent });
  });

  await read();
}
