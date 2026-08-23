/**
 * The shared edges of every endpoint: CORS, method guards, JSON bodies, and a
 * single error shape.
 *
 * The error shape matters more than it looks. Every failure here is something a
 * caller has to act on differently — a price below the floor, an unregistered
 * agent, a signature that does not match what was quoted — and a bare 500 with
 * a stack in it tells them none of that. So a failure is always
 * `{ error: <code>, message: <sentence> }` with the code stable enough to
 * branch on and the message written for a person.
 */

/**
 * The extension calls these from a chrome-extension:// origin, which is opaque
 * and can never be allow-listed by name, so the registry and payment endpoints
 * are open by design. That is safe because none of them is authenticated by
 * origin: the only thing that authorises a payment is a signature from the
 * buyer's own wallet, and the only thing that authorises settlement is the
 * chain confirming it.
 */
export function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type,payment-signature');
  res.setHeader('Access-Control-Expose-Headers', 'payment-required,payment-response');
}

export function json(res, status, body) {
  res.status(status).setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

export function fail(res, status, error, message) {
  return json(res, status, { error, message });
}

/**
 * Wrap a handler with CORS, the preflight, a method guard and a catch-all.
 *
 * The catch-all returns a code rather than the thrown message: an unexpected
 * throw here is a bug, and echoing its text leaks table names and connection
 * strings to anyone who can send a malformed body.
 */
export function handler(methods, fn) {
  const allowed = new Set([].concat(methods));

  return async (req, res) => {
    cors(res);
    if (req.method === 'OPTIONS') return res.status(204).end();

    if (!allowed.has(req.method)) {
      return fail(res, 405, 'method_not_allowed', `Use ${[...allowed].join(' or ')}.`);
    }

    try {
      return await fn(req, res);
    } catch (error) {
      console.error(`[${req.url}]`, error);
      return fail(res, 500, 'internal_error', 'The request could not be completed.');
    }
  };
}

/** Vercel parses JSON bodies already; this covers a raw string body too. */
export function body(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return req.body;
}

/** 58 characters of base32 — the shape of every Algorand address. */
export const ALGORAND_ADDRESS = /^[A-Z2-7]{58}$/;

/**
 * Read a required env var, or throw at first use.
 *
 * Deliberately not defaulted: a missing company payout address must stop the
 * request, never quietly send the company's 20% to an empty string or, worse,
 * fold it into the developer's share without anyone noticing.
 */
export function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}
