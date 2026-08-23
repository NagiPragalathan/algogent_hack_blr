import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { HEALTH_LABEL, type HealthState } from "@/hooks/use-agent-health";

/**
 * The dot beside the status word.
 *
 * Colour and word always travel together — the word is the accessible name of
 * the state and the dot only makes it scannable, so nothing here is ever the
 * sole carrier of the meaning. `unconfigured` stays grey on purpose: this
 * build genuinely does not know, and a red dot would report a failure that
 * has not happened.
 */
const DOT: Record<HealthState, string> = {
  online: "bg-status-live shadow-[0_0_10px_-1px_hsl(var(--status-live))]",
  checking: "bg-status-wait animate-pulse",
  offline: "bg-status-down",
  unconfigured: "bg-muted-foreground/40",
};

const TEXT: Record<HealthState, string> = {
  online: "text-status-live/90 border-status-live/30",
  checking: "text-status-wait/90 border-status-wait/30",
  offline: "text-status-down/90 border-status-down/30",
  unconfigured: "text-muted-foreground border-border",
};

export function HealthBadge({
  health,
  className,
}: {
  health: HealthState;
  className?: string;
}) {
  return (
    <Badge variant="outline" className={cn("shrink-0", TEXT[health], className)}>
      <span className={cn("w-1.5 h-1.5 rounded-full", DOT[health])} />
      {HEALTH_LABEL[health]}
    </Badge>
  );
}
