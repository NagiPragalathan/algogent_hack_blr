/**
 * Push the deployment's environment to Vercel, from the local .env.
 *
 *   npm run vercel:env            # all three environments
 *   npm run vercel:env -- preview # just one
 *
 * Only DATABASE_URL actually has to be here. Everything else the payments layer
 * needs — the company payout address, the split, the network, the per-action
 * price — is hardcoded in api/_lib/config.js, because none of it is a secret
 * and a deploy that 500s until someone remembers four dashboard fields is a
 * deploy that fails in front of people.
 *
 * DATABASE_URL is different and stays out of the repo: it is a live write
 * credential, this repository is public on GitHub, and committing it hands
 * anyone who reads the repo full access to the database. Rotating it afterwards
 * does not un-publish it.
 *
 * Requires `vercel login` first — the CLI needs a browser, so this cannot be
 * done unattended.
 */
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const envPath = join(here, '..', '.env');

if (!existsSync(envPath)) {
  console.error('site/.env does not exist. Copy .env.example and fill in DATABASE_URL.');
  process.exit(1);
}

const values = Object.fromEntries(
  readFileSync(envPath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const at = line.indexOf('=');
      return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
    })
);

/** The only one without a hardcoded default. The rest are pushed if present. */
const REQUIRED = ['DATABASE_URL'];
const OPTIONAL = [
  'COMPANY_PAYOUT_ADDRESS',
  'COMPANY_FEE_BPS',
  'X402_NETWORK',
  'ACTION_PRICE_MICRO_ALGO',
  'ALGOD_URL',
  'ALGOD_TOKEN',
  /**
   * The other secret, and the reason this list is not just DATABASE_URL any
   * more. Without it on the deployment the endpoint reports "no client account
   * is configured" and the extension quietly falls back to prompting a wallet
   * — which works, and looks exactly like the switch doing nothing.
   */
  'CLIENT_MNEMONIC',
  'X402_AUTOSIGN',
  'X402_AUTOSIGN_MAINNET'
];

const missing = REQUIRED.filter((k) => !values[k]);
if (missing.length) {
  console.error(`site/.env is missing: ${missing.join(', ')}`);
  process.exit(1);
}

const targets = process.argv[2] ? [process.argv[2]] : ['production', 'preview', 'development'];

for (const key of [...REQUIRED, ...OPTIONAL]) {
  if (!values[key]) continue;

  for (const target of targets) {
    try {
      // `vercel env add` reads the VALUE from stdin, which keeps it off the
      // process list — a secret passed as an argv is visible to every other
      // process on the machine.
      execFileSync('npx', ['--yes', 'vercel', 'env', 'add', key, target], {
        input: values[key],
        stdio: ['pipe', 'inherit', 'inherit'],
        shell: process.platform === 'win32'
      });
      console.log(`  set ${key} → ${target}`);
    } catch {
      // Already set is the usual reason, and it is not a failure worth stopping
      // for — `vercel env rm` then re-run if a value genuinely needs replacing.
      console.log(`  skip ${key} → ${target} (already set, or the CLI refused)`);
    }
  }
}

console.log('\nRedeploy for these to take effect: npx vercel --prod');
