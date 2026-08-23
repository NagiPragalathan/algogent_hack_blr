/**
 * Syntax highlighting, in about a hundred lines and with no dependencies.
 *
 * There is no build step here and no network to pull a highlighter from, so
 * this is a hand-rolled scanner rather than Prism or hljs. That trade is
 * deliberate and it has a ceiling: this colours the shapes that make code
 * readable at a glance — comments, strings, numbers, keywords, call names — and
 * it does not parse. It will not know that a keyword is being used as a
 * property name, and it does not need to.
 *
 * SAFETY: the scanner runs on RAW code and escapes every character it emits,
 * token or not. Highlighting escaped text instead would mean matching against
 * `&lt;` and `&amp;`, where one regex that spans an entity turns provider text
 * into markup. Nothing here ever inserts a character it did not escape.
 */

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (str) => String(str).replace(/[&<>"']/g, (c) => ESCAPES[c]);

const words = (list) => new RegExp(`\\b(?:${list.join('|')})\\b`, 'y');

const JS_KEYWORDS = [
  'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger',
  'default', 'delete', 'do', 'else', 'export', 'extends', 'finally', 'for', 'from',
  'function', 'get', 'if', 'import', 'in', 'instanceof', 'let', 'new', 'of', 'return',
  'set', 'static', 'super', 'switch', 'this', 'throw', 'try', 'typeof', 'var', 'void',
  'while', 'yield', 'interface', 'type', 'enum', 'implements', 'public', 'private',
  'readonly'
];

const PY_KEYWORDS = [
  'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del',
  'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in',
  'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while',
  'with', 'yield', 'match', 'case'
];

const SQL_KEYWORDS = [
  'select', 'from', 'where', 'insert', 'into', 'values', 'update', 'set', 'delete',
  'join', 'left', 'right', 'inner', 'outer', 'on', 'group', 'order', 'by', 'having',
  'limit', 'offset', 'create', 'table', 'alter', 'drop', 'index', 'primary', 'key',
  'foreign', 'references', 'and', 'or', 'not', 'null', 'as', 'distinct', 'union', 'case',
  'when', 'then', 'end'
];

const SH_KEYWORDS = [
  'if', 'then', 'else', 'elif', 'fi', 'for', 'in', 'do', 'done', 'while', 'case',
  'esac', 'function', 'return', 'export', 'local', 'echo', 'cd', 'set', 'source'
];

/** Anything not listed falls through to `common`, which is still readable. */
const COMMON = [
  ['com', /#[^\n]*|\/\/[^\n]*|\/\*[\s\S]*?\*\//y],
  ['str', /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/y],
  ['num', /\b\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?\b/iy],
  ['punc', /[{}[\]().,;:]/y]
];

const LANGUAGES = {
  js: [
    ['com', /\/\/[^\n]*|\/\*[\s\S]*?\*\//y],
    ['str', /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/y],
    ['num', /\b\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?\b/iy],
    ['lit', words(['true', 'false', 'null', 'undefined', 'NaN', 'Infinity'])],
    ['kw', words(JS_KEYWORDS)],
    ['fn', /[A-Za-z_$][\w$]*(?=\s*\()/y],
    ['op', /=>|[+\-*/%<>=!&|?^~]+/y],
    ['punc', /[{}[\]().,;:]/y]
  ],
  python: [
    ['com', /#[^\n]*/y],
    ['str', /[frbu]{0,2}(?:"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')/iy],
    ['dec', /@[\w.]+/y],
    ['num', /\b\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?\b/iy],
    ['lit', words(['True', 'False', 'None', 'self', 'cls'])],
    ['kw', words(PY_KEYWORDS)],
    ['fn', /[A-Za-z_][\w]*(?=\s*\()/y],
    ['op', /[+\-*/%<>=!&|^~]+/y],
    ['punc', /[{}[\]().,;:]/y]
  ],
  css: [
    ['com', /\/\*[\s\S]*?\*\//y],
    ['str', /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/y],
    ['kw', /@[\w-]+/y],
    ['prop', /[-a-z]+(?=\s*:)/iy],
    ['sel', /[.#][\w-]+|::?[\w-]+(?:\([^)]*\))?|&/y],
    ['num', /#[0-9a-f]{3,8}\b|\b\d*\.?\d+(?:px|rem|em|%|s|ms|vh|vw|fr|deg|ch|ex|pt)?\b/iy],
    ['fn', /[\w-]+(?=\()/y],
    ['var', /--[\w-]+/y],
    ['punc', /[{}[\]().,;:]/y]
  ],
  html: [
    ['com', /<!--[\s\S]*?-->/y],
    ['tag', /<\/?[\w-]+|\/?>/y],
    ['attr', /[\w-]+(?==)/y],
    ['str', /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/y],
    ['punc', /[=]/y]
  ],
  json: [
    ['prop', /"(?:[^"\\\n]|\\.)*"(?=\s*:)/y],
    ['str', /"(?:[^"\\\n]|\\.)*"/y],
    ['num', /-?\b\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?\b/iy],
    ['lit', words(['true', 'false', 'null'])],
    ['punc', /[{}[\]().,;:]/y]
  ],
  bash: [
    ['com', /#[^\n]*/y],
    ['str', /"(?:[^"\\]|\\.)*"|'[^']*'/y],
    ['var', /\$\{[^}]*\}|\$\w+/y],
    ['kw', words(SH_KEYWORDS)],
    ['op', /--?[\w-]+/y],
    ['num', /\b\d+\b/y],
    ['punc', /[{}[\]().,;:|&<>]/y]
  ],
  sql: [
    ['com', /--[^\n]*|\/\*[\s\S]*?\*\//y],
    ['str', /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/y],
    ['kw', new RegExp(`\\b(?:${SQL_KEYWORDS.join('|')})\\b`, 'iy')],
    ['num', /\b\d+(?:\.\d+)?\b/y],
    ['fn', /[A-Za-z_][\w]*(?=\s*\()/y],
    ['punc', /[{}[\]().,;:*]/y]
  ],
  common: COMMON
};

/** Spellings a provider actually emits after the opening fence. */
const ALIASES = {
  javascript: 'js', jsx: 'js', ts: 'js', typescript: 'js', tsx: 'js', mjs: 'js', node: 'js',
  py: 'python', python3: 'python',
  scss: 'css', less: 'css', sass: 'css',
  xml: 'html', svg: 'html', vue: 'html', htm: 'html',
  sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash', terminal: 'bash',
  psql: 'sql', mysql: 'sql'
};

/** The label shown on the block, canonicalised but not renamed beyond aliases. */
export function languageName(lang) {
  if (!lang) return '';
  const key = String(lang).toLowerCase();
  return ALIASES[key] || key;
}

/**
 * Escaped, highlighted HTML for one code block.
 *
 * Unknown or missing languages still go through `common`: strings, numbers and
 * comments carry most of the readability, and guessing a language wrongly is
 * worse than colouring the parts every language agrees on.
 */
export function highlight(code, lang) {
  const rules = LANGUAGES[languageName(lang)] || LANGUAGES.common;
  const text = String(code);
  let out = '';
  let i = 0;

  outer: while (i < text.length) {
    for (const [cls, re] of rules) {
      re.lastIndex = i;
      const match = re.exec(text);
      // Sticky regexes only match at lastIndex, so a match here is a match
      // starting exactly at the cursor — no scanning ahead and no overlap.
      if (match && match[0]) {
        out += `<span class="tok-${cls}">${esc(match[0])}</span>`;
        i += match[0].length;
        continue outer;
      }
    }
    // Whitespace, identifiers, and anything no rule claimed.
    out += esc(text[i]);
    i += 1;
  }

  return out;
}
