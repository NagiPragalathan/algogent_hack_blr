/**
 * The proof-of-work ChatGPT's backend asks for before it will read a message,
 * and the SHA3-512 it is built on.
 *
 * WebCrypto stops at SHA-2, so Keccak is written out here. It is the one piece
 * of this path that is verifiable offline — the published SHA3-512 vectors
 * check it — which is worth knowing when something fails: it is never the hash.
 *
 * The proof itself is the guessiest code in the extension. The shape below —
 * base64 of a small config array, hashed with a server seed until the hex
 * digest sorts below a server difficulty, prefixed `gAAAAAB` — is what the web
 * client does, but the exact config contents are OpenAI's and they change them.
 * When the endpoint starts refusing proofs, `configFor` is the suspect. A
 * refusal is not fatal: `index.js` falls back to the relay window, which drives
 * the same page a human would.
 */

const MASK = (1n << 64n) - 1n;

const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n
];

/** Rotation offsets, indexed [x][y]. */
const ROT = [
  [0n, 36n, 3n, 41n, 18n],
  [1n, 44n, 10n, 45n, 2n],
  [62n, 6n, 43n, 15n, 61n],
  [28n, 55n, 25n, 21n, 56n],
  [27n, 20n, 39n, 8n, 14n]
];

const rotl = (value, n) => (n === 0n ? value : ((value << n) | (value >> (64n - n))) & MASK);

function keccakF(state) {
  for (let round = 0; round < 24; round++) {
    const C = new Array(5);
    for (let x = 0; x < 5; x++) {
      C[x] = state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20];
    }
    for (let x = 0; x < 5; x++) {
      const D = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1n);
      for (let y = 0; y < 5; y++) state[x + 5 * y] ^= D;
    }

    const B = new Array(25).fill(0n);
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(state[x + 5 * y], ROT[x][y]);
      }
    }

    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        state[x + 5 * y] =
          B[x + 5 * y] ^ ((~B[((x + 1) % 5) + 5 * y] & MASK) & B[((x + 2) % 5) + 5 * y]);
      }
    }

    state[0] ^= RC[round];
  }
}

const RATE = 72; // SHA3-512: 1600 bits of state, 1024 of capacity

/** @param {Uint8Array} input @returns {string} lowercase hex digest */
export function sha3_512(input) {
  const padded = new Uint8Array(Math.ceil((input.length + 1) / RATE) * RATE);
  padded.set(input);
  padded[input.length] = 0x06;       // SHA-3 domain separation
  padded[padded.length - 1] |= 0x80; // the final bit of the pad10*1

  const state = new Array(25).fill(0n);

  for (let offset = 0; offset < padded.length; offset += RATE) {
    for (let lane = 0; lane < RATE / 8; lane++) {
      let value = 0n;
      for (let byte = 7; byte >= 0; byte--) {
        value = (value << 8n) | BigInt(padded[offset + lane * 8 + byte]);
      }
      state[lane] ^= value;
    }
    keccakF(state);
  }

  let hex = '';
  for (let lane = 0; lane < 8; lane++) {
    let value = state[lane];
    for (let byte = 0; byte < 8; byte++) {
      hex += Number(value & 0xffn).toString(16).padStart(2, '0');
      value >>= 8n;
    }
  }
  return hex;
}

const encoder = new TextEncoder();

function base64(text) {
  // btoa is byte-oriented, and the config can hold non-ASCII from the user agent.
  const bytes = encoder.encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

// Plausible values for the two fields the client derives from the machine it
// runs on. Fixed rather than random, so a solved proof is reproducible.
const CORES = 8;
const SCREEN = 3000;

function configFor({ index, userAgent, now }) {
  return [
    CORES + SCREEN,
    new Date(now).toString(),
    4294705152,
    index, // the only field that moves while searching
    userAgent,
    '', // the script url the client reports loading from
    'en-US',
    'en-US,en',
    0
  ];
}

/**
 * Search for a config whose digest sorts below the server's difficulty.
 *
 * The work is small by design: difficulty is a short hex string and the search
 * space is uniform, so this normally lands in tens of attempts. Both bounds
 * exist for the case where we have MISREAD the difficulty, and they are
 * different guards — an attempt cap says nothing about wall clock when each
 * hash is a BigInt permutation, and a service worker that spends two minutes in
 * a loop is one Chrome may simply kill. Whichever runs out first, giving up is
 * cheap: the relay window is still there.
 */
export function solveProof({ seed, difficulty, userAgent = '', now = Date.now(), limit = 50000, budgetMs = 2500 }) {
  const width = difficulty.length;
  const deadline = Date.now() + budgetMs;

  for (let index = 0; index < limit; index++) {
    const encoded = base64(JSON.stringify(configFor({ index, userAgent, now })));
    if (sha3_512(encoder.encode(seed + encoded)).slice(0, width) <= difficulty) {
      return `gAAAAAB${encoded}`;
    }
    // Checked in batches: Date.now() per attempt would cost more than the hash
    // on the easy difficulties, which is every ordinary turn.
    if ((index & 0xff) === 0xff && Date.now() > deadline) break;
  }

  return null;
}

/**
 * The proof sent WITH the requirements handshake, before the server has issued a
 * seed of its own. There is nothing to hash against yet, so this is a
 * well-formed token rather than a solution to anything — but sending one is what
 * stops the handshake escalating to a challenge we cannot answer.
 */
export function seedToken({ userAgent = '', now = Date.now() } = {}) {
  return solveProof({ seed: '', difficulty: '0', userAgent, now });
}

/**
 * The Turnstile answer, when one is demanded.
 *
 * Despite the name this is not the Cloudflare widget. The server sends `dx`,
 * which is base64 over the answer XOR-masked with the very proof token we just
 * sent it — so unmasking it is the whole task, and that is why it is worth
 * doing rather than giving up. Only a challenge with no `dx` is genuinely
 * unanswerable here.
 */
export function solveTurnstile(dx, proof) {
  let decoded;
  try {
    decoded = atob(dx);
  } catch {
    return null; // not base64 — the challenge shape changed
  }

  if (!proof) return decoded;

  let answer = '';
  for (let i = 0; i < decoded.length; i++) {
    answer += String.fromCharCode(decoded.charCodeAt(i) ^ proof.charCodeAt(i % proof.length));
  }
  return answer;
}
