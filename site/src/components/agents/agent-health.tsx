import { cn } from "@/lib/utils";
import { HEALTH_LABEL, type HealthState } from "@/hooks/use-agent-health";

/**
 * The status pill.
 *
 * Colour and word always travel together — the word is the accessible name of
 * the state and the dot only makes it scannable, so nothing here is ever the
 * sole carrier of the meaning. `unconfigured` stays neutral on purpose: this
 * build genuinely does not know, and a red dot would report a failure that has
 * not happened.
 *
 * Every colour is stated at a weight that clears 4.5:1 on both grounds the
 * pill appears on — paper cards on the cream listing, and the ink ground of
 * the directory rows.
 */
const DOT: Record<HealthState, string> = {
  online: "bg-status-live",
  checking: "bg-status-wait animate-pulse",
  offline: "bg-status-down",
  unconfigured: "bg-ink/25",
};

const SKIN: Record<HealthState, string> = {
  online: "text-status-live border-status-live/35 bg-status-live/[0.08]",
  checking: "text-status-wait border-status-wait/35 bg-status-wait/[0.08]",
  offline: "text-status-down border-status-down/35 bg-status-down/[0.08]",
  unconfigured: "text-ink/55 border-ink/20 bg-ink/[0.04]",
};

export function HealthBadge({
  health,
  className,
}: {
  health: HealthState;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 shrink-0 rounded-full border px-3 py-1 text-[11px] font-medium tracking-wide",
        SKIN[health],
        className,
      )}
    >
      <span className={cn("w-1.5 h-1.5 rounded-full", DOT[health])} />
      {HEALTH_LABEL[health]}
    </span>
  );
}
