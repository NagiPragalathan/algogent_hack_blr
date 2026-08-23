/**
 * How hard this may lean on one provider, and when to stop leaning entirely.
 *
 * Three rules, and they are in increasing order of how much they actually
 * protect you.
 *
 * SPACING. The window path is self-limiting: opening a page, typing and waiting
 * for the DOM to settle takes ten to forty seconds whether anybody wants it to
 * or not. The direct path has no such floor, so an agent run can put its next
 * request in flight the instant the last reply ends, and compare mode plus a
 * title request can leave together in the same millisecond. A gap costs nothing
 * anyone notices — you cannot type a question in under a second — and it keeps a
 * personal client from producing bursts no person produces.
 *
 * VOLUME. This is the one that matters and the one the first version did not
 * have. Spacing bounds the RATE and says nothing about the TOTAL: at one request
 * a second, thirty seconds of agent run is thirty requests, and no amount of
 * jitter makes that look like somebody asking questions. A rolling hourly count
 * widens the gap as it climbs and stands the provider down before the total
 * reaches a number a person could not produce in an hour. Fewer requests is the
 * only thing here that genuinely reduces exposure; everything else is shaping.
 *
 * BACKING OFF. A 429 or a 403 is the provider saying, in the only way it has,
 * that it does not want this right now — and the worst possible response is the
 * obvious one, which is to try again. So that provider is stood down and its
 * questions go through the window instead, which still answers them. Repeat
 * push-backs escalate: coming back after five minutes to be refused again, over
 * and over, is a worse pattern than the burst that caused the first refusal.
 *
 * WHAT THIS IS NOT. It does not disguise anything, and it must not grow into
 * something that tries to. No user-agent shuffling, no proxying, no account
 * rotation, no fingerprint work. Every request here is the user's own session,
 * from their own browser, at a volume one person could plausibly produce — and
 * the honest way to lower the risk of that being unwelcome is to send less of it,
 * not to make it harder to attribute.
 */

/* -------------------------------------------------------------------------
 * State
 *
 * In `chrome.storage.session` rather than worker memory, which is a correction
 * rather than a refinement. MV3 tears the worker down after ~30s idle and the
 * gap between two questions is nearly always longer — so a five-minute cool-off
 * held in a module variable was, in practice, erased before it had ever expired.
 * The provider said 429, the worker slept, the next question rebuilt the module
 * with an empty map, and went straight back at it. The protection read as
 * working and was not there.
 *
 * The spacing timestamps are a different case and the old reasoning did hold for
 * them: a worker that has been asleep since the last call has already served the
 * gap. They are persisted anyway because they are in the same record, and
 * because the hourly count genuinely does need to survive.
 *
 * Memory-backed and gone when the browser closes, which is the right lifetime:
 * a cool-off should not outlive the session it was earned in, and it must
 * absolutely outlive the worker.
 * ---------------------------------------------------------------------- */

const KEY = 'directPace';

/** Everything we know, per provider id. Hydrated from storage, written back. */
let state = null;

/**
 * Storage is read-modify-write, and several turns can be gating at once —
 * compare mode fans out to four providers in the same tick. Every mutation goes
 * through this chain so two of them cannot both read the same record and write
 * back the later one's view, which is exactly the burst the spacing exists to
 * prevent.
 */
let queue = Promise.resolve();
const serial = (fn) => (queue = queue.then(fn, fn));

const blank = () => ({
  last: 0,
  recent: [],
  coolUntil: 0,
  coolReason: null,
  strikes: 0,
  lastStrike: 0,
  replyChars: 0
});

const entry = (providerId) => (state[providerId] ||= blank());

/**
 * Load the record into memory.
 *
 * Callers await this once before anything that reads the synchronous helpers
 * below. It exists because `engineFor` has to be able to ask "is this provider
 * stood down?" without a round trip — that check runs before the session is
 * resolved precisely so a stood-down provider costs nothing at all.
 */
export async function hydrate() {
  if (state) return;
  const stored = (await chrome.storage.session.get(KEY))[KEY];
  state = stored && typeof stored === 'object' ? stored : {};
}

const flush = () => chrome.storage.session.set({ [KEY]: state });

/* -------------------------------------------------------------------------
 * Spacing
 * ---------------------------------------------------------------------- */

/**
 * The floor between two questions typed by a person.
 *
 * Lowered from 1100ms on the user's explicit instruction: this is OUR caution
 * about a rate nobody complained about, not anything a provider asked for, and
 * it was the largest fixed cost on a path whose whole point is that it answers
 * in a second. Kept above zero because it still has a job — see UNSAFE_GAP_MS.
 */
const CHAT_GAP_MS = 400;

/**
 * The floor between two turns of an agent run, which is deliberately higher.
 *
 * A run is the volume path — thirty to forty round trips for one instruction,
 * back to back — so it was given the widest floor: 2.6s, on the reasoning that
 * a minute across a forty-step run is single-digit percent against provider
 * turns of ten to forty seconds each.
 *
 * That reasoning held while every run went through a window. It does not hold
 * now. A run on the fast path answers in two or three seconds a turn, and a
 * 2.6s gap in front of each of those is not single-digit percent of anything —
 * it is most of the wait. Lowered to 800ms on the user's explicit instruction.
 *
 * What is NOT lowered, and must not be: `coolOff`. The gap is this extension
 * being careful about a rate nobody objected to; a 429 or a 403 is the provider
 * having said no in the only way it has, and no setting and no instruction here
 * reaches that branch. The hourly ceiling stays too — it is what makes a
 * runaway loop visible.
 */
const RUN_GAP_MS = 800;

/**
 * The gap when the user has switched the holding back off.
 *
 * Not zero, because the thing being switched off is "behave like a person", not
 * "serialise at all". Simultaneous requests to one provider are a burst nobody
 * asked for and nobody benefits from — the answers still arrive one at a time.
 */
const UNSAFE_GAP_MS = 120;

/**
 * Time to have read the last answer.
 *
 * The gap that follows a two-thousand-character reply should not be the gap that
 * follows "ok" — a person is reading in between, and the pause after a long
 * answer is the most reliably human thing about this whole pattern. Capped,
 * because nobody reads the whole of a very long answer before following up.
 */
const READ_MS_PER_CHAR = 1.1;
const MAX_READ_MS = 2500;

/**
 * …and nobody is reading anything during an agent run.
 *
 * The read term models a person taking in the last answer before typing the
 * next thing, which is a fair model of a chat and a plainly false one of a
 * loop: what came back was a JSON action, it went to a parser, and the next
 * prompt was already being built. Charging up to seven seconds of imaginary
 * reading per turn was the single largest avoidable delay in a long run —
 * measured against a forty-step run, minutes of it.
 */
const READ_MS_PER_CHAR_RUN = 0;

/**
 * Jitter, log-normal rather than uniform.
 *
 * A fixed gap is its own signature — requests exactly 1100ms apart are as unlike
 * a person as requests 0ms apart, arguably more so, since nothing human is that
 * regular. Uniform jitter is better and still wrong in shape: real gaps between
 * one person's actions have a long right tail (most are short, some are much
 * longer), which a uniform band cannot produce. Clamped at both ends so the tail
 * cannot produce a thirty-second pause nobody asked for.
 */
function jitter() {
  // Box-Muller, then exponentiate: a standard normal in log space.
  const u = Math.random() || 1e-9;
  const v = Math.random() || 1e-9;
  const normal = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  // The tail is narrower than it was (3x -> 1.8x). A long right tail is the
  // most human-looking part of this, and it is also the part that occasionally
  // put eight seconds in front of a turn for no reason anybody could see.
  return Math.min(1.8, Math.max(0.7, Math.exp(normal * 0.28)));
}

/* -------------------------------------------------------------------------
 * Volume
 * ---------------------------------------------------------------------- */

const HOUR_MS = 60 * 60 * 1000;

/**
 * Where the hourly count starts costing, and where it stops being served.
 *
 * `SOFT` is not a limit, it is the point at which the gap starts widening —
 * asking forty-five things of one provider in an hour is a heavy but entirely
 * possible day, and it should get slower rather than fail. `HARD` is a number
 * one person does not reach by asking questions; reaching it means something is
 * looping, and standing down is both the safe response and the one that makes
 * the loop visible.
 */
const SOFT_PER_HOUR = 45;
const HARD_PER_HOUR = 110;

/** How much the gap is stretched at the hard limit, interpolated from soft. */
const MAX_VOLUME_STRETCH = 4;

/** Requests in the last hour, pruning the record as it counts. */
function recentCount(record, now) {
  record.recent = record.recent.filter((at) => now - at < HOUR_MS);
  return record.recent.length;
}

function volumeStretch(count) {
  if (count <= SOFT_PER_HOUR) return 1;
  const through = (count - SOFT_PER_HOUR) / (HARD_PER_HOUR - SOFT_PER_HOUR);
  return 1 + Math.min(1, through) * (MAX_VOLUME_STRETCH - 1);
}

/* -------------------------------------------------------------------------
 * Backing off
 * ---------------------------------------------------------------------- */

/**
 * How long a provider that pushed back is left alone, by how many times in a row
 * it has had to.
 *
 * Escalating rather than flat, because the flat version produces its own bad
 * pattern: refused, wait five, refused, wait five, refused — a client that keeps
 * coming back at a fixed interval to be told no is more conspicuous than the
 * burst that earned the first refusal, and it never gives whatever tripped time
 * to decay.
 */
const COOL_LADDER_MS = [5 * 60 * 1000, 15 * 60 * 1000, 45 * 60 * 1000, 2 * 60 * 60 * 1000];

/** Longest we will honour, including a `Retry-After` we were handed. */
const MAX_COOL_MS = 2 * 60 * 60 * 1000;

/**
 * Clean time after which the strike count resets.
 *
 * Without it the ladder is one-way: a provider that pushed back three times last
 * Tuesday would still start at forty-five minutes today, which is punishing the
 * user for a rate limit that has long since expired.
 */
const STRIKE_RESET_MS = 3 * 60 * 60 * 1000;

/* -------------------------------------------------------------------------
 * The API
 * ---------------------------------------------------------------------- */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait until it is polite to speak to this provider again.
 *
 * The slot is claimed BEFORE the wait, not after, so two calls arriving together
 * queue behind each other rather than both reading the same stale timestamp and
 * leaving side by side — which is the burst this exists to prevent.
 *
 * @param {string} providerId
 * @param {{ intent?: 'chat'|'run' }} options
 */
export async function gate(providerId, { intent = 'chat', safe = true } = {}) {
  await hydrate();

  let wait = 0;

  await serial(async () => {
    const now = Date.now();
    const record = entry(providerId);

    // Counted even when the holding back is switched off: the hourly total is
    // what the Options page reports, and a record with a hole in it would
    // under-report exactly the sessions that sent the most.
    const count = recentCount(record, now);

    const run = intent === 'run';
    const base = run ? RUN_GAP_MS : CHAT_GAP_MS;
    const read = run
      ? record.replyChars * READ_MS_PER_CHAR_RUN
      : Math.min(MAX_READ_MS, record.replyChars * READ_MS_PER_CHAR);

    /**
     * Off means off — but not zero.
     *
     * Two requests leaving in the same millisecond is not "fast", it is a burst
     * that costs nothing to avoid: compare mode fans out to four providers in
     * one tick and a title request rides along behind a question. `UNSAFE_GAP_MS`
     * is below anything a person would notice and still serialises them.
     */
    const gap = safe
      ? Math.round((base + read) * volumeStretch(count) * jitter())
      : UNSAFE_GAP_MS;

    // `last` is a claim on a future instant, not a record of the past, so a
    // second caller arriving mid-wait queues behind the first rather than
    // reading a timestamp that has not moved yet.
    const at = Math.max(now, record.last) + gap;
    wait = at - now;

    record.last = at;
    record.recent.push(at);
    record.replyChars = 0;

    await flush();
  });

  if (wait > 0) await sleep(wait);
}

/**
 * How long the last answer was, so the next gap can include time to read it.
 *
 * Best-effort and never awaited by the turn: this is the tail of a request that
 * has already succeeded, and a storage write must not be able to fail one.
 */
export function noteReply(providerId, chars) {
  if (!state) return;
  serial(async () => {
    entry(providerId).replyChars = Math.max(0, Number(chars) || 0);
    await flush();
  }).catch(() => {});
}

/**
 * Should we be talking to this provider at all?
 *
 * Synchronous, and read before the session is even resolved, so a stood-down
 * provider costs nothing — not a token fetch, not a proof of work, not a
 * request. Requires `hydrate()` to have been awaited; a cold read simply reports
 * "not cooling", which errs towards asking and is corrected on the next turn.
 */
export function coolingFor(providerId) {
  const until = state?.[providerId]?.coolUntil ?? 0;
  return Math.max(0, until - Date.now());
}

/** Why it is standing down — 'pushback' or 'budget'. */
export const coolingReason = (providerId) => state?.[providerId]?.coolReason ?? null;

/**
 * Stand a provider down after it pushed back.
 *
 * `Retry-After` wins when the provider sends one and it is longer than our own
 * ladder — it is the provider naming its own terms, and guessing shorter than it
 * asked for is the one way to make a rate limit worse. Capped, so a malformed or
 * punitive value cannot switch the fast path off for a whole session without
 * anybody understanding why.
 */
export function coolOff(providerId, retryAfterSeconds = null) {
  const now = Date.now();
  const record = state ? entry(providerId) : blank();

  // A long clean spell means the last quarrel is over; start again at the bottom
  // of the ladder rather than where it left off.
  if (record.lastStrike && now - record.lastStrike > STRIKE_RESET_MS) record.strikes = 0;

  const rung = COOL_LADDER_MS[Math.min(record.strikes, COOL_LADDER_MS.length - 1)];
  const asked = Number(retryAfterSeconds) * 1000;
  const ms = Math.min(MAX_COOL_MS, Math.max(rung, Number.isFinite(asked) && asked > 0 ? asked : 0));

  record.strikes += 1;
  record.lastStrike = now;
  record.coolUntil = now + ms;
  record.coolReason = 'pushback';

  if (state) serial(flush).catch(() => {});
  return ms;
}

/**
 * Stand a provider down because WE have asked too much of it, not because it
 * complained.
 *
 * The distinction is worth keeping in the record: a push-back is the provider's
 * decision and escalates, while running out of budget is ours and does not — it
 * clears when the hour rolls forward and carries no strike.
 */
function coolForBudget(record, now, count) {
  const oldest = record.recent[0] ?? now;
  record.coolUntil = oldest + HOUR_MS;
  record.coolReason = 'budget';
  return count;
}

/**
 * Has this provider had enough for now?
 *
 * Checked alongside the cool-off, and separately from `gate` because it must be
 * answerable before any work is done rather than while waiting to do it.
 */
export function overBudget(providerId, safe = true) {
  // The ceiling is part of the holding back, so it goes with it. The cool-off
  // after a push-back does NOT — see `coolOff`, which no setting reaches.
  if (!safe) return false;
  if (!state?.[providerId]) return false;

  const now = Date.now();
  const record = state[providerId];
  const count = recentCount(record, now);

  if (count < HARD_PER_HOUR) return false;

  coolForBudget(record, now, count);
  serial(flush).catch(() => {});
  return true;
}

/** For the Options page: what this provider's last hour has looked like. */
export function paceStatus(providerId) {
  const record = state?.[providerId];
  if (!record) return { inLastHour: 0, coolingMs: 0, reason: null, strikes: 0 };

  return {
    inLastHour: recentCount(record, Date.now()),
    coolingMs: coolingFor(providerId),
    reason: record.coolReason,
    strikes: record.strikes,
    softLimit: SOFT_PER_HOUR,
    hardLimit: HARD_PER_HOUR
  };
}

/**
 * There is deliberately no reset.
 *
 * A "clear the pace record" button is a button that clears a cool-off, and the
 * only reason to press it is to go back at a provider that has just asked to be
 * left alone. Everything here expires on its own — the hourly count rolls
 * forward, the ladder resets after a clean spell, and the whole record dies with
 * the browser. Nothing needs a lever, and one would only ever be pulled for the
 * one purpose this file exists to prevent.
 */
