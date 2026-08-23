import { useRef } from "react";
import {
  motion,
  useScroll,
  useTransform,
  type MotionValue,
} from "framer-motion";

const MISSION_VIDEO =
  "https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260325_132944_a0d124bb-eaa1-4082-aa30-2310efb42b4b.mp4";

const PARAGRAPH_ONE =
  "We are building a marketplace where an agent price, its promise and its proof arrive together — where every call is metered against work that really happened, and a failure is named rather than dressed up as a result.";

const PARAGRAPH_TWO =
  "A platform where agents, payments and audit trails move as one — with less trust required, less reconciliation, and more certainty for everyone paying for work.";

/** Rendered at full white; everything else settles at the softer hero tone. */
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
  const opacity = useTransform(progress, range, [0.15, 1]);
  return (
    <motion.span
      style={{
        opacity,
        color: highlight ? "hsl(var(--foreground))" : "hsl(var(--hero-subtitle))",
      }}
      className="inline-block mr-[0.25em]"
    >
      {children}
    </motion.span>
  );
}

function Reveal({
  text,
  progress,
  className,
}: {
  text: string;
  progress: MotionValue<number>;
  className: string;
}) {
  const words = text.split(" ");
  return (
    <p className={className}>
      {words.map((word, i) => (
        <Word
          key={`${word}-${i}`}
          progress={progress}
          // Each word claims a slice of the scroll, so the sentence fills in
          // left to right instead of the whole block fading at once.
          range={[i / words.length, (i + 1) / words.length]}
          highlight={HIGHLIGHT.has(bare(word))}
        >
          {word}
        </Word>
      ))}
    </p>
  );
}

export function Mission() {
  const ref = useRef<HTMLDivElement>(null);

  // The text finishes revealing well before it leaves the viewport, so the
  // reader is never chasing the last word off the bottom of the screen.
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ["start 0.85", "end 0.6"],
  });

  return (
    <section className="pt-0 pb-32 md:pb-44 px-8 md:px-28">
      <video
        className="w-full max-w-[800px] mx-auto aspect-square object-cover monochrome-media"
        src={MISSION_VIDEO}
        width={800}
        height={800}
        autoPlay
        loop
        muted
        playsInline
        preload="metadata"
        aria-hidden="true"
      />

      <div ref={ref} className="max-w-5xl mx-auto text-center mt-16 md:mt-24">
        <Reveal
          text={PARAGRAPH_ONE}
          progress={scrollYProgress}
          className="text-2xl md:text-4xl lg:text-5xl font-medium tracking-[-1px] leading-[1.25]"
        />
        <Reveal
          text={PARAGRAPH_TWO}
          progress={scrollYProgress}
          className="text-xl md:text-2xl lg:text-3xl font-medium mt-10 leading-[1.35]"
        />
      </div>
    </section>
  );
}
