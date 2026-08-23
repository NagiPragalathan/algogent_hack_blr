# Sidebar AI

A Chrome/Edge side-panel extension that lets you ask **ChatGPT, Gemini, Claude and Meta AI** questions about the page you are currently looking at.

It does not use API keys. It drives each provider's own web app in a background tab using **the browser session you are already logged into**, so answers come out of your existing subscription.

---
 
## Read this before you install

This approach has real trade-offs. You picked it deliberately, but they are worth stating plainly:

- **It breaks when providers change their UI.** The extension finds the chat box, the send button and the reply text by CSS selector. When a provider ships a redesign, those selectors go stale and that provider stops answering. Every selector is editable from the Settings page so you can repair it in about two minutes — see [Fixing a broken provider](#fixing-a-broken-provider).
- **It is against each provider's terms of service.** OpenAI, Google, Anthropic and Meta all prohibit automated access to their consumer web apps. Using this can get your account rate-limited or banned. No hosting mode makes that risk go away — the choice below is between *more* and *less* detectable, never *safe*. That risk is yours to take.
- **What actually raises the risk is behaviour, not plumbing.** Whichever mode you pick, the pattern is machine-shaped: text appears instantly rather than being typed, there is no mouse movement, and *Compare* fires the same prompt at several providers within milliseconds. Occasional, human-paced use looks far more ordinary than heavy or automated use. If you want to keep your head down: leave Compare off for routine questions, and don't run it in a loop.
- **Bot checks can interrupt it.** A Cloudflare challenge or captcha in the background tab will stall a reply. Open the provider window (`⋯ → Show provider window`) and clear it manually.
- **Two ways to host the providers**, switchable in Settings → *Provider hosting*:
  - **Minimized window** (default) — a real tab in a minimized window. A genuine top-level page load, indistinguishable from ordinary browsing at the network layer, so it is the option least likely to be flagged as automation. Costs one taskbar slot; no extension API can hide a window from there.
  - **Background frames** — the provider apps run in an invisible offscreen document. No window, no tab, nothing in the taskbar. But a framed load announces itself: the request carries `Sec-Fetch-Dest: iframe` and `Sec-Fetch-Site: cross-site`, and the page can read `window.top !== window.self`. It also needs *Relax session cookies*. Invisible, but **more** detectable than a window.
- **Background frames need a cookie change to stay logged in.** A frame inside an extension page is a cross-site context, and `SameSite=Lax` session cookies are not sent there — so the frames show a signed-out page however often you log in. *Relax session cookies* rewrites them to `SameSite=None`, which **weakens CSRF protection on those accounts**. It is off by default. If you would rather not, use *Minimized window* hosting instead.
- **Framing the providers requires stripping response headers.** `rules/frame-rules.json` removes `X-Frame-Options` and `Content-Security-Policy` from the providers' responses, scoped to `sub_frame` loads of those hosts only — normal browsing of those sites is untouched. It does mean any page could iframe them while this extension is installed.
- **Meta AI is the least reliable of the four.** meta.ai ships obfuscated class names and is geo-restricted, so its selectors are structural guesses. It ships **disabled** — enable it in Settings and expect to tune its selectors yourself.

If any of this becomes a problem, the alternative is the API-key route: swap the adapter for direct calls to each provider's API. The provider layer is isolated enough that this is a contained change.

---

## Install

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this folder:
   `c:\Users\Admin\Documents\Work\Chat_sider`
4. Pin the extension, then click its icon (or press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Y</kbd>) to open the side panel.

**First run:** the first question to each provider opens a background window and needs you to be signed in. If you are not, the panel shows a **Sign in to …** button — click it, log in, then ask again. The window then goes back to being minimized.

Requires Chrome or Edge 116+ (the `sidePanel` API). Works in Brave and Opera too.

---

## Using it

| Control | What it does |
|---|---|
| Provider tabs | Pick which AI answers. |
| **◷** | Chat history — every past session, newest first. Click one to reopen and continue it; 🗑 deletes one. |
| **⇄** | Compare mode — every enabled provider answers the same question, stacked in one thread. |
| **✚** | New conversation. The current one is banked into history first, not discarded. |
| **Use this page** | Toggles whether the page's readable content is attached to your question. |
| Context chip | Click to preview exactly what text will be sent. **⟳** re-reads the page. |
| Quick actions | Summarise / Key points / Explain / Fact-check / Translate. |
| **⋯** | Show, hide or close the provider window; clear the thread; open Settings. |

<kbd>Enter</kbd> sends, <kbd>Shift</kbd>+<kbd>Enter</kbd> adds a newline.

**Selected text wins.** If you highlight something on the page before asking, that selection is sent alongside the page content and marked as what you're pointing at.

**History lives in two places.** The **◷** button lists your past sessions inside the panel — up to 50, each holding its last 60 questions. Reopening one restores the transcript *and* points the providers back at the thread it was using, so your next question continues it rather than starting fresh. The provider's own site keeps its copy too; `⋯ → Open this chat on the provider site` opens it in a normal tab.

**Conversations continue.** Each provider rewrites its URL to a real conversation path (`/c/<id>`, `/chat/<uuid>`, `/app/<id>`) once your first message lands. That URL is stored per provider, so the next question — even days later, in a new browser session — reopens the same thread. The model keeps its context, and the provider's own history shows one ongoing conversation rather than a pile of one-question chats. Press **✚** when you want to break off and start fresh; that clears the stored thread for whichever providers are selected.

---

## How it works

```
side panel  ──port──►  service worker  ──tabs.sendMessage──►  adapter (relay tab)
    ▲                        │                                       │
    └────────stream──────────┴──────────runtime.sendMessage──────────┘
                             │
                             └──►  page-context.js  (your active tab)
```

- **`src/content/page-context.js`** — sits on every page doing nothing until asked, then extracts a readable, lightly-structured version of the page (prefers `<article>`/`<main>`, drops nav/ads/hidden panels, keeps heading and list shape, deduplicates boilerplate).
- **`src/background/relay.js`** — providers all send `frame-ancestors` headers, so they cannot be embedded in an iframe. Instead one popup window holds a real tab per provider, parked minimized or offscreen.
- **`src/adapters/adapter.js`** — one universal adapter for all four providers. Types the question, clicks send, watches the reply stream in, and converts the rendered HTML back to markdown.
- **`src/providers/config.js`** — the only thing that differs per provider: a table of candidate selectors.
- **`src/background/service-worker.js`** — wraps your question with the page extract, fans it out to every selected provider in parallel, and relays the stream back.

Two details worth knowing if you modify this:

**Typing uses `document.execCommand('insertText')`.** ChatGPT and Claude use ProseMirror, Gemini uses Quill, Meta uses Lexical. All of them ignore direct `.value`/`.textContent` assignment — their internal document model stays empty and the send button stays disabled. `execCommand` makes the browser emit genuine `beforeinput`/`input` events, which every one of those editors accepts. There are three fallbacks behind it.

**Completion is detected three ways at once.** The stop button, an optional streaming marker, and text stability (reply unchanged for N ms). Losing any one signal to a UI change degrades the experience rather than breaking it.

---

## Fixing a broken provider

When a provider stops answering:

1. Open **Settings** (`⋯ → Settings & selectors`) and set **Provider window → Visible**.
2. Ask a question and watch what actually happens in that window.

| What you see | Which selector is stale |
|---|---|
| Nothing is typed into the box | `composer` |
| Text is typed but never sent | `send` |
| Reply appears in the provider but stays blank in the panel | `assistant` |
| Reply gets cut off early | `stop` / `streaming` — or raise **Reply-settled delay** |
| Panel claims you're signed out when you aren't | `loggedOut` |

3. Right-click the element in the provider window → **Inspect**, then work out a stable CSS selector for it. Prefer `data-testid` and `aria-label` attributes; avoid hashed class names like `.css-1x2y3z`, which change on every deploy.
4. Paste it on the **first line** of that selector box in Settings. The list is tried top to bottom, so leaving the old lines underneath costs nothing and gives you a fallback.
5. **Save**, then reopen the side panel.

**Reset everything to defaults** restores the shipped selectors if you paint yourself into a corner.

---

## Settings

| Setting | Default | Notes |
|---|---|---|
| Page context size | 6000 chars | Larger gives better answers on long pages but is slower and can hit the provider's message-length limit. |
| Send page context by default | on | Starting position of the *Use this page* switch. |
| Provider window | Minimized | Use *Visible* when debugging selectors. |
| Reply-settled delay | 1500 ms | Raise if replies get cut off early; lower if finished replies feel sluggish. |
| Response timeout | 300000 ms | Hard ceiling on one reply. |
| Page-ready timeout | 45000 ms | How long to wait for a provider tab to boot. |

---

## Layout

```
manifest.json
icons/                        icon16 / 48 / 128
rules/frame-rules.json        strips X-Frame-Options / CSP for sub_frame loads
src/
  providers/config.js         per-provider selector tables + defaults
  offscreen/                  invisible host for the provider frames
  background/
    service-worker.js         coordinator: settings, context, fan-out
    embedded.js               background-frame transport + cookie relaxation
    relay.js                  relay window and per-provider tabs
  content/page-context.js     readable-content extractor
  adapters/adapter.js         universal provider driver
  sidepanel/
    sidepanel.html/.css/.js   the panel UI
    markdown.js               escape-first markdown renderer
  options/
    options.html/.css/.js     settings + selector editor
```

## Privacy

Page content is sent only to the provider you ask, through a tab in your own browser. There is no backend, no telemetry, and no third-party endpoint. Conversation history and settings live in `chrome.storage.local` on this machine; the last 40 turns are kept.

Everything the providers return is HTML-escaped before rendering, and links are restricted to `http`/`https`/`mailto` — a compromised or malicious provider response cannot inject markup into the panel.
