import {
  DEFAULT_PROVIDERS,
  DEFAULT_SETTINGS,
  DIRECT_PROVIDERS,
  PROVIDER_ORDER,
  mergeProviders,
  transportFor
} from '../providers/config.js';

const SELECTOR_ROLES = [
  ['composer', 'The box you type into'],
  ['send', 'The submit button'],
  ['stop', 'The "stop generating" button — its presence means a reply is streaming'],
  ['streaming', 'Optional: an element that exists only while streaming'],
  ['assistant', 'Assistant message containers — the last match is read as the live reply'],
  [
    'user',
    'Your own message containers — the reply is read from after the question that was just sent'
  ],
  ['loggedOut', 'Only checked when no composer exists; signals a sign-in is needed'],
  ['ready', 'Signals the app has finished booting']
];

const SETTING_FIELDS = [
  'directTransport',
  'safePacing',
  'providerMode',
  'relaxCookies',
  'maxContextChars',
  'deepContextChars',
  'deepReadBudgetMs',
  'deepRead',
  'contextOnByDefault',
  'captureSelection',
  'relayWindowMode',
  'tabWakePolicy',
  'stabilityMs',
  'responseTimeoutMs',
  'readyTimeoutMs',
  'agentHighlight',
  'agentCursor',
  'agentIdleCursor',
  'agentFrame',
  'agentStepPointer',
  'agentPacing',
  'panelTheme',
  'panelAccent'
];

/**
 * Settings whose control is a group of radios, not one element.
 *
 * The pointer is chosen from pictures — "Ink" and "Classic" in a dropdown are
 * two words that mean nothing until you have seen them on a page — so it has
 * no single element with a `.value` for the loops below to read. Listed here
 * rather than sniffed at, because a silent miss would save the default over
 * the user's choice every time they touched any other setting.
 */
const RADIO_FIELDS = new Set(['agentCursor', 'agentFrame', 'panelTheme', 'panelAccent']);

const $ = (id) => document.getElementById(id);

const radioValue = (name) =>
  document.querySelector(`input[name="${name}"]:checked`)?.value ?? '';

function checkRadio(name, value) {
  const chosen =
    document.querySelector(`input[name="${name}"][value="${value}"]`) ||
    // A stored value we no longer ship — fall back to the first option rather
    // than leaving the whole group unchecked, which reads as "nothing set".
    document.querySelector(`input[name="${name}"]`);
  if (chosen) chosen.checked = true;
}
const status = $('status');

let providers = {};

function toLines(list) {
  return (list || []).join('\n');
}

function fromLines(text) {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

function validateSelector(sel) {
  try {
    document.querySelector(sel);
    return true;
  } catch {
    return false;
  }
}

function renderProviders() {
  const host = $('providers');
  host.replaceChildren();

  for (const id of PROVIDER_ORDER) {
    const provider = providers[id];
    const base = DEFAULT_PROVIDERS[id];

    const details = document.createElement('details');
    details.className = 'provider';
    details.dataset.id = id;

    const summary = document.createElement('summary');
    summary.innerHTML = `
      <span class="dot" style="background:${provider.color}"></span>
      <span>${provider.name}</span>
      <span class="grow"></span>
      <label><input type="checkbox" class="enable" ${provider.enabled !== false ? 'checked' : ''} /> Enabled</label>
    `;
    // Toggling the checkbox must not open/close the disclosure.
    summary.querySelector('.enable').addEventListener('click', (e) => e.stopPropagation());

    const body = document.createElement('div');
    body.className = 'provider-body';

    const urlRow = document.createElement('div');
    urlRow.className = 'sel-row';
    urlRow.innerHTML = `
      <label>New-chat URL <span class="desc">— where "new conversation" navigates</span></label>
      <textarea class="url" rows="1" spellcheck="false">${provider.newChatUrl}</textarea>
    `;
    body.append(urlRow);

    for (const [role, desc] of SELECTOR_ROLES) {
      const row = document.createElement('div');
      row.className = 'sel-row';

      const label = document.createElement('label');
      label.innerHTML = `${role} <span class="desc">— ${desc}</span>`;

      const ta = document.createElement('textarea');
      ta.spellcheck = false;
      ta.dataset.role = role;
      ta.value = toLines(provider.selectors[role]);
      ta.placeholder = toLines(base.selectors[role]) || '(none)';
      ta.addEventListener('input', () => {
        const bad = fromLines(ta.value).some((s) => !validateSelector(s));
        ta.classList.toggle('invalid', bad);
      });

      row.append(label, ta);
      body.append(row);
    }

    details.append(summary, body);
    host.append(details);
  }
}

function collect() {
  const overrides = {};

  for (const details of document.querySelectorAll('details.provider')) {
    const id = details.dataset.id;
    const base = DEFAULT_PROVIDERS[id];
    const entry = { selectors: {} };

    entry.enabled = details.querySelector('.enable').checked;

    const url = details.querySelector('.url').value.trim();
    if (url && url !== base.newChatUrl) {
      entry.newChatUrl = url;
      entry.homeUrl = url;
    }

    for (const ta of details.querySelectorAll('textarea[data-role]')) {
      const list = fromLines(ta.value);
      const same =
        list.length === base.selectors[ta.dataset.role].length &&
        list.every((s, i) => s === base.selectors[ta.dataset.role][i]);
      if (!same) entry.selectors[ta.dataset.role] = list;
    }

    if (!Object.keys(entry.selectors).length) delete entry.selectors;
    overrides[id] = entry;
  }

  const settings = {};
  for (const key of SETTING_FIELDS) {
    if (RADIO_FIELDS.has(key)) {
      settings[key] = radioValue(key);
      continue;
    }

    const el = $(key);
    settings[key] =
      el.type === 'checkbox'
        ? el.checked
        : el.type === 'number'
          ? Number(el.value)
          : el.value;
  }

  // One control per provider rather than one field, so it is collected by hand.
  settings.providerTransport = {};
  for (const select of document.querySelectorAll('select[data-transport]')) {
    settings.providerTransport[select.dataset.transport] = select.value;
  }

  return { overrides, settings };
}

function say(text, kind = '') {
  status.textContent = text;
  status.className = `status ${kind}`.trim();
  if (text) setTimeout(() => (status.textContent = ''), 3000);
}

async function load() {
  const stored = await chrome.storage.local.get(['settings', 'providerOverrides']);
  const settings = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
  providers = mergeProviders(stored.providerOverrides || {});

  for (const key of SETTING_FIELDS) {
    if (RADIO_FIELDS.has(key)) {
      checkRadio(key, settings[key]);
      continue;
    }

    const el = $(key);
    if (el.type === 'checkbox') el.checked = Boolean(settings[key]);
    else el.value = settings[key];
  }

  renderProviders();
  renderTransports(settings);
  paintOwnTheme(settings);
}

/**
 * One row per provider that can avoid the popup: its name, a dropdown, and the
 * place its verdict lands when Check now is pressed.
 *
 * Built with the DOM rather than an HTML string throughout. The verdicts come
 * back from provider responses we do not control, by way of an error message,
 * and `innerHTML` there would turn one of them into markup on this page.
 */
function renderTransports(settings) {
  const box = $('directProviders');
  box.textContent = '';

  for (const id of DIRECT_PROVIDERS) {
    const provider = providers[id] ?? DEFAULT_PROVIDERS[id];

    const row = document.createElement('div');
    row.className = 'direct-row';

    const name = document.createElement('strong');
    name.textContent = provider?.name ?? id;

    const select = document.createElement('select');
    select.dataset.transport = id;
    for (const [value, label] of [['direct', 'No popup (fastest)'], ['window', 'Popup window']]) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      select.append(option);
    }
    select.value = transportFor(settings, id);
    // What is STORED, so 'Check now' can tell an unsaved dropdown from a saved
    // one. Both the select and the background read stored settings, so a
    // changed-but-unsaved value reports a verdict about the OTHER setting —
    // which reads as the check being broken.
    select.dataset.saved = select.value;

    // Filled in by Check now. Present from the start so pressing it does not
    // reflow the rows underneath the pointer.
    const verdict = document.createElement('span');
    verdict.className = 'direct-verdict';
    verdict.dataset.verdict = id;

    row.append(name, select, verdict);
    box.append(row);
  }
}

$('checkDirect').addEventListener('click', () => {
  const unsaved = [...document.querySelectorAll('select[data-transport]')]
    .filter((el) => el.value !== el.dataset.saved);
  if (unsaved.length) {
    say('Press Save first — Check now reports on the saved setting, not the dropdown.', 'err');
    return;
  }

  for (const el of document.querySelectorAll('[data-verdict]')) {
    el.textContent = 'checking…';
    el.className = 'direct-verdict';
  }

  chrome.runtime.sendMessage({ type: 'DIRECT_STATUS' }, (reply) => {
    const items = reply?.items ?? [];

    if (!items.length) {
      say(reply?.error || 'The background worker did not answer. Reload the extension.', 'err');
      for (const el of document.querySelectorAll('[data-verdict]')) el.textContent = '';
      return;
    }

    for (const item of items) {
      const el = document.querySelector(`[data-verdict="${item.id}"]`);
      if (!el) continue;

      el.className = `direct-verdict ${item.ok ? 'ok' : 'no'}`;
      // The detail is the account it found, which is the one thing that proves
      // it is talking to the session the user thinks it is.
      el.textContent = item.ok
        ? `working${item.detail ? ` — ${item.detail}` : ''}`
        : item.reason || 'unavailable';
    }
  });
});

$('save').addEventListener('click', async () => {
  const invalid = document.querySelector('textarea.invalid');
  if (invalid) {
    invalid.scrollIntoView({ block: 'center', behavior: 'smooth' });
    say('One of the selectors is not valid CSS — fix the highlighted box.', 'err');
    return;
  }

  const { overrides, settings } = collect();

  if (!Object.values(overrides).some((p) => p.enabled)) {
    say('Enable at least one provider.', 'err');
    return;
  }

  await chrome.storage.local.set({ settings, providerOverrides: overrides });

  // These rows are not re-rendered on save, so the baseline 'Check now' compares
  // against has to be moved forward here — otherwise the guard keeps reporting
  // an unsaved change that has just been saved.
  for (const el of document.querySelectorAll('select[data-transport]')) {
    el.dataset.saved = el.value;
  }

  say('Saved. Reopen the side panel to pick up the changes.', 'ok');
});

/**
 * Appearance applies the moment it is clicked, without Save.
 *
 * Everything else on this page is a behaviour you can read off its label, so
 * batching it behind Save is right. A palette is not: you pick it by looking at
 * it, and one that took effect on the next reopen would be chosen blind — the
 * same reason the agent's border designs apply live to a running curtain.
 *
 * Only the two appearance keys are written, and they are merged onto what is in
 * STORAGE rather than onto what the form currently holds. Collecting the whole
 * form here would quietly persist every other half-finished edit on the page —
 * a number being typed, a selector mid-paste — which is precisely what having a
 * Save button promises will not happen.
 */
async function applyAppearanceNow() {
  const stored = await chrome.storage.local.get('settings');
  const settings = {
    ...(stored.settings || {}),
    panelTheme: radioValue('panelTheme'),
    panelAccent: radioValue('panelAccent')
  };
  await chrome.storage.local.set({ settings });
  paintOwnTheme(settings);
}

for (const name of ['panelTheme', 'panelAccent']) {
  for (const input of document.querySelectorAll(`input[name="${name}"]`)) {
    input.addEventListener('change', applyAppearanceNow);
  }
}

/**
 * This page wears the choice too.
 *
 * Without it the only way to judge a theme is to have the side panel open
 * beside the settings — and the panel is per window, so it is routinely not
 * open on the tab you opened Settings in. The rules live in options.css and
 * mirror the panel's; see the note there about the two being hand copies.
 */
function paintOwnTheme(settings) {
  const root = document.documentElement;
  const theme = settings.panelTheme || 'system';
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
  root.setAttribute('data-accent', settings.panelAccent || 'blue');
}

$('reset').addEventListener('click', async () => {
  await chrome.storage.local.remove(['settings', 'providerOverrides']);
  await load();
  say('Reset to shipped defaults.', 'ok');
});

load();
