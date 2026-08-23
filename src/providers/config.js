/**
 * Provider definitions.
 *
 * Every DOM hook is a LIST of candidate selectors, tried in order until one
 * matches. When a provider ships a UI change and the extension stops working,
 * the fix is to add a new selector at the front of the relevant list — either
 * here, or (without touching code) in the Options page, which deep-merges user
 * overrides on top of these defaults.
 *
 * Selector roles
 *   composer   : the input the user types into (textarea or contenteditable)
 *   send       : the submit button
 *   stop       : the "stop generating" button — its presence means streaming
 *   streaming  : an element that only exists while a response is streaming
 *   assistant  : assistant message containers; the LAST match is the live reply
 *   user       : the user's own message containers. The adapter finds the one
 *                holding the question it just sent and reads the reply that
 *                follows it, which is what makes a stale answer impossible.
 *   loggedOut  : if any match, the tab needs a manual login
 *   ready      : if any match, the app has finished booting
 */

export const DEFAULT_PROVIDERS = {
  chatgpt: {
    id: 'chatgpt',
    name: 'ChatGPT',
    short: 'GPT',
    color: '#10a37f',
    enabled: true,
    homeUrl: 'https://chatgpt.com/',
    newChatUrl: 'https://chatgpt.com/',
    matches: ['https://chatgpt.com/*', 'https://chat.openai.com/*'],
    submitWith: 'click',
    selectors: {
      composer: [
        '#prompt-textarea',
        'div[contenteditable="true"]#prompt-textarea',
        'form div[contenteditable="true"]',
        'textarea[placeholder*="Message"]',
        'textarea[data-id]'
      ],
      send: [
        'button[data-testid="send-button"]',
        'button[data-testid="composer-send-button"]',
        'button[aria-label*="Send prompt"]',
        'button[aria-label*="Send message"]'
      ],
      stop: [
        'button[data-testid="stop-button"]',
        'button[aria-label*="Stop streaming"]',
        'button[aria-label*="Stop generating"]'
      ],
      streaming: ['.result-streaming'],
      // Container first, on purpose. `pickAll` uses the first selector that
      // matches anything, and a short reply ("Hi! How can I help you today?")
      // can render without the `.markdown` wrapper that longer answers get —
      // so a `.markdown`-first list matches only the OLDER messages and the
      // newest reply is invisible to us. The container exists for every
      // assistant turn; htmlToMarkdown handles whatever is inside it.
      assistant: [
        '[data-message-author-role="assistant"]',
        '[data-message-author-role="assistant"] .markdown',
        'div.agent-turn .markdown'
      ],
      user: ['[data-message-author-role="user"]'],
      // The "+" beside the composer. ChatGPT builds its file input only once
      // this menu has existed, so `attachFile` clicks it to make one appear —
      // never the item inside it, which opens the OS file dialog.
      attach: [
        'button[data-testid="composer-plus-btn"]',
        '#composer-plus-btn',
        'button[aria-label*="Add files" i]',
        'button[aria-label*="Attach" i]'
      ],
      loggedOut: [
        'button[data-testid="login-button"]',
        'a[href*="/auth/login"]',
        'button[data-testid="mobile-login-button"]'
      ],
      ready: ['#prompt-textarea', 'form div[contenteditable="true"]']
    }
  },

  gemini: {
    id: 'gemini',
    name: 'Gemini',
    short: 'GEM',
    color: '#4285f4',
    enabled: true,
    homeUrl: 'https://gemini.google.com/app',
    newChatUrl: 'https://gemini.google.com/app',
    matches: ['https://gemini.google.com/*'],
    submitWith: 'click',
    selectors: {
      composer: [
        'rich-textarea .ql-editor[contenteditable="true"]',
        '.ql-editor[contenteditable="true"]',
        'div[contenteditable="true"][role="textbox"]'
      ],
      /**
       * The `send-button` class is on the <gem-icon-button> WRAPPER, not on the
       * <button> inside it — so `button.send-button` matches nothing and every
       * turn fell through to the aria-label guess. Reach the real button
       * through the wrapper (and through the container's test id, which Gemini
       * keeps stable for its own suite) before guessing at a label that is
       * translated per locale.
       */
      send: [
        'gem-icon-button.send-button button',
        '[data-test-id="send-button-container"] button',
        'button.send-button',
        'button[aria-label*="Send message"]',
        'button[aria-label*="Send"]'
      ],
      stop: [
        'button[aria-label*="Stop response"]',
        'button[aria-label*="Stop"]'
      ],
      streaming: ['model-response[data-streaming="true"]', '.response-container.streaming'],
      assistant: [
        'model-response message-content .markdown',
        'model-response message-content',
        'model-response',
        '.model-response-text'
      ],
      user: ['user-query .query-text', 'user-query', '.user-query-bubble-with-background'],
      attach: [
        'button[aria-label*="Open upload file menu" i]',
        'button[aria-label*="Add files" i]',
        'button[aria-label*="Attach" i]'
      ],
      loggedOut: [
        'a[href*="accounts.google.com/ServiceLogin"]',
        'a[href*="accounts.google.com/signin"]'
      ],
      ready: ['rich-textarea', '.ql-editor[contenteditable="true"]']
    }
  },

  claude: {
    id: 'claude',
    name: 'Claude',
    short: 'CL',
    color: '#d97757',
    enabled: true,
    homeUrl: 'https://claude.ai/new',
    newChatUrl: 'https://claude.ai/new',
    matches: ['https://claude.ai/*'],
    submitWith: 'click',
    selectors: {
      composer: [
        'div[contenteditable="true"].ProseMirror',
        'fieldset div[contenteditable="true"]',
        'div[contenteditable="true"][role="textbox"]'
      ],
      send: [
        'button[aria-label="Send message"]',
        'button[aria-label="Send Message"]',
        'button[aria-label*="Send"]'
      ],
      stop: [
        'button[aria-label*="Stop response"]',
        'button[aria-label*="Stop"]'
      ],
      streaming: ['[data-is-streaming="true"]'],
      assistant: [
        'div[data-testid="chat-message"] .font-claude-response',
        '.font-claude-response',
        '.font-claude-message',
        'div[data-testid="chat-message"]'
      ],
      user: ['div[data-testid="user-message"]', '.font-user-message'],
      attach: [
        'button[data-testid="input-menu-plus"]',
        'button[aria-label*="Upload" i]',
        'button[aria-label*="Attach" i]'
      ],
      loggedOut: [
        'a[href*="/login"]',
        'button[data-testid="login-with-google"]'
      ],
      ready: ['div[contenteditable="true"].ProseMirror', 'fieldset']
    }
  },

  meta: {
    id: 'meta',
    name: 'Meta AI',
    short: 'META',
    color: '#0064e0',
    enabled: false,
    homeUrl: 'https://www.meta.ai/',
    newChatUrl: 'https://www.meta.ai/',
    matches: ['https://www.meta.ai/*', 'https://meta.ai/*'],
    submitWith: 'enter',
    // meta.ai ships obfuscated class names and is region-restricted. These are
    // best-effort structural selectors; expect to tune them in Options.
    selectors: {
      composer: [
        'div[contenteditable="true"][role="textbox"]',
        'textarea[placeholder*="Ask Meta AI"]',
        'textarea[placeholder*="Ask"]',
        'div[aria-label*="Ask Meta AI"]'
      ],
      send: [
        'div[aria-label="Send message"][role="button"]',
        'button[aria-label*="Send"]',
        'div[aria-label*="Send"][role="button"]'
      ],
      stop: ['div[aria-label*="Stop"][role="button"]', 'button[aria-label*="Stop"]'],
      streaming: [],
      assistant: [
        'div[data-testid="message-bubble"]',
        'div[role="article"]',
        'div[dir="auto"]'
      ],
      // meta.ai gives its own bubbles no stable marker, so there is nothing
      // honest to put here — the adapter falls back to its weaker heuristic.
      user: [],
      loggedOut: ['a[href*="facebook.com/login"]', 'div[aria-label="Log in"]'],
      ready: ['div[contenteditable="true"][role="textbox"]', 'textarea']
    }
  },

  /* ------------------------------------------------------------------------
   * The free tier, beyond the big four.
   *
   * Every provider below has a free plan reachable with an ordinary login,
   * which is the only kind of account this extension can drive. They are
   * ordered by what they add rather than by benchmark: Grok for reach,
   * DeepSeek because it is the strongest model available for nothing,
   * Perplexity because citations are a capability none of the others have.
   *
   * A warning that applies to ALL of them, and to their selectors especially.
   * The four above were tuned against their real markup; these were written
   * from their structure. Each list therefore runs specific-then-structural, so
   * a wrong first guess falls through to something generic rather than failing
   * the provider outright — and every one of them can be corrected in Options
   * without touching this file. Treat a provider that types but never sends as
   * a stale `send` selector first, exactly as Gemini turned out to be.
   *
   * `enabled: false` is not a judgement on the model. It keeps the picker
   * short: three new providers is a menu, eight is a wall. Turn any of them on
   * in Options.
   * --------------------------------------------------------------------- */

  grok: {
    id: 'grok',
    name: 'Grok',
    short: 'GROK',
    color: '#1d9bf0',
    enabled: true,
    homeUrl: 'https://grok.com/',
    newChatUrl: 'https://grok.com/',
    matches: ['https://grok.com/*', 'https://x.com/i/grok*'],
    submitWith: 'click',
    selectors: {
      composer: [
        'textarea[aria-label*="Ask Grok" i]',
        'form textarea',
        'div[contenteditable="true"][role="textbox"]',
        'textarea'
      ],
      send: [
        'button[type="submit"][aria-label*="Submit" i]',
        'form button[type="submit"]',
        'button[aria-label*="Submit" i]',
        'button[aria-label*="Send" i]'
      ],
      stop: ['button[aria-label*="Stop" i]'],
      streaming: [],
      assistant: [
        '.message-bubble:not(.items-end)',
        '[data-testid="message-bubble"]',
        '.response-content-markdown',
        '.prose'
      ],
      user: ['.message-bubble.items-end', '[data-testid="user-message"]'],
      attach: ['button[aria-label*="Attach" i]', 'button[aria-label*="Upload" i]'],
      loggedOut: ['a[href*="/sign-in"]', 'button[data-testid="signin"]'],
      ready: ['form textarea', 'textarea']
    }
  },

  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek',
    short: 'DS',
    color: '#4d6bfe',
    enabled: true,
    homeUrl: 'https://chat.deepseek.com/',
    newChatUrl: 'https://chat.deepseek.com/',
    matches: ['https://chat.deepseek.com/*'],
    submitWith: 'click',
    // DeepSeek builds its controls out of divs with hashed class names, so the
    // send hook is a role/aria test rather than a class — a hashed class is
    // regenerated on every deploy and would be stale within a week.
    selectors: {
      composer: ['textarea#chat-input', 'textarea[placeholder]', 'textarea'],
      send: [
        'div[role="button"][aria-disabled="false"]:has(svg)',
        'button[type="submit"]',
        'div[role="button"]:has(svg)'
      ],
      stop: ['div[role="button"][aria-label*="Stop" i]', 'button[aria-label*="Stop" i]'],
      streaming: [],
      assistant: ['.ds-markdown', '.ds-markdown--block', '._4f9bf79'],
      user: ['.fbb737a4', '[class*="user"] .ds-markdown'],
      attach: ['input[type="file"]', 'div[role="button"][aria-label*="Upload" i]'],
      // Nothing looser than the sign-in link. A generic button test matches half
      // the app and reports a signed-in user as logged out, which sends the run
      // to a login screen it does not need.
      loggedOut: ['a[href*="/sign_in"]'],
      ready: ['textarea#chat-input', 'textarea']
    }
  },

  perplexity: {
    id: 'perplexity',
    name: 'Perplexity',
    short: 'PPLX',
    color: '#20808d',
    enabled: true,
    homeUrl: 'https://www.perplexity.ai/',
    newChatUrl: 'https://www.perplexity.ai/',
    matches: ['https://www.perplexity.ai/*', 'https://perplexity.ai/*'],
    submitWith: 'click',
    /**
     * Worth knowing before this is used for AGENT mode: Perplexity is tuned to
     * answer with prose and citations, which is the shape `parseAction`
     * struggles with most. It is an excellent chat provider and a poor first
     * choice for a run.
     */
    selectors: {
      composer: [
        'div[contenteditable="true"]#ask-input',
        'textarea[placeholder*="Ask" i]',
        'div[contenteditable="true"][role="textbox"]',
        'textarea'
      ],
      send: [
        'button[data-testid="submit-button"]',
        'button[aria-label*="Submit" i]',
        'button[type="submit"]'
      ],
      stop: ['button[aria-label*="Stop" i]'],
      streaming: [],
      assistant: [
        '[data-testid="answer-mode-view"] .prose',
        '#markdown-content-wrapper',
        '.prose'
      ],
      user: ['[data-testid="query-display"]', '.whitespace-pre-line'],
      attach: ['button[aria-label*="Attach" i]', 'input[type="file"]'],
      loggedOut: ['a[href*="/sign-in"]'],
      ready: ['div[contenteditable="true"]#ask-input', 'textarea']
    }
  },

  copilot: {
    id: 'copilot',
    name: 'Microsoft Copilot',
    short: 'COP',
    color: '#0078d4',
    enabled: false,
    homeUrl: 'https://copilot.microsoft.com/',
    newChatUrl: 'https://copilot.microsoft.com/',
    matches: ['https://copilot.microsoft.com/*'],
    submitWith: 'click',
    selectors: {
      composer: [
        'textarea#userInput',
        'textarea[data-testid="composer-input"]',
        'textarea[placeholder*="Message" i]',
        'textarea'
      ],
      send: [
        'button[data-testid="submit-button"]',
        'button[title*="Submit" i]',
        'button[aria-label*="Submit" i]',
        'button[aria-label*="Send" i]'
      ],
      stop: ['button[title*="Stop" i]', 'button[aria-label*="Stop" i]'],
      streaming: [],
      assistant: [
        '[data-content="ai-message"]',
        'div[data-testid="message-ai"]',
        '.prose'
      ],
      user: ['[data-content="user-message"]', 'div[data-testid="message-user"]'],
      attach: ['button[aria-label*="Add" i]', 'input[type="file"]'],
      loggedOut: ['a[href*="login.microsoftonline.com"]'],
      ready: ['textarea#userInput', 'textarea']
    }
  },

  qwen: {
    id: 'qwen',
    name: 'Qwen',
    short: 'QWEN',
    color: '#615ced',
    enabled: false,
    homeUrl: 'https://chat.qwen.ai/',
    newChatUrl: 'https://chat.qwen.ai/',
    matches: ['https://chat.qwen.ai/*'],
    submitWith: 'click',
    // Qwen and Z.ai below are both Open-WebUI derivatives, which is why their
    // hooks are identical. If one breaks, check the other.
    selectors: {
      composer: ['textarea#chat-input', 'textarea[placeholder]', 'textarea'],
      send: [
        'button#send-message-button',
        'button[type="submit"]',
        'button[aria-label*="Send" i]'
      ],
      stop: ['button[aria-label*="Stop" i]', '#stop-response-button'],
      streaming: [],
      assistant: ['.chat-assistant .markdown-prose', '.markdown-prose', '.prose'],
      user: ['.chat-user', '[data-message-role="user"]'],
      attach: ['input[type="file"]', 'button[aria-label*="Attach" i]'],
      loggedOut: ['a[href*="/auth"]', 'input[name="password"]'],
      ready: ['textarea#chat-input', 'textarea']
    }
  },

  mistral: {
    id: 'mistral',
    name: 'Le Chat (Mistral)',
    short: 'LC',
    color: '#fa520f',
    enabled: false,
    homeUrl: 'https://chat.mistral.ai/chat',
    newChatUrl: 'https://chat.mistral.ai/chat',
    matches: ['https://chat.mistral.ai/*'],
    submitWith: 'click',
    // The fastest responder of the set — its Flash Answers path returns in
    // well under a second, which makes it the cheapest provider to poll.
    selectors: {
      composer: [
        'div[contenteditable="true"].ProseMirror',
        'textarea[name*="message" i]',
        'div[contenteditable="true"][role="textbox"]',
        'textarea'
      ],
      send: [
        'button[type="submit"][aria-label*="Send" i]',
        'button[aria-label*="Send" i]',
        'button[type="submit"]'
      ],
      stop: ['button[aria-label*="Stop" i]'],
      streaming: [],
      assistant: ['div[data-message-part-type="answer"]', '.prose'],
      user: ['div[data-message-author-role="user"]', '.whitespace-pre-wrap'],
      attach: ['input[type="file"]', 'button[aria-label*="Attach" i]'],
      loggedOut: ['a[href*="/login"]'],
      ready: ['div[contenteditable="true"].ProseMirror', 'textarea']
    }
  },

  kimi: {
    id: 'kimi',
    name: 'Kimi',
    short: 'KIMI',
    color: '#8b5cf6',
    enabled: false,
    homeUrl: 'https://www.kimi.com/',
    newChatUrl: 'https://www.kimi.com/',
    matches: ['https://www.kimi.com/*', 'https://kimi.com/*', 'https://kimi.moonshot.cn/*'],
    submitWith: 'click',
    selectors: {
      composer: [
        'div[contenteditable="true"].chat-input-editor',
        'div[contenteditable="true"][role="textbox"]',
        'textarea'
      ],
      send: [
        'div[data-testid="msh-chatinput-send"]',
        '.send-button',
        'button[aria-label*="Send" i]'
      ],
      stop: ['.stop-button', 'button[aria-label*="Stop" i]'],
      streaming: [],
      assistant: ['.segment-assistant .markdown', '.markdown-body', '.markdown'],
      user: ['.segment-user', '.user-content'],
      attach: ['input[type="file"]'],
      loggedOut: ['.login-button', 'a[href*="/login"]'],
      ready: ['div[contenteditable="true"]', 'textarea']
    }
  },

  zai: {
    id: 'zai',
    name: 'Z.ai (GLM)',
    short: 'GLM',
    color: '#10b981',
    enabled: false,
    homeUrl: 'https://chat.z.ai/',
    newChatUrl: 'https://chat.z.ai/',
    matches: ['https://chat.z.ai/*'],
    submitWith: 'click',
    selectors: {
      composer: ['textarea#chat-input', 'textarea[placeholder]', 'textarea'],
      send: [
        'button#send-message-button',
        'button[type="submit"]',
        'button[aria-label*="Send" i]'
      ],
      stop: ['button[aria-label*="Stop" i]', '#stop-response-button'],
      streaming: [],
      assistant: ['.chat-assistant .markdown-prose', '.markdown-prose', '.prose'],
      user: ['.chat-user', '[data-message-role="user"]'],
      attach: ['input[type="file"]', 'button[aria-label*="Attach" i]'],
      loggedOut: ['a[href*="/auth"]', 'input[name="password"]'],
      ready: ['textarea#chat-input', 'textarea']
    }
  },

  arena: {
    id: 'arena',
    name: 'Arena AI',
    short: 'ARN',
    color: '#7c3aed',
    enabled: true,
    // Direct mode — one model, one reply. The default landing mode is Battle,
    // which answers TWICE (Assistant A and Assistant B in a carousel); the panel
    // would show one of them with no sign the other existed, and an agent run
    // would get two JSON blocks in one reply. Direct has its own URL, so the
    // mode is pinned by landing here rather than by driving the mode dropdown.
    // It requires being signed in to arena.ai — Battle does not.
    homeUrl: 'https://arena.ai/text/direct',
    newChatUrl: 'https://arena.ai/text/direct',
    matches: ['https://arena.ai/*'],
    submitWith: 'click',
    /**
     * The newest message is the FIRST child, not the last.
     *
     * Arena's thread is an `<ol class="… flex-col-reverse">`, so CSS puts the
     * first DOM child at the bottom and document order runs newest-to-oldest.
     * Everything in `adapter.js` that says "the latest reply" means
     * `nodes[nodes.length - 1]`, which here is the OLDEST reply in the
     * conversation — so every turn of a run came back with the answer to the
     * first question ever asked in it. See `inThreadOrder`.
     */
    reversedThread: true,
    /**
     * Window-only, and deliberately not in DIRECT_PROVIDERS.
     *
     * The obvious move is a `direct/arena.js` beside the other four, and it
     * does not work the way ChatGPT's does. ChatGPT's gate is a SHA3-512
     * proof of work the client is MEANT to compute, which is why `sentinel.js`
     * can compute it and still be doing exactly what the page does. Arena's
     * gate is reCAPTCHA Enterprise wrapped around identity creation — the
     * bundle carries `create_anonymous_user`, `recaptchaToken`,
     * `RecaptchaWrappedRequestError` and a `create_anonymous_user_rate_limited`
     * branch — and a reCAPTCHA token cannot be computed at all. It can only be
     * obtained by having Google score a real page, so a worker-side engine
     * would have to harvest tokens out of a hidden page and replay them, which
     * is the fingerprint work this folder's own notes rule out. The window path
     * needs none of it: the real tab passes the real challenge itself.
     *
     * `composer`, `send` and `attach` were read off the live page. The rest are
     * best-effort — check them against a real conversation before trusting a
     * quiet reply.
     */
    selectors: {
      composer: [
        'textarea[placeholder*="Ask followup"]',
        'textarea[placeholder*="Ask anything"]',
        'textarea[placeholder*="What would you like to do"]',
        'form textarea',
        'textarea'
      ],
      send: [
        'button[aria-label="Send message"]',
        'button[aria-label*="Send" i]',
        'form button[type="submit"]'
      ],
      stop: ['button[aria-label*="Stop" i]'],
      streaming: [],
      /**
       * Arena ships NO data attributes anywhere — no `data-testid`, no
       * `data-message-role`, nothing. Everything is Tailwind, so the reply has
       * to be addressed structurally.
       *
       * `div.prose` alone is wrong: the user's own bubble is a `div.prose` too,
       * and it is the LAST one in DOM order (see `user` below), so
       * `latestAssistantText` would hand the panel back the question it had
       * just asked. The user's prose is the direct child of the
       * `bg-surface-raised` bubble and the replies are not, which is the one
       * structural difference that separates them.
       */
      assistant: ['div.prose:not(.bg-surface-raised > *)'],
      /**
       * EMPTY ON PURPOSE. Do not fill this in.
       *
       * Arena renders its thread into an `<ol class="… flex-col-reverse">`, so
       * the DOM order is the REVERSE of the visual order: the reply is a
       * PRECEDING sibling of the question it answers. `freshText` resolves a
       * reply by taking the assistant nodes that FOLLOW the anchored user
       * message in document order — measured here, that set is empty, so a
       * populated `user` selector makes every turn return '' and time out with
       * the answer plainly on screen. That is the "Arena AI did not answer —
       * reopening its window" loop.
       *
       * With no `user` match, `freshText` takes its documented fallback:
       * newest assistant text, accepted once it differs from what was on screen
       * before we sent. That fallback ALSO reads document order — "newest" is
       * `nodes[nodes.length - 1]` — which is what `reversedThread` above is
       * for. Both halves are needed: this one keeps the anchored branch
       * unreachable, that one makes the fallback point at the right end.
       */
      user: [],
      attach: [
        'button[aria-label="Add files and more"]',
        'button[aria-label*="Add files" i]',
        'input[type="file"]'
      ],
      loggedOut: ['a[href*="/sign-in"]'],
      ready: ['textarea']
    }
  },

  notrack: {
    id: 'notrack',
    name: 'NoTrack',
    short: 'NT',
    color: '#22c55e',
    enabled: true,
    homeUrl: 'https://notrack.ai/chat',
    newChatUrl: 'https://notrack.ai/chat',
    matches: ['https://notrack.ai/*'],
    submitWith: 'click',
    /**
     * The window path, which this provider needs far less than the others: it
     * has an engine in `background/transport/direct/`, and unlike Arena there
     * is nothing standing between a worker and the endpoint — no sign-in, no
     * captcha. This is the fallback for a turn carrying a file (the engine has
     * no upload flow yet) and for an agent run.
     *
     * All of these were read off the live page. The markup is plain and
     * semantic, and — unlike Arena — DOM order matches visual order, so `user`
     * can be populated and `freshText` can anchor on it properly.
     */
    selectors: {
      composer: ['textarea#field', 'form textarea', 'textarea'],
      send: ['button#goBtn', 'button[aria-label="Send"]', 'form button[type="submit"]'],
      stop: ['button[aria-label*="Stop" i]'],
      streaming: [],
      /**
       * Rows are `.row.usr` for the question and `.row.ag-<speaker>` for an
       * answer, so the attribute-prefix match takes every speaker without
       * taking the user. `.message-body` rather than `.bubble` keeps the
       * speaker label ("NOTRACK") out of the transcribed reply.
       */
      assistant: ['.row[class*="ag-"] .message-body', '.row[class*="ag-"] .markdown-body'],
      user: ['.row.usr .message-body'],
      attach: ['input[type="file"]', 'button[aria-label*="Attach" i]'],
      // Nothing to be signed out of, so there is no signed-out state to detect.
      loggedOut: [],
      ready: ['textarea#field']
    }
  }
};

export const PROVIDER_ORDER = [
  'chatgpt',
  'gemini',
  'claude',
  'grok',
  'deepseek',
  'perplexity',
  'copilot',
  'qwen',
  'mistral',
  'kimi',
  'zai',
  'meta',
  'arena',
  'notrack'
];

/**
 * The providers that CAN be asked without opening a window.
 *
 * One entry per engine in `background/transport/direct/`, and the two lists
 * cannot see each other: this one is read by the options page, which is a
 * separate document and must not import background code. An id here with no
 * engine there is a dropdown that silently does nothing; an engine there with
 * no id here is a provider the user cannot switch. Change one, change the other.
 */
export const DIRECT_PROVIDERS = ['chatgpt', 'gemini', 'claude', 'meta', 'notrack'];

/**
 * The engines that skip the window WITHOUT being asked to.
 *
 * All four have an engine, and they are not equally worth defaulting on. ChatGPT
 * and Gemini carry the whole surface — text, a picture and a document — so their
 * fast path covers every turn including an agent run's, and a chat never has to
 * change transport halfway through. Claude and Meta AI carry text only: the
 * moment a turn attaches anything they hand it back to the window, which is
 * correct but pins that conversation to the relay for good (`hasConversation` is
 * URL-only, and only the relay files a URL). Defaulting them on therefore buys
 * speed on the turns before the first attachment and pays for it with a chat
 * that silently changes character partway through.
 *
 * They are still one dropdown away, and `directStatus` says so rather than
 * reporting them as unavailable — the engines work, they are simply not what a
 * fresh profile starts on.
 */
export const DIRECT_BY_DEFAULT = ['chatgpt', 'gemini'];

/**
 * How one provider is asked.
 *
 * An explicit choice always wins, in BOTH directions — a stored 'direct' has to
 * survive this provider not being in the default set, or switching Claude on in
 * Options would read back as Popup and look like a setting that does nothing.
 */
export const transportFor = (settings, providerId) => {
  const chosen = settings?.providerTransport?.[providerId];
  if (chosen === 'direct' || chosen === 'window') return chosen;
  return DIRECT_BY_DEFAULT.includes(providerId) ? 'direct' : 'window';
};

export const DEFAULT_SETTINGS = {
  /**
   * Which way each provider is asked, when it has a choice.
   *
   *   'direct' — its own API, from the worker. No window, no app to load,
   *              nothing to keep awake, and the reply stream ends by itself.
   *   'window' — drive the page, as every other provider is driven.
   *
   * Per provider rather than one switch, because they do not fail together: a
   * meta.ai on Meta's newer frontend has no working engine while ChatGPT's is
   * fine, and one global setting would make ruling out the transport for the
   * broken one cost the speed of the other three.
   *
   * Absent means whatever `DIRECT_BY_DEFAULT` says — 'direct' for ChatGPT and
   * Gemini, 'window' for everything else — so a provider that gains an engine
   * later needs no migration and does not switch anybody's transport on for them.
   */
  providerTransport: {},

  /**
   * Whether to ask a provider over its own API before falling back to driving
   * its page.
   *
   *   'auto' — honour each provider's own transport setting (ChatGPT and Gemini
   *            straight to the endpoint by default; everything else through the
   *            window), and use the window for any turn the engine cannot carry
   *            and whenever it fails. Several times faster: no window to open,
   *            no app to load, no anti-throttle layers to arm, and the reply
   *            stream ENDS rather than having to be inferred from the DOM
   *            settling. See `transport/direct/index.js`.
   *   'strict'— the same, but a provider set to No popup never gets one. When
   *            its engine cannot answer, the reason is reported instead of a
   *            window opening. For when "no popup" was meant literally: the
   *            fallback is silent, and worse, it is permanent — the window that
   *            answers files a conversation URL, and that pins the chat to the
   *            window long after the transient failure has cleared. Agent runs
   *            are exempt, because most engines cannot carry a screenshot and a
   *            run that refuses to start helps nobody.
   *   'off'   — always drive the page. The setting to reach for when a provider
   *            starts answering oddly and you want the transport ruled out:
   *            every engine here speaks an undocumented endpoint its owner can
   *            change without notice.
   *
   * `auto` never *reports* a direct failure — it hands the question back to the
   * window path — so the cost of an engine going stale is latency, not an
   * error. The other two are the two ways of saying that trade is not the one
   * you want: `off` skips the attempt, `strict` skips the consolation prize.
   *
   * `strict` is the DEFAULT, which is a deliberate reversal. On paper `auto` is
   * the kinder setting: the question still gets answered. In practice the thing
   * it trades away is not one turn of latency — the window that answers files a
   * conversation URL, and that pins the chat to a popup for the rest of its
   * life. So the real choice is between one visible refusal and an unbounded
   * number of invisible popups, and somebody who set a provider to "No popup"
   * has already said which of those they want. `auto` is still one dropdown
   * away for anyone who would rather always have an answer.
   */
  directTransport: 'strict',

  /**
   * Hold the direct path back to something one person could produce.
   *
   *   true  — a gap between requests that widens with how much this hour has
   *           already asked and with how long the last answer was, plus an
   *           hourly ceiling past which the provider rests. See `pace.js`.
   *   false — send as fast as the answers come back.
   *
   * On by default because the direct path removed the only rate limit this
   * extension used to have: driving a page takes ten to forty seconds whether
   * anybody wants it to or not, and posting to an endpoint takes one second, so
   * an agent run can put thirty requests through in the time the window path
   * manages three. That is the shape that gets a personal account looked at, and
   * it is not a shape anybody chose — it fell out of making things faster.
   *
   * Turning it off is a legitimate choice on a provider you are not worried
   * about, and it is the one to reach for when a run feels slow. What it does
   * NOT switch off is the stand-down after a 429 or a 403: that is not this
   * extension's caution, it is the provider having said no, and going straight
   * back at it is the single worst thing available. `pace.js` keeps that
   * whatever this says.
   */
  safePacing: true,

  /**
   * How the provider apps are hosted.
   *
   *   'window'   — a real tab in a minimized window. A genuine top-level page
   *                load, so it is indistinguishable from ordinary browsing at
   *                the network layer. The default, because it is the least
   *                likely of the two to be flagged as automation. Costs one
   *                taskbar slot.
   *   'embedded' — invisible offscreen frames. No window, no tab, nothing in
   *                the taskbar. But a framed load announces itself: the request
   *                carries Sec-Fetch-Dest: iframe and Sec-Fetch-Site:
   *                cross-site, and the page can see window.top !== window.self.
   *                It also needs the SameSite=None cookie change to stay signed
   *                in. Invisible, but more detectable.
   */
  providerMode: 'window',
  /**
   * Rewrite provider session cookies to SameSite=None so they are sent inside
   * the background frames. Without it the frames show a signed-out page. This
   * weakens CSRF protection on those accounts, so it is off until asked for.
   */
  relaxCookies: false,

  // How much readable page text to hand the model. Generous on purpose: a
  // tutorial or docs page routinely runs past 6k, and a silently halved page is
  // the kind of gap that shows up as a confidently incomplete answer.
  maxContextChars: 12000,
  /**
   * Budget for a deep read — the scroll-to-the-bottom pass that runs on the
   * question actually being sent.
   *
   * Much larger than maxContextChars because it is a different job: that number
   * bounds one DOM read of what happens to be rendered, this one bounds several
   * screenfuls of a feed or a result list. Capping a deep read at 12k would throw
   * away most of what the scrolling paid for.
   */
  deepContextChars: 45000,
  // How long the content script may spend scrolling and harvesting.
  deepReadBudgetMs: 7000,
  /**
   * Whether to read a long page in several provider turns before answering.
   *
   *   'auto'   — when the page is long, or the question is one that is wrong
   *              unless it is complete ("list all", "how many").
   *   'always' — whenever the page needs more than one part.
   *   'off'    — one turn, however long the page is. Fastest, and the setting
   *              that brings back confidently incomplete answers.
   */
  deepRead: 'auto',
  // Include page context by default on every new question.
  contextOnByDefault: true,
  /**
   * Attach what you highlight on a page, as you highlight it.
   *
   * Highlighting something and then asking about it is the commonest thing
   * anyone does with an assistant beside a page, and it used to cost a trip
   * through the + menu. Switchable because the same gesture is also how people
   * read, and an attachment appearing every time you drag over a sentence is a
   * fair thing to not want. The right-click entry stays either way.
   */
  captureSelection: true,
  // 'minimized' keeps the relay window out of your way; 'offscreen' parks it
  // past the edge of the display; 'visible' is for debugging what the adapters
  // are actually doing.
  relayWindowMode: 'minimized',
  /**
   * How hard to fight Chrome for the hidden provider tab.
   *
   * A hidden page is throttled to one timer tick a second, can be frozen
   * outright after five minutes, and can be discarded to save memory. Worse,
   * some provider apps gate their own streaming render on `document.hidden`, so
   * the answer never lands in the DOM for us to read at all. That is why a reply
   * only appeared when the provider window was brought forward.
   *
   *   'debugger' — attach the DevTools protocol and pin the page lifecycle to
   *                'active'. The only measure that exempts a page from all
   *                throttling and freezing. It costs an infobar on that tab —
   *                which lives in the hidden relay window, so nobody sees it.
   *   'soft'     — no debugger: keep the tab undiscardable, hold a Web Lock
   *                (a documented freezing exemption) and make the page believe
   *                it is visible. Helps, but Chrome still clamps timers.
   *   'off'      — nothing. Expect replies to stall until you focus the window.
   */
  tabWakePolicy: 'debugger',
  // Response is considered finished once its text stops changing for this long.
  stabilityMs: 1500,
  // Hard ceiling on a single response.
  responseTimeoutMs: 300000,
  // How long to wait for a provider tab to boot before giving up.
  readyTimeoutMs: 45000,
  /**
   * How much the browser agent may do unattended.
   *
   *   'confirm-risky' — reading, clicking, scrolling and navigating run on
   *                     their own; anything that submits a form or reads as
   *                     send/pay/delete/publish stops for approval first.
   *   'confirm-all'   — every step waits for a click. Slow, good for watching
   *                     the loop reason.
   *   'auto'          — no confirmations. It is acting with your logged-in
   *                     sessions, so this can send or delete for real.
   */
  agentPolicy: 'confirm-risky',
  /**
   * Draw on the page while the agent works it.
   *
   * A ring on the element it is about to touch, a ripple where it clicked, a
   * flash when it photographs the screen. This is the only way to tell an agent
   * step from the page doing something on its own — without it, watching a run
   * means watching a page change for no visible reason, and the honest reaction
   * to that is to stop the run.
   *
   * On by default and switchable because it is drawn INTO the page: a
   * screen recording, a demo, or a site whose own layout the overlay lands on
   * are all fair reasons to want it gone.
   */
  agentHighlight: true,

  /**
   * Which pointer the agent draws while it works.
   *
   * Not only taste: a white arrow disappears on a white form and a dark one
   * disappears on a dark dashboard, and a pointer you cannot see on the page
   * you are watching tells you nothing about what just happened. `ink` is the
   * default because most forms are light. The names are the keys of `CURSORS`
   * in `content/agent-page.js`; an unknown one falls back rather than drawing
   * nothing.
   */
  agentCursor: 'ink',

  /**
   * Keep the pointer alive between actions.
   *
   * Most of a run is a provider round trip — ten to forty seconds in which the
   * curtain is up, the page cannot be clicked, and nothing on screen moves at
   * all. A frozen arrow through all of that is the single thing that makes a
   * working run look hung, and the honest response to a hung run is to stop one
   * that was fine. Small drift, occasionally a longer reposition, and the next
   * real action travels from wherever it ended up.
   *
   * Only ever while a run holds the page, which is what keeps it honest rather
   * than decorative: it claims "this page is still mine", and that is true for
   * exactly as long as the curtain is up. A setting because it is motion on
   * someone else's page, and `prefers-reduced-motion` turns it off regardless.
   */
  agentIdleCursor: true,

  /**
   * How the edge of a page the agent is driving is marked.
   *
   * The border is the only mark that is visible no matter where you are looking
   * on the page, so it is doing the load-bearing work of "this window is not
   * yours right now" — and a flat blue rule reads as a rendering artefact
   * rather than as a state. The names are the keys of `FRAMES` in
   * `content/agent-page.js`; an unknown one falls back to the default rather
   * than drawing no border at all, which would silently remove the indicator.
   *
   * They differ in how much they move, and that is the actual choice: `liquid`
   * and `beam` travel, so the eye finds them; `corners` barely moves and stays
   * out of a screen recording. Everything here is off entirely when
   * `agentHighlight` is off — this picks the design, not whether there is one.
   */
  agentFrame: 'aurora',

  /**
   * The panel's own palette. Two choices, deliberately not one.
   *
   *   panelTheme  — 'system' | 'light' | 'dark'. 'system' is the default and
   *                 removes the override entirely, so the panel follows the OS
   *                 the way every other surface on the machine does.
   *   panelAccent — which accent pair to use. See ACCENTS in ui/theme.js and
   *                 the `[data-accent]` rules in styles/tokens.css, which are
   *                 two lists that cannot see each other: an id here with no
   *                 rule there is a swatch that silently does nothing.
   *
   * Stored as settings rather than panel prefs because the options page is a
   * separate document and has to be able to write them, and because
   * `chrome.storage.onChanged` is then the one channel that repaints a live
   * panel — see watchTheme.
   */
  panelTheme: 'system',
  panelAccent: 'blue',

  /**
   * Whether the panel's own step list walks a pointer between steps.
   *
   * Separate from `agentHighlight`, which governs what is drawn on the PAGE.
   * These are two different surfaces with two different reasons to be turned
   * off: the page overlay gets in the way of a screen recording, while this
   * one is simply motion in a panel someone may not want moving while they
   * read it.
   */
  agentStepPointer: true,

  /**
   * Pace the agent so its pointer can be watched.
   *
   * Without it a batch of eight actions lands in well under a second: the
   * cursor teleports, the ring flashes once, and what you actually see is the
   * form filling itself with no visible cause. A short beat before each action
   * is what turns that back into something you can follow — and following it
   * is the entire reason the pointer is drawn at all.
   *
   * It costs real time (see AGENT_BEAT_MS x actions), which is why it is a
   * setting rather than a constant. On by default: a run you cannot watch is
   * one you cannot supervise, and supervision is the point of agent mode.
   */
  agentPacing: true
};

/** Deep-merge stored overrides on top of the shipped defaults. */
export function mergeProviders(overrides = {}) {
  const out = {};
  for (const id of Object.keys(DEFAULT_PROVIDERS)) {
    const base = DEFAULT_PROVIDERS[id];
    const over = overrides[id] || {};
    out[id] = {
      ...base,
      ...over,
      selectors: { ...base.selectors, ...(over.selectors || {}) }
    };
  }
  return out;
}
