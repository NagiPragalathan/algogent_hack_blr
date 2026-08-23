import { cn } from "@/lib/utils";

/**
 * Two concentric rings — the wallet sitting inside the agent that spends from
 * it. It appears at two sizes (navbar and CTA), so the ring diameters are
 * props rather than a second copy of the markup.
 */
export function LogoMark({
  outer = "w-7 h-7",
  inner = "w-3 h-3",
  className,
}: {
  outer?: string;
  inner?: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center justify-center rounded-full border-2 border-foreground/60",
        outer,
        className,
      )}
    >
      <span className={cn("rounded-full border border-foreground/60", inner)} />
    </span>
  );
}
