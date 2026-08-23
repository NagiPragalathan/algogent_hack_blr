/**
 * Making a worker's request look like the page's own — which is what it is
 * standing in for.
 *
 * A `fetch` from a service worker carries `Origin: chrome-extension://<id>`,
 * no `Referer`, and `Sec-Fetch-Site: none`. The page doing the identical call
 * sends `Origin: https://chatgpt.com`, a referer, and `Sec-Fetch-Site:
 * same-origin`. That difference is on EVERY request, it is trivial to log, and
 * it is the single clearest way for a provider to tell this apart from somebody
 * using their site. Correcting it is not about getting past anything — the
 * session cookie and the token are what authorise the call, and they are the
 * user's own — it is about a personal client not standing out on a header it
 * only differs on by accident of where the code runs.
 *
 * `tabIds: [-1]` is what makes this safe, and it is the whole reason these are
 * SESSION rules rather than static ones. A request from a page has a real tab
 * id; one from the worker has none. So these rules match ours and cannot match
 * the provider's own traffic — which matters most for `Referer`, where the real
 * page sends the conversation URL and overwriting it would be a change to the
 * site's behaviour rather than to ours.
 *
 * Registered at runtime for the other half of that lesson: the same headers
 * written as a STATIC ruleset were rejected by Chrome's validator, and a static
 * ruleset that fails takes the whole manifest with it — the extension would not
 * install at all. Here a rejection is a caught promise and the calls simply go
 * out as they did before. See the note in AGENTS.md.
 */

/** Ids reserved for these rules. Session rules are replaced, never appended. */
const RULE_IDS = [9001, 9002, 9003, 9004];

const ORIGINS = [
  { host: 'chatgpt.com', origin: 'https://chatgpt.com' },
  { host: 'gemini.google.com', origin: 'https://gemini.google.com' },
  { host: 'claude.ai', origin: 'https://claude.ai' },
  { host: 'www.meta.ai', origin: 'https://www.meta.ai' }
];

function rulesFor() {
  return ORIGINS.map(({ host, origin }, i) => ({
    id: RULE_IDS[i],
    priority: 1,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [
        { header: 'origin', operation: 'set', value: origin },
        { header: 'referer', operation: 'set', value: `${origin}/` },
        { header: 'sec-fetch-site', operation: 'set', value: 'same-origin' },
        { header: 'sec-fetch-mode', operation: 'set', value: 'cors' },
        { header: 'sec-fetch-dest', operation: 'set', value: 'empty' }
      ]
    },
    condition: {
      requestDomains: [host],
      // Ours only: a page's request has a tab, the worker's has none.
      tabIds: [-1],
      resourceTypes: ['xmlhttprequest']
    }
  }));
}

/**
 * Best effort, and deliberately so.
 *
 * Every failure mode here ends the same way — the requests go out with the
 * headers Chrome gives them, exactly as they did before this file existed — so
 * there is nothing for a caller to handle and nothing worth telling the user.
 * What must never happen is this throwing into the worker's startup path.
 */
export async function installDirectHeaders() {
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: RULE_IDS,
      addRules: rulesFor()
    });
    return true;
  } catch {
    return false;
  }
}
