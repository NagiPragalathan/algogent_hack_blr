/** The numbers that bound a run. Shared by the loop and the prompt. */

/**
 * 24 was a budget for one-thing tasks ("what does this page say"). It is half a
 * task for the ones people actually give an agent — "apply to five jobs here"
 * spends four or five steps per item on a dialog with its own fields, and the
 * run died mid-way through the third with a summary that read like success.
 */
export const MAX_STEPS = 40;

/**
 * Page text budget per observation. Small on purpose: an agent takes many
 * steps, and a full page on every one of them buries the element list.
 */
export const OBSERVE_CHARS = 3500;

/**
 * The budget for an observation the model asked to be deep, which is a
 * different thing: it paid several seconds of scrolling for it, so cutting it
 * back to OBSERVE_CHARS would throw away everything the scrolling bought. It is
 * far too much for one turn to read carefully, which is what `read.js` is for.
 */
export const DEEP_OBSERVE_CHARS = 45000;

/** How long a deep observation may spend scrolling the user's own tab. */
export const DEEP_OBSERVE_MS = 9000;

/**
 * Above this, an observation is read in parts instead of being handed over
 * whole. Below it a single turn reads the thing properly and the extra round
 * trips would be pure latency.
 */
export const SCAN_PART_CHARS = 7000;

/** Reading turns one observation may cost. Each one is a full round trip. */
export const MAX_SCAN_PARTS = 8;

/**
 * Replies in a row that carried no action before the run stops trying to get
 * one. One is a formatting slip worth correcting; two in a row means the model
 * has decided it is answering rather than acting, and a third identical nudge
 * only spends steps to arrive at the same place.
 */
export const MAX_MISREADS = 2;

/**
 * How many screenshots the loop may take on its own initiative in one run.
 *
 * A picture is the most expensive thing in a turn — a tab activation, a paint
 * wait, and a large share of the provider's attention — so vision is rationed
 * and spent on the steps where the element list has stopped explaining the
 * page. A run that needs more looks than this is lost, not under-informed.
 */
export const MAX_AUTO_LOOKS = 6;

/**
 * Extra screenshots reserved for a form that keeps rejecting what was typed.
 *
 * Their own budget because they arrive late and matter most: a form fight is
 * ten steps in, the ordinary allowance is usually spent by then, and this is
 * precisely the state the element list cannot describe — a field with a value
 * in it and a red error under it looks, in text, exactly like a field with a
 * value in it. Measured on a Workday application: filled name, filled address,
 * "Save and Continue", errors, click, type, "Save and Continue", the same
 * errors, five times over, because nothing in the loop ever showed the model
 * what the page was complaining about.
 */
export const MAX_ERROR_LOOKS = 3;

/**
 * Screenfuls a whole-page screenshot may stitch together.
 *
 * Six is about four thousand pixels of page, which is a long form or a full
 * receipt — past that a stitched JPEG is a slow upload for a picture the model
 * downscales anyway, and each extra tile costs another half-second to the
 * capture rate limit. A page taller than this is one to read, not photograph.
 */
export const MAX_FULL_SHOTS = 6;

/**
 * Actions one reply may carry.
 *
 * The loop used to be strictly one action per provider round trip, and a round
 * trip here is ten to forty seconds — so filling an eight-field form cost eight
 * of them, most spent re-deciding something that was already decided when the
 * form was first read. When the whole sequence is visible in one observation
 * (type, type, type, submit) there is nothing to re-decide between the parts.
 *
 * Sixteen, because a real application form is ten to fifteen fields plus a
 * submit, and twelve left the tail of exactly that page for a second round
 * trip — one spent re-deciding what the first had already worked out. Typing
 * into a plain field is the safe case that makes a longer batch worth it: it
 * changes a value, not the page, so the ids the rest of the plan depends on
 * all survive.
 *
 * The survey turn in `plan.js` is what makes a batch this long safe rather
 * than merely long. A model batching from one screenful is guessing about the
 * back half of its own plan; a model batching from a route it worked out
 * against a picture of the whole page is executing something it has already
 * checked. Raising this without the plan turn would buy longer replies and
 * more of them truncated, which is the opposite of the point.
 *
 * Not unbounded, though. A batch is only as good as the observation it was
 * planned from; anything that *replaces* the page — a submit, a navigation, a
 * dialog, a field that answers with a list — ends it there, and a long batch is
 * also a long reply, which is the other thing that gets truncated mid-render.
 * The first failure abandons the rest and re-observes.
 */
export const MAX_BATCH_ACTIONS = 16;

/**
 * A beat before each on-page action, so the pointer's travel is visible.
 *
 * The pointer animates for 220ms and a batch used to fire every action inside
 * one frame of that, so it teleported and the page appeared to change on its
 * own. 420ms is enough to read a move as a move without turning a sixteen
 * action batch into a wait — that is under seven seconds of pacing against a
 * provider round trip of ten to forty.
 *
 * Gated on the `agentPacing` setting, because it IS real time and someone who
 * trusts the run should be able to have the speed instead.
 */
export const AGENT_BEAT_MS = 420;
