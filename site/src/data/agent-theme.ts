/**
 * The one place an agent's colour is decided.
 *
 * The catalogue in `agents.ts` is contract and copy — what a call accepts,
 * returns and costs — and a hex value is neither, so the tint lives here and
 * is keyed by agent id. Two consequences that are the point of the split: a
 * new agent cannot ship without a tint (the Record is exhaustive over AgentId,
 * so TypeScript refuses), and a palette change never touches a line of the
 * contract.
 *
 * Every hue is a mid-tone, because each one has to read twice: as a stroke on
 * the cream listing (#F6E4CF) and as a stroke on the ink cards. A pastel
 * disappears on cream and a deep saturated primary disappears on ink, so the
 * set sits in the band that survives both — and they are all warm-adjacent so
 * they belong to the cream ground rather than fighting it.
 */
import type { AgentId } from "@/data/agents";

export interface AgentTint {
  /** Gradient start — the deeper of the pair, and the flat colour when one is needed. */
  from: string;
  /** Gradient end. */
  to: string;
  /**
   * The same hue as bare HSL channels, so a consumer can alpha-modify it for
   * a glow or a wash (`hsl(var(--tint) / 0.12)`) instead of needing a second
   * hex per opacity.
   */
  hsl: string;
}

export const AGENT_TINT: Record<AgentId, AgentTint> = {
  "form-filler": { from: "#C2562F", to: "#D0693A", hsl: "17 61% 47%" },
  "linkedin-apply": { from: "#4A5B8C", to: "#6A80B8", hsl: "226 31% 42%" },
  "mail-automation": { from: "#5F7A3C", to: "#7C9A4C", hsl: "85 34% 36%" },
  "web-search": { from: "#B8801F", to: "#CC9A33", hsl: "38 71% 42%" },
};

/**
 * Inline style carrying the tint into CSS custom properties, so a card can
 * paint a border, a glow and a gradient from one object without three props.
 */
export function tintVars(id: AgentId): React.CSSProperties {
  const tint = AGENT_TINT[id];
  return {
    ["--tint-from" as string]: tint.from,
    ["--tint-to" as string]: tint.to,
    ["--tint" as string]: tint.hsl,
  };
}
