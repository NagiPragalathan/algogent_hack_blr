/**
 * The browser agent.
 *
 *   limits.js     the two numbers that bound a run
 *   protocol.js   what the model may ask for, and how its reply is parsed
 *   page.js       reaching into a tab: observe, settle, screenshot
 *   actions.js    carrying out one action, and the approval gate
 *   loop.js       the driver that ties those together
 *
 * Import from here rather than from the parts, so the seams stay ours to move.
 */

export { runAgent } from './loop.js';
export { parseAction } from './protocol.js';
export { MAX_STEPS, OBSERVE_CHARS } from './limits.js';
