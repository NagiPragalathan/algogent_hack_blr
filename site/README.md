# Algogent — marketing site

The public site for the agent marketplace. React + TypeScript + Vite, styled
with Tailwind, icons from lucide-react. No other UI library.

```bash
npm install
npm run dev      # vite dev server
npm run build    # tsc -b && vite build
npm run lint     # oxlint
node tests/pricing.test.ts
```

See `.env.example` for the full list. The three the front end reads are all
optional, and each degrades to something honest rather than to a lie: with
`VITE_REGISTRY_URL` unset every listing reports "No registry" instead of
claiming an availability nobody asked about; with `VITE_WAITLIST_URL` unset the
access form hands off to the visitor's own mail client rather than reporting a
success that nothing performed; and with `VITE_API_BASE` unset the payments API
is called on the same origin. The unprefixed variables in that file
(`DATABASE_URL`, `COMPANY_PAYOUT_ADDRESS`, …) belong to the serverless payments
layer in `api/` and are deliberately never bundled into the browser build.

---

## Routes

| Path      | Page                | What it answers                                  |
| --------- | ------------------- | ------------------------------------------------ |
| `/`       | `src/pages/home.tsx`   | "Is there anything here for me?" — one screen each of pitch, mission, mechanics, catalogue, price |
| `/agents` | `src/pages/agents.tsx` | "Exactly what does this return, and what does it cost when it fails?" — the full contract per agent, searchable |
| `/publish`| `src/pages/publish.tsx` | The sell side: register an agent and a payout address. Linked from the footer, not the navbar — most visitors are buyers |
| `*`       | redirect to `/`     | three routes exist; anything else is a stale URL   |

Routing is `BrowserRouter`, not `HashRouter`, because the page already uses the
hash for in-page anchors (`#agents`, `#how-it-works`, `#pricing`, `#access`).
**The host must serve `index.html` for unknown paths** or a direct load of
`/agents` 404s — `vercel.json` (rewrites) and `public/_redirects` (Netlify,
Cloudflare Pages) both cover this.

---

## Deploying

The build is static (`npm run build` → `dist/`) plus the serverless functions in
`api/`. Two things bite on a first deploy:

**Serve `index.html` for unknown paths.** `vercel.json` and `public/_redirects`
both do this. Without it, a direct load of `/agents` or `/publish` 404s even
though the routes work fine once the app has booted.

**Set the payments variables on every deployment, previews included.** The
functions in `api/` read `COMPANY_PAYOUT_ADDRESS` at import and throw without
it — deliberately, because defaulting it would either send the marketplace's
share nowhere or silently hand it to the developer. So a preview deploy that is
missing these looks broken rather than degraded:

```
DATABASE_URL             Neon connection string
COMPANY_PAYOUT_ADDRESS   required, no default
COMPANY_FEE_BPS          2000 = 20%
X402_NETWORK             testnet | mainnet | localnet
```

The front end survives it — `/publish` shows its degraded revenue-split card and
the agent listings report "No registry" — but nothing can actually be
registered or settled until those four are present.

**`CLIENT_MNEMONIC` is what makes the extension stop asking for signatures.**
It is the account the marketplace signs with when nobody is there to approve,
and with it set the extension pays for each agent step by itself — no wallet, no
popup. Unset, everything still works: the extension falls back to prompting the
user's own wallet once at the end of a run, which is what it did before this
existed. So a missing value degrades rather than breaks, and the one visible
symptom is a switch in the wallet panel reporting "no client account is
configured".

```
CLIENT_MNEMONIC          25 words. A hot key — see below
X402_AUTOSIGN            1 (default) | 0 to switch it off
X402_AUTOSIGN_MAINNET    1 to allow unattended signing on MainNet
```

Read this before setting it. There is no confirmation step in front of that key:
anything that can reach `/api/x402/run` with `autoSign` can spend from it,
bounded only by the price list and the 120-action cap per request. Use a
throwaway account, fund it with what you are willing to lose, and keep it off
MainNet — which is why MainNet needs `X402_AUTOSIGN_MAINNET=1` said separately
rather than being inherited by changing `X402_NETWORK`.

A user can also supply their own phrase from the extension's wallet panel, in
which case theirs pays and this one is the fallback. It arrives on the settle
request, is used once and dropped: never stored, never logged, never written to
the on-chain note, and only ever the derived public address goes back.

`POST /api/x402/client` with `{ mnemonic }` answers "whose account is this, and
can it pay?" — which is how the panel validates a pasted phrase, since it has no
bundler and cannot derive an Algorand address itself. `GET` the same path
reports whether this deployment pays for itself at all.

Verify the whole thing against real TestNet with `node tests/autopay-live.test.mjs`
— it signs and submits for real, and asserts the receipt that comes back.

---

## Where things live

```
src/
  App.tsx                  routes + the chrome that is on every one of them
  main.tsx                 ENTRY: fonts, BrowserRouter, render
  index.css                palette tokens, base layer, the four custom classes

  pages/
    home.tsx               section order for the landing page
    agents.tsx             the directory page's layout
    publish.tsx            the sell side: registration form + revenue split

  components/
    navbar.tsx             floating pill, animated hamburger, dropdown
    hero.tsx               full-screen footage + the two-line heading
    about-section.tsx      the cream section; scroll-revealed mission paragraph
    features-section.tsx   sticky left column + IntersectionObserver cards
    pricing.tsx            the price as arithmetic, per agent
    cta.tsx                closing section; the ONLY place the access form lives
    footer.tsx
    brand-mark.tsx         the mark, filled with currentColor
    scroll-manager.tsx     where a navigation lands (top, or an anchor)
    ui/button.tsx          the four button grounds
    agents/
      agent-glyph.tsx      per-agent line art, inline so it can be tinted
      agent-card.tsx       grid card (home)
      agent-row.tsx        full-width row, contract open (directory)
      agent-contract.tsx   input/output/failures/credentials — shared by both
      agent-health.tsx     the status pill
      agents-preview.tsx   the home page's catalogue section
      agents-directory.tsx search, category filter, sort, the listing
    publish/
      publish-form.tsx     the eight-field registration form
      field.tsx            one labelled control, wired for screen readers
      revenue-split.tsx    the split, read from the registry not typed here

  data/
    agents.ts              THE CATALOGUE: contract and copy. No colours, no availability
    agent-theme.ts         per-agent hues, keyed by agent id
    media.ts               every video URL the site uses, in one place

  hooks/
    use-agent-health.ts    availability, asked live
    use-hls.ts             an HLS source attached to a <video>
    use-page-title.ts      the document title per route
    use-registry-listing.ts  the payments registry, asked once per page

  lib/
    pricing.ts             the metering arithmetic (plain Node can test it)
    registry.ts            typed client for the payments API (owned elsewhere)
    motion.ts              the one shared entrance animation
    utils.ts               cn()

tests/
  pricing.test.ts          node tests/pricing.test.ts — no build step
```

### The lines that are deliberate

**`data/agents.ts` holds no colour and no availability.** A hex value is not a
contract, so tints live in `data/agent-theme.ts` keyed by `AgentId` — the
`Record` is exhaustive, so a new agent cannot ship without one. Availability is
not there either: a status baked into a file keeps reading "online" for an
agent that has been down for a week, so it is asked at request time by
`hooks/use-agent-health.ts`.

**`lib/pricing.ts` is separate from the catalogue** so `tests/pricing.test.ts`
can import the arithmetic without a bundler resolving asset imports.

**Nothing in `components/publish/` restates a rule the API owns.** The revenue
split is rendered from `RegistryListing.companyBps`, not from the string "80%",
and an API failure message is placed next to the right field rather than
paraphrased — the server knows things the form does not (address checksums, who
owns an id), and a paraphrase is how the two drift apart.

**The contract block is one component.** `agent-contract.tsx` renders on both
the card and the directory row at different widths. A second copy of that
markup is what drifts the first time a field is added.

---

## The design system

The chrome is two grounds and one ink; colour is spent only where it carries
meaning. Tokens are bare HSL channels in `src/index.css` so any of them can be
alpha-modified inline (`bg-ink/20`), and `tailwind.config.ts` only names them.

| Token       | Value     | Used for                                    |
| ----------- | --------- | ------------------------------------------- |
| `cream`     | `#F6E4CF` | the calm sections — about, catalogue, directory |
| `ink`       | `#321C04` | type on cream, and the pricing ground       |
| `ink-strong`| `#1F1003` | the features and footer ground              |
| `paper`     | `#FFF9F2` | cards on cream, buttons on footage          |
| `sand`      | `#D9C4AA` | dividers, hairlines, secondary buttons      |
| `sand-strong` | `#CEBA9E` | those, hovered                             |
| `status-*`  | live / wait / down | agent health — always paired with a word, never colour alone |

Sections alternate ground on purpose: footage → cream → ink → cream → ink →
footage. Two cream sections in a row read as one long section.

Typography is Inter (400/500/600) with **Instrument Serif italic** as the
accent cut, both self-hosted through `@fontsource` in `main.tsx` rather than
fetched from Google Fonts — same two families, no third-party request blocking
first paint. The accent is applied with `.accent-serif` on an `<em class="not-italic">`:
the slant has to come from the real italic file, not from the browser
faux-slanting an upright one.

Four custom classes, all in `index.css` and all documented there:
`.accent-serif`, `.tint-card`, `.tint-bloom`, `.cinematic-media`.

### Video

Every URL is in `src/data/media.ts`. Four assets cover six slots, so two of
them appear twice — that is visible in one file rather than hidden across four
components. `.cinematic-media` grades the footage (a mild contrast and
saturation lift); it used to be `grayscale(1)` and no longer is, because the
page has colour in it now and a desaturated video on a coloured page reads as a
broken asset rather than as a decision.
