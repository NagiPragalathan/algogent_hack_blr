import { els, make } from '../core/dom.js';
import { state } from '../core/state.js';
import { icon } from '../lib/icons.js';
import { saveThread } from '../core/sessions.js';
import { renderThread } from './thread.js';

/**
 * Which assistant answers.
 *
 * The list lives in a bottom sheet behind the composer pill rather than as tabs
 * across the top, so the thread keeps the full width of a panel that is often
 * only 350px wide.
 */
export function renderProviderSheet() {
  els.tabs.replaceChildren();

  for (const provider of state.providers) {
    if (provider.enabled === false) continue;

    const row = make('button', 'sheet-row');
    row.dataset.id = provider.id;
    row.setAttribute(
      'aria-current',
      String(!state.compare && provider.id === state.active)
    );

    const dot = make('span', 'dot');
    dot.style.background = provider.color;

    const label = make('span', 'sheet-row-main', provider.name);

    const check = make('span', 'check');
    check.innerHTML = icon('check', 14);

    row.append(dot, label, check);
    row.addEventListener('click', () => {
      state.compare = false;
      state.active = provider.id;
      els.providerMenu.hidden = true;
      renderProviderSheet();
      renderProviderPill();
      renderThread();
      saveThread();
    });

    els.tabs.append(row);
  }

  els.btnCompare.setAttribute('aria-pressed', String(state.compare));
}

/** The composer pill showing which provider will answer. */
export function renderProviderPill() {
  const provider = state.byId[state.active];
  els.providerName.textContent = state.compare
    ? 'All providers'
    : provider?.name || 'Provider';
  els.providerDot.style.background = state.compare
    ? 'var(--accent)'
    : provider?.color || 'var(--fg-dim)';
}

export function setProviderBusy(providerId, busy) {
  const row = els.tabs.querySelector(`.sheet-row[data-id="${providerId}"]`);
  row?.classList.toggle('busy', busy);
}

/** Who this question goes to: everyone in compare mode, otherwise the active one. */
export function targetProviders() {
  const enabled = state.providers.filter((p) => p.enabled !== false);
  if (state.compare) return enabled.map((p) => p.id);
  return state.active ? [state.active] : enabled.slice(0, 1).map((p) => p.id);
}

export function toggleCompare() {
  state.compare = !state.compare;
  els.providerMenu.hidden = true;
  renderProviderPill();
  renderProviderSheet();
  renderThread();
  saveThread();
  return state.compare;
}
