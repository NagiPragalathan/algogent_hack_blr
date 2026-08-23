import { motion } from "framer-motion";
import { fadeUp } from "@/lib/motion";

const SOLUTION_VIDEO =
  "https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260325_125119_8e5ae31c-0021-4396-bc08-f7aebeb877a2.mp4";

const FEATURES = [
  {
    title: "x402 Metering",
    body: "A call opens with a 402 challenge. The wallet signs and settles it, the agent runs, and the result comes back with the cost the run actually incurred.",
  },
  {
    title: "On-chain Receipts",
    body: "Every settled call leaves a receipt that points at a logged action — which site was opened, which API was hit, what was submitted.",
  },
  {
    title: "Live Health Checks",
    body: "The extension lists an agent only if it answers a health check at request time. Nothing stale is ever presented as available.",
  },
  {
    title: "Bring Your Own Keys",
    body: "Sessions, OAuth grants and API keys are supplied per call and held for that call alone. The marketplace stores none of them.",
  },
];

export function Solution() {
  return (
    <section
      id="how-it-works"
      className="py-32 md:py-44 px-8 md:px-28 border-t border-border/30"
    >
      <motion.p
        {...fadeUp(0)}
        className="text-xs tracking-[3px] uppercase text-muted-foreground text-center"
      >
        Solution
      </motion.p>

      <motion.h2
        {...fadeUp(0.08)}
        className="text-4xl md:text-6xl font-medium tracking-[-1.5px] text-center mt-6 max-w-4xl mx-auto leading-[1.1]"
      >
        The rails for{" "}
        <span className="font-serif italic font-normal">metered</span> agent
        calls
      </motion.h2>

      <motion.div {...fadeUp(0.16)} className="mt-16 max-w-6xl mx-auto">
        <video
          className="w-full rounded-2xl aspect-[3/1] object-cover cinematic-media"
          src={SOLUTION_VIDEO}
          autoPlay
          loop
          muted
          playsInline
          preload="metadata"
          aria-hidden="true"
        />
      </motion.div>

      <div className="grid md:grid-cols-4 gap-8 mt-20 max-w-6xl mx-auto">
        {FEATURES.map((feature, i) => (
          <motion.div key={feature.title} {...fadeUp(0.2 + i * 0.08)}>
            <h3 className="font-semibold text-base">{feature.title}</h3>
            <p className="text-muted-foreground text-sm mt-3 leading-relaxed">
              {feature.body}
            </p>
          </motion.div>
        ))}
      </div>
    </section>
  );
}
