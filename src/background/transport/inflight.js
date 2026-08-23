import { rememberConversation } from '../state/conversations.js';
import * as embedded from '../embedded.js';

/**
 * Requests currently waiting on a provider, and the worker's lifeline.
 *
 * Keyed `${reqId}:${providerId}` — one question can be out to several providers
 * at once, and each has to be cancellable on its own.
 */
export const inflight = new Map();

export const streamKey = (reqId, providerId) => `${reqId}:${providerId}`;

/**
 * Keep the worker alive while something is genuinely in flight.
 *
 * MV3 tears a service worker down after roughly 30 seconds with no extension
 * API activity. Waiting on a provider reply is not API activity — it is a
 * promise resolved by an incoming message — so a single slow answer, and every
 * agent step, can outlive the worker. When it dies mid-run the state goes with
 * it: the adapter finishes talking to nobody, and the panel waits forever. That
 * is the "stuck", and it is indistinguishable from slowness until you notice it
 * never recovers.
 *
 * A cheap periodic API call resets that idle timer. It runs only while work is
 * outstanding, so an idle panel still lets the worker sleep as it should.
 */
let keepAlive = null;

/**
 * Work that is not a tracked request — an agent run spends most of its life
 * between provider calls, waiting on a page or on the user.
 */
let holds = 0;

/**
 * A 30s alarm as well as the interval, because they fail differently.
 *
 * The interval keeps a *living* worker from going idle. It cannot help once the
 * worker has been killed anyway — a timer dies with it. An alarm is scheduled in
 * the browser, not in the worker, so it wakes a dead one; that is the only way
 * back if Chrome decides to stop us mid-answer. 30s is the floor Chrome honours
 * for a repeating alarm.
 */
const WATCHDOG_ALARM = 'sidebar-ai-watchdog';

export function startKeepAlive() {
  chrome.alarms?.create(WATCHDOG_ALARM, { periodInMinutes: 0.5 });
  if (keepAlive) return;
  keepAlive = setInterval(() => {
    chrome.runtime.getPlatformInfo().catch(() => {});
  }, 20000);
  startHeartbeat();
}

/**
 * Installed once from the worker entry.
 *
 * Waking is the whole point — the handler only has to re-establish the heartbeat
 * for anything still in flight, and clear the alarm once there is nothing left,
 * so an idle profile is not woken every 30 seconds forever.
 */
export function watchWatchdogAlarm() {
  chrome.alarms?.onAlarm.addListener((alarm) => {
    if (alarm.name !== WATCHDOG_ALARM) return;
    if (!inflight.size && !holds) {
      chrome.alarms.clear(WATCHDOG_ALARM);
      return;
    }
    startHeartbeat();
  });
}

/**
 * Drive the adapter's poll loop from here, because a hidden page cannot.
 *
 * The provider lives somewhere the browser has decided does not matter — a
 * minimized relay window, or a frame in an offscreen document. Chrome clamps
 * timers in a hidden page to once a second: measured on a chained 200ms poll,
 * 200ms visible becomes 1000ms hidden, and the adapter's MessageChannel nesting
 * reset makes no difference to that base clamp (11.99s vs 11.95s over twelve
 * rounds). Every quiet wait in a run therefore took five times longer than it
 * was written to, which across a dozen waits per agent step is the difference
 * between "thinking" and "stuck" — and it came unstuck the moment the user
 * focused the provider window, because the clamp lifted.
 *
 * A service worker's timers are not throttled, and message delivery into a page
 * is a task rather than a timer, so a tick from here arrives on time however
 * hidden the page is. The adapter treats it exactly like a DOM mutation.
 */
const HEARTBEAT_MS = 250;
let heartbeat = null;

function startHeartbeat() {
  if (heartbeat) return;
  heartbeat = setInterval(() => {
    // Self-stopping: a 250ms interval left running would reset the worker's own
    // idle timer forever, so an extension that is doing nothing would never let
    // its worker sleep.
    if (!inflight.size) {
      stopHeartbeat();
      return;
    }

    for (const entry of inflight.values()) {
      // Between two attempts at the same question there is no page to nudge —
      // the one it was talking to has just been closed on purpose.
      if (entry.recovering) continue;

      /**
       * A direct request has no page at all: it is a fetch in this worker
       * reading a stream, and nothing about it is clamped, so there is nothing
       * a tick could help. Its null tabId would otherwise be read as "a
       * background frame" one line down and tick the offscreen document 4×/s
       * for the whole of every answer.
       */
      if (entry.direct) continue;

      // A null tabId means this request is running in a background frame.
      if (entry.tabId == null) {
        embedded.tick(entry.providerId);
      } else {
        chrome.tabs
          .sendMessage(entry.tabId, { target: 'adapter', type: 'TICK' })
          .catch(() => {});
      }
    }
  }, HEARTBEAT_MS);
}

function stopHeartbeat() {
  if (!heartbeat) return;
  clearInterval(heartbeat);
  heartbeat = null;
}

export function holdKeepAlive() {
  holds += 1;
  startKeepAlive();
}

export function releaseKeepAlive() {
  holds = Math.max(0, holds - 1);
  stopKeepAliveIfIdle();
}

export function stopKeepAliveIfIdle() {
  if (!inflight.size) stopHeartbeat();
  if (keepAlive && !inflight.size && !holds) {
    clearInterval(keepAlive);
    keepAlive = null;
    chrome.alarms?.clear(WATCHDOG_ALARM);
  }
}

/**
 * Cancel every tracked request whose key starts with `prefix`.
 *
 * `abort` and `cancelAdapter` are alternatives, not a sequence. A direct
 * request is a fetch in this worker and is stopped by aborting it; every other
 * kind is a page being driven and is stopped by messaging it. Running both
 * would send a CANCEL to whatever tab id the direct entry happens to carry —
 * which is null, and null is the marker for a background frame, so Stop on a
 * direct answer would cancel an unrelated embedded request instead.
 */
export function cancelInflight(prefix, { cancelAdapter, onCancelled } = {}) {
  for (const [key, entry] of inflight) {
    if (!key.startsWith(prefix)) continue;
    if (entry.abort) entry.abort();
    else cancelAdapter?.(entry);
    onCancelled?.(entry);
    inflight.delete(key);
    entry.settle?.();
  }
}

/**
 * Adapter -> service worker -> side panel.
 *
 * Installed once from the worker entry.
 */
export function watchAdapterEvents() {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== 'ADAPTER_EVENT') return;
    if (msg.state === 'adapter_ready') return;

    const entry = inflight.get(streamKey(msg.reqId, msg.providerId));

    // Capture the conversation URL even for a request we are no longer tracking
    // (panel closed mid-reply) — the thread still exists and is worth resuming.
    // Once accepted, tell the panel so the session records which provider thread
    // it belongs to and can rejoin it when reopened from history.
    if (msg.url) {
      /**
       * Filed under the thread the request belongs to. With no entry left to
       * ask, it is a chat: that is what the untracked case has always been —
       * a panel closed mid-reply, whose thread is worth resuming next time —
       * and guessing "agent" for it would overwrite a real run's thread with a
       * URL from a request nobody is waiting on.
       */
      /**
       * `scope: 'none'` is a question that must leave no trace.
       *
       * Naming a chat is the case: it is our own housekeeping, not the user's
       * conversation, and filing its URL made it one. During an agent run the
       * damage compounds — the request lands in whatever thread the tab is on
       * (the run's), so the run's URL gets filed as the CHAT thread, and the
       * user's next ordinary question resumes a conversation full of JSON
       * actions. Skipping the file is not enough on its own; see the guard in
       * panel.js for why the title must not be asked for mid-run at all.
       */
      const scope = entry?.scope || 'chat';

      // Guard the FILING only. An early return here would skip the event
      // forwarding below, so the request never resolves and waits out its
      // watchdog — a five-minute hang in place of a URL we chose not to store.
      if (scope !== 'none') {
        // Filed under the chat that asked as well as the scope: one thread per
        // provider per panel chat is the whole point — see conversations.js.
        rememberConversation(msg.providerId, msg.url, scope, entry?.sessionId ?? null).then((stored) => {
          // Only the chat thread is the panel's business. A session records which
          // provider conversation it belongs to so history can rejoin it, and an
          // agent run's throwaway thread is not one anybody reopens.
          if (stored && scope === 'chat') {
            // `reqId` so the panel can file this against the conversation that
            // ASKED. It no longer freezes on the running chat, so by the time
            // this lands the user may well be looking at a different one, and
            // "whichever is on screen" would tie a provider thread to a chat
            // that never spoke to it.
            entry?.post({
              type: 'CONVERSATION',
              reqId: msg.reqId,
              providerId: msg.providerId,
              url: stored
            });
          }
        });
      }
    }

    if (!entry) return;

    entry.post({
      type: 'STREAM',
      reqId: msg.reqId,
      providerId: msg.providerId,
      state: msg.state,
      text: msg.text,
      error: msg.error,
      truncated: msg.truncated,
      // Something the run survived but the reader needs to know — an
      // attachment the provider would not take, so far. Not an error: the
      // answer still arrives, it was just written without part of the question.
      notice: msg.notice,
      attached: msg.attached
    });

    if (msg.state === 'done' || msg.state === 'error' || msg.state === 'need_login') {
      inflight.delete(streamKey(msg.reqId, msg.providerId));
      entry.settle?.();
    }
  });
}
