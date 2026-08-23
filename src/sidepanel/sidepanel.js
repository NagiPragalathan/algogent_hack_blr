/**
 * Panel entry point.
 *
 * Layout of the rest:
 *   core/   state, storage, the port to the service worker, the element map
 *   ui/     one module per surface — thread, composer, sheets, drawer …
 *   app/    what messages mean (messages.js) and what clicks mean (events.js)
 *   lib/    self-contained helpers with no knowledge of the panel
 */

import { els } from './core/dom.js';
import { state } from './core/state.js';
import { connect, send } from './core/port.js';
import { restoreThread } from './core/sessions.js';
import { paintIcons } from './lib/icons.js';
import { setHint } from './ui/hint.js';
import { renderThread } from './ui/thread.js';
import { setAgentMode } from './ui/agent.js';
import { renderTabChips } from './ui/tab-picker.js';
import { renderWorkspace } from './ui/workspace.js';
import { autosize } from './ui/composer.js';
import { loadSkills } from './ui/skills.js';
import { refreshContext } from './ui/context.js';
import { handlePortMessage } from './app/messages.js';
import { bindEvents } from './app/events.js';
import { watchTheme } from './ui/theme.js';
import { initWallet } from './ui/wallet.js';
import { initPayments, loadListing } from './payments/x402.js';

/** How long to wait for the worker before saying it is not there. */
const WORKER_TIMEOUT_MS = 4000;

async function boot() {
  // First, and before anything is painted: the panel must not appear in one
  // palette and then swap to another. See watchTheme.
  await watchTheme();

  paintIcons();

  await restoreThread();
  await loadSkills();
  await initWallet();
  await initPayments();

  /**
   * What is payable, fetched once and never awaited.
   *
   * Awaiting it would put a network round trip in front of the first paint for
   * information nothing on screen needs yet. A listing that never arrives means
   * everything is free, which is the safe direction and the one this whole layer
   * defaults to.
   *
   * The WHOLE catalogue, and passing the skill ids here was a bug that silently
   * switched off every other kind of billing. `?ids=` is an optimisation for a
   * panel that only ever charged for skills; the registry also carries one entry
   * per agent ACTION (`act-navigate`, `act-click`, …) and one for an answer
   * (`act-answer`), and none of those are skills. Asking for the skill ids alone
   * meant `priceOf('act-navigate')` was null for every step of every run, so
   * `noteAction` dropped all of them and `settleRun` reported "nothing billable"
   * — with no error anywhere, because a missing registry entry legitimately
   * means free. Measured: a two-step Gmail run finished with no receipt at all.
   */
  void loadListing();

  bindEvents();
  renderThread();

  connect(handlePortMessage);
  send({ type: 'INIT' });

  // Agent mode itself is never restored — see state.agentMode.
  els.agentPolicy.value = state.agentPolicy;
  setAgentMode(false);

  renderTabChips();
  renderWorkspace();
  refreshContext();

  autosize();
  els.input.focus();

  watchForDeadWorker();
}

/**
 * If the worker never answers, say so.
 *
 * Every failure behind the port looks the same from here — a panel that simply
 * never fills in. Naming it saves the user guessing whether they are offline,
 * logged out, or looking at a broken build.
 */
function watchForDeadWorker() {
  setTimeout(() => {
    if (state.providers.length) return;
    setHint(
      'The extension background is not responding. Reload it on ' +
        'chrome://extensions, then reopen this panel.',
      'error'
    );
  }, WORKER_TIMEOUT_MS);
}

boot();
