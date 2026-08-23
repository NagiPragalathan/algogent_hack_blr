/**
 * Build a shareable, obfuscated copy of the extension into `dist/`.
 *
 * This is NOT a build step for running the extension. The repo itself stays
 * dependency-free and loads unpacked exactly as before (see AGENTS.md); this
 * exists only to hand someone a copy they can install but cannot comfortably
 * read or lift code out of. Nothing under `tools/` ships.
 *
 * What it does, and why each part is the way it is:
 *
 * The three ES-module entries are BUNDLED first. That is most of the actual
 * protection: forty named files with explanatory headers collapse into one
 * anonymous blob, and the module graph — which is the map of how the thing
 * works — stops existing. Obfuscating each module separately would be far
 * weaker and would risk renaming a binding on one side of an import and not
 * the other.
 *
 * The classic scripts are NOT bundled. `src/content/*.js` and
 * `src/adapters/adapter.js` cannot use ES modules and are injected by path
 * from several call sites, so their filenames are load-bearing.
 *
 * `renameGlobals` is off everywhere. The two content scripts share one
 * isolated world, so a top-level name in one is reachable from the other;
 * renaming them independently would break that silently. `identifiersPrefix`
 * is set per file for the same reason — two files obfuscated in the same
 * global scope must not both generate a helper called `_0x3a1f`.
 *
 * The background bundle gets a WEAKER profile on purpose: `stringArray` is
 * off for it. `visibilitySpoof` in transport/keep-awake.js and the two inline
 * `func:` injections are handed to `chrome.scripting.executeScript`, which
 * serialises them with `toString()` and runs them in another world. A string
 * hoisted into a module-level array is simply not there when that happens, so
 * the function throws a ReferenceError in the provider tab — and the only
 * symptom would be the anti-throttle layer quietly not working.
 *
 * Control-flow flattening and dead-code injection are off everywhere. Both
 * cost real runtime speed for a deterrent this does not need.
 *
 *   cd tools && npm install && npm run package
 */

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const obfuscator = require('javascript-obfuscator');
const esbuild = require('esbuild');
const JSZip = require('jszip');

const TOOLS = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TOOLS, '..');
const DIST = path.join(ROOT, 'dist');

/** Bundled with esbuild, then obfuscated. Paths are kept so the manifest and every HTML tag still resolve. */
const MODULE_ENTRIES = [
  'src/background/service-worker.js',
  'src/sidepanel/sidepanel.js',
  'src/options/options.js'
];

/**
 * Classic scripts: obfuscated where they stand.
 *
 * `prefix` keeps two files that end up in one global scope from generating the
 * same helper name. `world` marks the ones sharing the content-script isolated
 * world, which is only documentation — the profile is the same.
 */
const CLASSIC = [
  { file: 'src/content/page-context.js', prefix: 'pc_' },
  { file: 'src/content/agent-page.js', prefix: 'ap_' },
  { file: 'src/adapters/adapter.js', prefix: 'ad_' },
  { file: 'src/offscreen/offscreen.js', prefix: 'of_' }
];

/** Copied verbatim. Anything not listed here and not produced above does not ship. */
const ASSETS = [
  'manifest.json',
  'icons',
  'rules',
  'src/sidepanel/sidepanel.html',
  'src/sidepanel/sidepanel.css',
  'src/sidepanel/styles',
  'src/options/options.html',
  'src/options/options.css',
  'src/offscreen/offscreen.html'
];

/** Never ships: the notes are the thing being withheld, and _metadata is Chrome's, not ours. */
const NEVER = ['.git', '.playwright-mcp', '_metadata', 'AGENTS.md', 'CLAUDE.md', 'note.txt', 'tools', 'dist'];

const BASE = {
  compact: true,
  simplify: true,
  identifierNamesGenerator: 'mangled-shuffled',
  renameGlobals: false,
  controlFlowFlattening: false,
  deadCodeInjection: false,
  transformObjectKeys: false,
  numbersToExpressions: false,
  selfDefending: false,
  debugProtection: false,
  disableConsoleOutput: false,
  unicodeEscapeSequence: false,
  target: 'browser'
};

/** Full strength. Safe anywhere no function is stringified out of the file. */
const STRONG = {
  ...BASE,
  stringArray: true,
  stringArrayThreshold: 0.8,
  stringArrayEncoding: ['base64'],
  stringArrayCallsTransform: true,
  stringArrayWrappersCount: 2,
  stringArrayWrappersType: 'function',
  splitStrings: true,
  splitStringsChunkLength: 8
};

/** For the background bundle. See the header: its strings have to stay literal. */
const NO_STRING_ARRAY = { ...BASE, stringArray: false, splitStrings: false };

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

function copyInto(rel) {
  const from = path.join(ROOT, rel);
  const to = path.join(DIST, rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true });
}

/**
 * Strip comments from markup and stylesheets.
 *
 * Not obfuscation — the panel's HTML and CSS carry the same explanatory
 * comments the JS does, and leaving them in would hand back in prose what the
 * mangling just took away.
 */
function stripComments(file) {
  const ext = path.extname(file);
  let text = fs.readFileSync(file, 'utf8');
  if (ext === '.html') text = text.replace(/<!--[\s\S]*?-->/g, '');
  // CSS only: a naive /* */ strip would eat a `//` URL or a regex in JS.
  if (ext === '.css') text = text.replace(/\/\*[\s\S]*?\*\//g, '');
  fs.writeFileSync(file, text);
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

async function main() {
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });

  log('assets');
  for (const rel of ASSETS) copyInto(rel);

  log('bundling modules');
  for (const rel of MODULE_ENTRIES) {
    const out = path.join(DIST, rel);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    await esbuild.build({
      entryPoints: [path.join(ROOT, rel)],
      outfile: out,
      bundle: true,
      format: 'esm',
      target: 'chrome116',
      minify: true,
      legalComments: 'none',
      logLevel: 'warning'
    });
    const isBackground = rel.includes('/background/');
    const profile = isBackground ? NO_STRING_ARRAY : STRONG;
    const code = obfuscator
      .obfuscate(fs.readFileSync(out, 'utf8'), {
        ...profile,
        identifiersPrefix: `_${path.basename(rel, '.js').replace(/\W/g, '')}_`
      })
      .getObfuscatedCode();
    fs.writeFileSync(out, code);
    log(`  ${rel}  ${isBackground ? '(no string array — stringified injections)' : ''}`);
  }

  log('obfuscating classic scripts');
  for (const { file, prefix } of CLASSIC) {
    const out = path.join(DIST, file);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const code = obfuscator
      .obfuscate(fs.readFileSync(path.join(ROOT, file), 'utf8'), {
        ...STRONG,
        identifiersPrefix: `_${prefix}`
      })
      .getObfuscatedCode();
    fs.writeFileSync(out, code);
    log(`  ${file}`);
  }

  log('stripping markup comments');
  for (const file of walk(DIST)) {
    if (file.endsWith('.html') || file.endsWith('.css')) stripComments(file);
  }

  log('checking syntax');
  for (const file of walk(DIST)) {
    if (!file.endsWith('.js')) continue;
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  }

  const version = JSON.parse(fs.readFileSync(path.join(DIST, 'manifest.json'), 'utf8')).version;
  const zip = path.join(ROOT, `sidebar-ai-${version}.zip`);
  fs.rmSync(zip, { force: true });
  log('zipping');

  // Written with JSZip rather than PowerShell's Compress-Archive, which emits
  // Windows separators into the entry names. The ZIP spec requires '/', and a
  // backslash archive extracts on macOS and Linux as a handful of flat files
  // literally called `src\content\agent-page.js` — so the manifest's paths
  // resolve to nothing and Chrome refuses the folder. It happens to survive
  // Windows-to-Windows, which is exactly what makes it easy to ship broken.
  const archive = new JSZip();
  for (const file of walk(DIST)) {
    const name = path.relative(DIST, file).split(path.sep).join('/');
    archive.file(name, fs.readFileSync(file));
  }
  const buffer = await archive.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 }
  });
  fs.writeFileSync(zip, buffer);

  const bad = Object.keys(archive.files).filter((n) => n.includes('\\'));
  if (bad.length) throw new Error(`backslash entries in archive: ${bad.join(', ')}`);

  const bytes = fs.statSync(zip).size;
  log(`\n${path.basename(zip)}  ${(bytes / 1024 / 1024).toFixed(2)} MB`);
  log(`excluded: ${NEVER.join(', ')}`);
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err}\n`);
  process.exit(1);
});
