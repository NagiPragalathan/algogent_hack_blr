# AgenticWallet — marketplace site

The public landing page for the agent marketplace. Dark monochrome: pure black
ground, white ink, and one desaturated accent token that is never used as a
fill. React + Vite + TypeScript + Tailwind + shadcn/ui + Framer Motion.

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # tsc -b && vite build
npm run test     # node --test, no build step
npm run lint
```

## Layout

```
src/
  index.css              the design system: HSL tokens, .liquid-glass, .monochrome-media
  lib/
    pricing.ts           the metering arithmetic — the one piece with a test
    motion.ts            fadeUp(delay), the entrance every section shares
    utils.ts             cn()
  data/agents.ts         the catalogue: schemas, failure modes, rates
  hooks/use-agent-health.ts   live availability, four states
  components/
    ui/                  shadcn primitives (button, input, badge)
    navbar · hero · agents-section · agent-card
    mission · solution · pricing · cta · footer
  assets/                monochrome SVG icons and avatars
tests/pricing.test.ts
```

## Things worth knowing before you change something

**Availability is asked, never assumed.** `use-agent-health.ts` has four states
and `unconfigured` is a real one. With no `VITE_REGISTRY_URL` set, the build
genuinely does not know whether an agent is up, and the card says "No registry"
rather than defaulting to something reassuring. A stale green dot is worse than
no dot, because it is the one part of a listing a buyer acts on.

**The hero form does not claim to have done anything it did not do.** With no
`VITE_WAITLIST_URL` it hands off to the visitor own mail client. It never
renders a success state for a POST that went nowhere.

**The price is shown as arithmetic, not as a number.** The whole claim of the
marketplace is that a charge reconciles against the work behind it, and a single
headline figure is exactly what that claim is not. `pricing.ts` is separate from
`data/agents.ts` only so plain Node can test it — the catalogue imports SVGs,
which only a bundler resolves.

**`.monochrome-media` is why the supplied footage fits.** The videos are full
colour and the design is not. Deleting the filter is a one-line revert if the
colour is ever wanted back.

**The navbar is transparent over the hero and only there.** A fill on first
paint would cut a band across the footage, which is the reason it is declared
transparent at all. Past the fold it is a fixed bar sitting on cards and body
copy, so the backdrop fades in after 40px of scroll — without it the logo lands
on top of whatever is scrolling past.

**`mt-auto` on the agent card price row is load-bearing.** The taglines run to
different line counts, and a fixed margin puts the price at a different height
in every card of the row.

**hls.js is imported dynamically.** It is ~570kB and the CTA is the last section
on the page; loading it eagerly triples the initial bundle for footage nobody
has scrolled to. The `cancelled` flag in that effect is what makes it safe — the
import settles after an await, by which point the component may be gone.

**Instrument Serif is italic-only in practice.** It carries the accent word in
every heading. Inter carries everything else.

## Environment

Copy `.env.example` to `.env`. Both variables are optional and the page is
honest about their absence — see the two notes above.

| Variable | Effect when unset |
| --- | --- |
| `VITE_REGISTRY_URL` | Cards report "No registry" instead of an availability claim |
| `VITE_WAITLIST_URL` | The hero form hands off to `mailto:` instead of posting |
