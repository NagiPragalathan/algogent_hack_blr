import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { BrandMark } from "@/components/brand-mark";
import { MEDIA } from "@/data/media";
import { cn } from "@/lib/utils";

interface Feature {
  id: string;
  title: string;
  body: string;
  /** The card's footage. Null on the closing card, which carries chips instead. */
  video: string | null;
  /** Shown in place of the video when there is none. */
  chips?: string[];
}

const FEATURES: Feature[] = [
  {
    id: "metering",
    title: "Paid as it runs, not by the seat",
    body: "A call opens with a 402 challenge. The wallet signs and settles it, the agent runs, and the result comes back with the cost the run actually incurred — not an estimate, and not a monthly figure divided by usage.",
    video: MEDIA.solution,
  },
  {
    id: "receipts",
    title: "A receipt that points at the work",
    body: "Every settled call leaves a receipt tied to a logged action: which site was opened, which API was hit, what was submitted. Reconciling a charge means reading a line, not filing a ticket.",
    video: MEDIA.mission,
  },
  {
    id: "health",
    title: "Nothing stale is listed as ready",
    body: "An agent appears as available only if it answers a health check at request time. A green dot that has not been asked in a week is the one piece of a listing a buyer acts on, so it is never shown.",
    video: MEDIA.hero,
  },
  {
    id: "keys",
    title: "Your credentials, for that call only",
    body: "Sessions, OAuth grants and API keys are supplied per call and held for the length of it. The marketplace stores none of them, which is why every listing tells you exactly what it will ask you for.",
    video: null,
    chips: [
      "LinkedIn session",
      "Google OAuth",
      "Microsoft Entra",
      "Search API key",
      "Nothing persisted",
    ],
  },
];

/**
 * One card's footage. Its own component so a card that has no video does not
 * pay for a <video> element it never fills.
 */
function CardVideo({ src }: { src: string }) {
  return (
    <video
      className="w-full h-full object-cover cinematic-media"
      src={src}
      autoPlay
      loop
      muted
      playsInline
      preload="none"
      aria-hidden="true"
    />
  );
}

/**
 * The scroll-driven feature list.
 *
 * Two observers rather than one, because the two jobs want different
 * thresholds and conflating them makes both wrong. Reveal fires early (15%
 * visible) so a card is already sliding in as it clears the fold; the active
 * highlight fires late (60%) so the left column names the card the reader is
 * actually looking at, not the one whose top edge just appeared.
 *
 * Reveal is one-way on purpose — the `revealed` set only ever grows.
 * Re-hiding a card on the way back up turns a scroll upwards into a page that
 * flickers.
 */
export function FeaturesSection() {
  const cardRefs = useRef<(HTMLElement | null)[]>([]);
  const [active, setActive] = useState(0);
  const [revealed, setRevealed] = useState<Set<number>>(() => new Set());

  useEffect(() => {
    const cards = cardRefs.current.filter(Boolean) as HTMLElement[];
    if (cards.length === 0) return;

    const indexOf = (el: Element) =>
      Number((el as HTMLElement).dataset.index ?? -1);

    const activeObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setActive(indexOf(entry.target));
        }
      },
      { threshold: 0.6 },
    );

    const revealObserver = new IntersectionObserver(
      (entries) => {
        const arrived = entries
          .filter((e) => e.isIntersecting)
          .map((e) => indexOf(e.target));
        if (arrived.length === 0) return;
        setRevealed((prev) => new Set([...prev, ...arrived]));
      },
      { threshold: 0.15 },
    );

    for (const card of cards) {
      activeObserver.observe(card);
      revealObserver.observe(card);
    }

    return () => {
      activeObserver.disconnect();
      revealObserver.disconnect();
    };
  }, []);

  const goTo = (i: number) =>
    cardRefs.current[i]?.scrollIntoView({ behavior: "smooth", block: "center" });

  return (
    <section
      id="how-it-works"
      className="relative bg-ink-strong px-5 md:px-10 lg:px-16 py-20 md:py-40 lg:py-48"
    >
      {/* Standing in for a photographic backdrop: two warm washes over ink, so
          the glass cards have something to sit on other than flat black. */}
      <div
        className="absolute inset-0 -z-10 pointer-events-none"
        style={{
          background:
            "radial-gradient(60% 45% at 15% 10%, hsl(31 85% 22% / 0.85), transparent 70%), radial-gradient(55% 50% at 85% 75%, hsl(17 61% 30% / 0.65), transparent 72%)",
        }}
      />

      <div className="lg:grid lg:grid-cols-[400px_1fr] xl:grid-cols-[460px_1fr] lg:gap-24 xl:gap-48">
        <div className="lg:sticky lg:top-0 lg:h-screen lg:flex lg:flex-col lg:justify-between lg:py-32">
          <h2 className="text-white text-2xl sm:text-3xl lg:text-[46px] leading-[1.2] font-normal">
            Rails that move with the work,{" "}
            <em className="not-italic accent-serif">not over it</em>
          </h2>

          <nav className="hidden lg:flex flex-col gap-2 my-10">
            {FEATURES.map((f, i) => (
              <button
                key={f.id}
                type="button"
                onClick={() => goTo(i)}
                aria-current={active === i}
                className={cn(
                  "text-left text-sm rounded-xl px-4 py-3 bg-black/20 transition-colors",
                  active === i
                    ? "text-white"
                    : "text-white/40 hover:text-white/70",
                )}
              >
                {f.title}
              </button>
            ))}
          </nav>

          <div className="hidden lg:block">
            <p className="text-white/60 text-sm font-medium max-w-xs leading-relaxed">
              No seats. No subscription. Just work that really happened.
            </p>
            <Link
              to="/agents"
              className="inline-block mt-4 bg-white text-black text-sm font-medium px-5 py-2.5 rounded-xl hover:bg-white/90 transition-colors"
            >
              Browse agents
            </Link>
          </div>
        </div>

        <div className="flex flex-col gap-6 md:gap-10 mt-12 lg:mt-0">
          {FEATURES.map((feature, i) => (
            <article
              key={feature.id}
              data-index={i}
              ref={(el) => {
                cardRefs.current[i] = el;
              }}
              className={cn(
                "bg-black/20 backdrop-blur-sm rounded-3xl p-6 md:p-10 transition-all duration-700 ease-out",
                revealed.has(i)
                  ? "translate-x-0 opacity-100"
                  : "translate-x-16 opacity-0",
              )}
            >
              <BrandMark className="w-10 h-10 text-white/80" />

              <h3 className="text-white text-xl md:text-2xl font-medium mt-6">
                {feature.title}
              </h3>

              {feature.video ? (
                <div className="aspect-video rounded-2xl overflow-hidden bg-black/30 mt-6">
                  <CardVideo src={feature.video} />
                </div>
              ) : (
                <ul className="flex flex-wrap gap-2 mt-6">
                  {feature.chips?.map((chip) => (
                    <li
                      key={chip}
                      className="text-white/70 text-xs font-medium rounded-full border border-white/15 bg-white/[0.04] px-4 py-2"
                    >
                      {chip}
                    </li>
                  ))}
                </ul>
              )}

              <p className="text-white/60 font-medium text-sm md:text-base leading-relaxed mt-6">
                {feature.body}
              </p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
