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
 * Colours are read on a pure black ground, so every one of them is a light
 * mid-tone rather than a saturated primary: a #0000FF on #000 is unreadable at
 * a 2px stroke, and the glyphs are all 2-3px strokes.
 */
import type { AgentId } from "@/data/agents";

export interface AgentTint {
  /** Stroke gradient start — the brighter of the pair. */
  from: string;
  /** Stroke gradient end. */
  to: string;
  /**
   * The same hue as bare HSL channels, so a consumer can alpha-modify it for
   * a glow or a wash (`hsl(var(--tint) / 0.12)`) instead of needing a second
   * hex per opacity.
   */
  hsl: string;
}

export const AGENT_TINT: Record<AgentId, AgentTint> = {
  "form-filler": { from: "#A78BFA", to: "#6D8BFF", hsl: "255 92% 76%" },
  "linkedin-apply": { from: "#5EB8FF", to: "#7FE7FF", hsl: "205 100% 68%" },
  "mail-automation": { from: "#4ADEA8", to: "#A5F3D0", hsl: "159 68% 58%" },
  "web-search": { from: "#FFC46B", to: "#FFE7B0", hsl: "36 100% 71%" },
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
