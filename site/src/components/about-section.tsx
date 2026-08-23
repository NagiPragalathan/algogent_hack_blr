import { useRef } from "react";
import { Link } from "react-router-dom";
import { Mail, Plus } from "lucide-react";
import {
  motion,
  useScroll,
  useTransform,
  type MotionValue,
} from "framer-motion";
import { BrandMark } from "@/components/brand-mark";

const PARAGRAPH =
  "We make the rails an agent gets paid on. But, most importantly, we make its price, its promise and its proof arrive together — so a charge can be reconciled against work that really happened, and a failure is named rather than dressed up as a result.";

/** Rendered at full ink; everything else settles a step lighter. */
const HIGHLIGHT = new Set(["price", "promise", "proof"]);

const bare = (word: string) => word.replace(/[^a-z]/gi, "").toLowerCase();

/**
 * One word of the reveal.
 *
 * Each word owns its own useTransform rather than the parent computing an
 * array of them, because hooks cannot be called from inside a map callback —
 * and pushing the subscription down here also means a word repaints alone
 * instead of re-rendering the whole paragraph on every scroll frame.
 */
function Word({
  children,
  progress,
  range,
  highlight,
}: {
  children: string;
  progress: MotionValue<number>;
  range: [number, number];
  highlight: boolean;
}) {
  const opacity = useTransform(progress, range, [0.2, 1]);
  return (
    <motion.span
      style={{ opacity }}
      className={highlight ? "inline-block mr-[0.25em] accent-serif" : "inline-block mr-[0.25em]"}
    >
      {children}
    </motion.span>
  );
}

/** A pill with a white disc holding its icon. Used for both calls to action. */
function IconPill({
  to,
  icon: Icon,
  children,
  tone,
}: {
  to: string;
  icon: typeof Mail;
  children: React.ReactNode;
  tone: "ink" | "sand";
}) {
  const skin =
    tone === "ink"
      ? "bg-ink text-paper hover:bg-ink-strong"
      : "bg-sand text-ink hover:bg-sand-strong";

  // An external scheme (mailto:) is not a route — handing it to <Link> would
  // push it onto the history stack and render a blank page.
  const isRoute = to.startsWith("/");
  const content = (
    <>
      <span className="w-7 h-7 rounded-full bg-white flex items-center justify-center shrink-0">
        <Icon size={16} className="text-ink" />
      </span>
      <span className="uppercase tracking-wide font-medium text-sm">
        {children}
      </span>
    </>
  );
  const className = `inline-flex items-center gap-3 rounded-full pl-1 pr-6 py-1 transition-colors ${skin}`;

  return isRoute ? (
    <Link to={to} className={className}>
      {content}
    </Link>
  ) : (
    <a href={to} className={className}>
      {content}
    </a>
  );
}

/**
 * The cream section.
 *
 * `rounded-t-[25px]` with `relative z-10` against the hero's negative bottom
 * margin — the two are one effect and neither works alone.
 */
export function AboutSection() {
  const ref = useRef<HTMLParagraphElement>(null);

  // The text finishes revealing well before it leaves the viewport, so the
  // reader is never chasing the last word off the bottom of the screen.
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ["start 0.9", "end 0.65"],
  });

  const words = PARAGRAPH.split(" ");

  return (
    <section className="relative z-10 bg-cream rounded-t-[25px] py-20 md:py-32 px-6">
      <div className="max-w-3xl mx-auto flex flex-col items-center">
        <p className="text-ink text-base md:text-lg text-center leading-relaxed max-w-lg">
          We build tools that move with the work, not over it. Designed for
          calls you can check, receipts you can read, and prices that hold
          still.
        </p>

        <div className="flex flex-wrap items-center justify-center gap-4 mt-8">
          <IconPill to="mailto:access@agenticwallet.dev" icon={Mail} tone="ink">
            Say hello
          </IconPill>
          <IconPill to="/#access" icon={Plus} tone="sand">
            Stay informed
          </IconPill>
        </div>
      </div>

      <div className="flex items-center gap-[2px] mt-20 md:mt-28">
        <span className="w-2 h-2 rounded-full bg-sand shrink-0" />
        <span className="flex-1 h-[2px] bg-sand" />
        <span className="w-2 h-2 rounded-full bg-sand shrink-0" />
      </div>

      <div className="max-w-6xl mx-auto flex flex-col md:flex-row gap-10 md:gap-16 mt-16 md:mt-24">
        <div className="shrink-0 flex md:flex-col items-center md:items-start gap-4">
          <BrandMark className="w-10 h-10 text-ink" />
          <p className="text-xs uppercase tracking-widest font-semibold text-ink leading-relaxed">
            Metered
            <br />
            Provable
          </p>
        </div>

        <p
          ref={ref}
          className="text-2xl sm:text-3xl md:text-4xl lg:text-[42px] leading-[1.3] font-normal text-ink"
        >
          {words.map((word, i) => (
            <Word
              key={`${word}-${i}`}
              progress={scrollYProgress}
              // Each word claims a slice of the scroll, so the sentence fills
              // in left to right instead of the whole block fading at once.
              range={[i / words.length, (i + 1) / words.length]}
              highlight={HIGHLIGHT.has(bare(word))}
            >
              {word}
            </Word>
          ))}
        </p>
      </div>
    </section>
  );
}
