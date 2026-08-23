/**
 * Register every agent ACTION as a payable agent.
 *
 *   DATABASE_URL="…" OWNER_ADDRESS="…" node db/seed-actions.mjs
 *
 * The run's whole vocabulary — navigate, read_url, click, type, screenshot and
 * the rest — is one agent each, so a run's receipt has a line per step the user
 * watched happen rather than one lump sum for "the agent".
 *
 * All of them at ONE flat price. Pricing `navigate` differently from `read_url`
 * invites an argument about which is worth more that nobody can settle, and the
 * number a user actually watches is the run total; a flat rate also makes every
 * receipt line comparable without reading a price list first.
 *
 * Re-running this is an update, not a duplicate — `register` upserts on id, and
 * only for the same owner.
 */
import { neon } from '@neondatabase/serverless';
import algosdk from 'algosdk';

const url = process.env.DATABASE_URL;
const owner = (process.env.OWNER_ADDRESS || '').trim();
const price = Number(process.env.ACTION_PRICE_MICRO_ALGO ?? 1_000);
const network = process.env.X402_NETWORK || 'testnet';

if (!url) throw new Error('DATABASE_URL is not set');
if (!algosdk.isValidAddress(owner)) throw new Error(`OWNER_ADDRESS is not a valid address: ${owner}`);
if (!Number.isInteger(price) || price <= 0) throw new Error(`bad ACTION_PRICE_MICRO_ALGO: ${price}`);

const sql = neon(url);

/**
 * The action vocabulary, from src/background/agent/protocol.js.
 *
 * The ids are prefixed `act-` so they cannot collide with a skill id (`p-…`) or
 * with anything a developer registers — a run's own plumbing and a published
 * skill are different things that happen to share one table.
 */
const ACTIONS = [
  ['act-navigate',   'Navigate',        'Go to a URL in the current tab'],
  ['act-open-tab',   'Open tab',        'Open a URL in a new tab and switch to it'],
  ['act-switch-tab', 'Switch tab',      'Move the run to another of its tabs'],
  ['act-list-tabs',  'List tabs',       'Report the tabs this run may work on'],
  ['act-back',       'Back',            'Go back one page'],
  ['act-read-url',   'Read URL',        'Fetch a page as text without opening it'],
  ['act-observe',    'Observe',         'Read the page and index its controls'],
  ['act-screenshot', 'Screenshot',      'Capture the page as an image'],
  ['act-click',      'Click',           'Click a numbered element'],
  ['act-click-at',   'Click at point',  'Click a coordinate in the screenshot'],
  ['act-type',       'Type',            'Type into a field, optionally submitting'],
  ['act-select',     'Select',          'Choose an option in a dropdown'],
  ['act-scroll',     'Scroll',          'Scroll the page or the open dialog'],
  ['act-upload',     'Upload',          'Put an attached file into a file input'],
  ['act-use-frame',  'Use frame',       'Enter or leave an iframe'],
  ['act-wait',       'Wait',            'Wait for the page to settle'],
  ['act-ask',        'Ask the user',    'Put a question to the user and wait'],
  ['act-finish',     'Finish',          'Write the final answer']
];

const [developer] = await sql`
  INSERT INTO developers (payout_address, display_name)
  VALUES (${owner}, ${'Agent runtime'})
  ON CONFLICT (payout_address) DO UPDATE
     SET display_name = COALESCE(developers.display_name, EXCLUDED.display_name)
  RETURNING id, payout_address`;

console.log(`developer #${developer.id} → ${developer.payout_address}\n`);

for (const [id, name, description] of ACTIONS) {
  const [row] = await sql`
    INSERT INTO agents (id, developer_id, name, description, price_micro_algo, network)
    VALUES (${id}, ${developer.id}, ${name}, ${description}, ${price}, ${network})
    ON CONFLICT (id) DO UPDATE
       SET name = EXCLUDED.name,
           description = EXCLUDED.description,
           price_micro_algo = EXCLUDED.price_micro_algo,
           network = EXCLUDED.network,
           status = 'live',
           updated_at = now()
     WHERE agents.developer_id = ${developer.id}
    RETURNING id, price_micro_algo`;

  console.log(
    row
      ? `  ok      ${id.padEnd(16)} ${(Number(row.price_micro_algo) / 1e6).toFixed(6)} ALGO`
      : `  SKIP    ${id.padEnd(16)} owned by a different address`
  );
}

const [{ count }] = await sql`
  SELECT COUNT(*)::int AS count FROM agents
   WHERE developer_id = ${developer.id} AND status = 'live'`;

console.log(`\n${count} live agents owned by ${owner}`);
console.log(`flat price: ${(price / 1e6).toFixed(6)} ALGO per action`);
console.log(`network fee adds ${(1000 / 1e6).toFixed(6)} ALGO per action leg`);
