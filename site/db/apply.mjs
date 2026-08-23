/**
 * Apply db/schema.sql to the database in DATABASE_URL.
 *
 *   DATABASE_URL="postgres://…" node db/apply.mjs
 *
 * Every statement is IF NOT EXISTS / OR REPLACE, so this is safe to re-run —
 * which is the point: it is the one way the schema gets applied, rather than
 * someone pasting into a console and the file drifting from the database.
 *
 * The neon() driver sends one statement per round trip, so the file is split
 * rather than shipped whole.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { neon } from '@neondatabase/serverless';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const sql = neon(url);
const text = readFileSync(join(here, 'schema.sql'), 'utf8');

const statements = text
  .split(/;\s*$/m)
  .map((s) => s.trim())
  .filter((s) => s && !s.split('\n').every((line) => line.trim().startsWith('--')));

let applied = 0;
for (const [i, statement] of statements.entries()) {
  const head = statement.replace(/--[^\n]*\n/g, '').trim().split('\n')[0].slice(0, 70);
  try {
    await sql.query(statement);
    applied += 1;
    console.log(`ok   [${i + 1}/${statements.length}] ${head}`);
  } catch (error) {
    console.error(`FAIL [${i + 1}/${statements.length}] ${head}\n     ${error.message}`);
    process.exit(1);
  }
}

const tables = await sql`
  SELECT table_name FROM information_schema.tables
   WHERE table_schema = 'public'
   ORDER BY table_name`;

console.log(`\n${applied} statements applied.`);
console.log('tables:', tables.map((t) => t.table_name).join(', ') || '(none)');
