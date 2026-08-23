import type { TargetAndTransition } from "framer-motion";

/**
 * The one entrance used across every section. It is a prop bag rather than a
 * variant map so a caller can stagger siblings by passing a delay instead of
 * wiring a parent orchestrator — the sections here are flat lists of unrelated
 * elements, and a container variant would mean threading `variants` through
 * markup that has no other reason to know about animation.
 *
 * `viewport.once` matters: replaying the entrance every time a section
 * re-enters the viewport turns a scroll back up into a page that flickers.
 */
export const fadeUp = (delay: number) => ({
  initial: { opacity: 0, y: 20 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, margin: "-100px" },
  transition: { duration: 0.6, delay, ease: "easeOut" },
}) as const;

/** Hover/press feedback shared by the two solid call-to-action buttons. */
export const pressable: {
  whileHover: TargetAndTransition;
  whileTap: TargetAndTransition;
} = {
  whileHover: { scale: 1.03 },
  whileTap: { scale: 0.98 },
};
