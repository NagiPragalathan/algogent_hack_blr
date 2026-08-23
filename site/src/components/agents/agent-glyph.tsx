import { useId } from "react";
import { AGENT_TINT } from "@/data/agent-theme";
import type { AgentId } from "@/data/agents";
import { cn } from "@/lib/utils";

/**
 * The agent line art, inline rather than in `src/assets`.
 *
 * These were four .svg files loaded through <img>, and an <img> is opaque to
 * the page: nothing outside the file can reach the strokes, so every one of
 * them was hard-coded #fff and the whole row read as monochrome clip art. As
 * components the same geometry takes a per-agent gradient, so a card is
 * identifiable at a glance before its heading is read.
 *
 * The gradient id is from useId() because two cards on one page holding the
 * same literal id would both resolve to whichever <defs> the browser saw
 * first — the classic inline-SVG collision, and it renders as every glyph
 * wearing the first agent's colour.
 */

/** Faint concentric rings behind every glyph. Shared, so they are declared once. */
function Rings({ stroke }: { stroke: string }) {
  return (
    <>
      <circle cx="100" cy="100" r="86" stroke={stroke} strokeOpacity="0.3" />
      <circle cx="100" cy="100" r="64" stroke={stroke} strokeOpacity="0.18" />
    </>
  );
}

function FormGlyph({ s }: { s: string }) {
  return (
    <>
      <Rings stroke={s} />
      <rect x="60" y="42" width="80" height="112" rx="8" stroke={s} strokeOpacity="0.6" strokeWidth="2" />
      <path d="M76 70h48" stroke={s} strokeOpacity="0.95" strokeWidth="3" strokeLinecap="round" />
      <path d="M76 88h34" stroke={s} strokeOpacity="0.4" strokeWidth="3" strokeLinecap="round" />
      <rect x="74" y="102" width="52" height="16" rx="4" stroke={s} strokeOpacity="0.75" strokeWidth="2" />
      <path d="M82 110h26" stroke={s} strokeWidth="3" strokeLinecap="round" />
      <path d="M114 104v12" stroke={s} strokeWidth="2" strokeLinecap="round" />
      <path d="M76 134h30" stroke={s} strokeOpacity="0.4" strokeWidth="3" strokeLinecap="round" />
      <path d="M124 130l7 7 13-15" stroke={s} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    </>
  );
}

function LinkedInGlyph({ s }: { s: string }) {
  return (
    <>
      <Rings stroke={s} />
      <rect x="52" y="76" width="96" height="72" rx="8" stroke={s} strokeOpacity="0.6" strokeWidth="2" />
      <path d="M80 76V62a8 8 0 018-8h24a8 8 0 018 8v14" stroke={s} strokeOpacity="0.6" strokeWidth="2" strokeLinecap="round" />
      <path d="M52 104h96" stroke={s} strokeOpacity="0.35" strokeWidth="2" />
      <circle cx="100" cy="104" r="7" stroke={s} strokeWidth="2.5" />
      <path d="M74 126h18" stroke={s} strokeOpacity="0.95" strokeWidth="3" strokeLinecap="round" />
      <path d="M108 126h18" stroke={s} strokeOpacity="0.4" strokeWidth="3" strokeLinecap="round" />
      <circle cx="152" cy="58" r="12" stroke={s} strokeWidth="2.5" />
      <path d="M152 53v10M147 56h10" stroke={s} strokeWidth="2.5" strokeLinecap="round" />
    </>
  );
}

function MailGlyph({ s }: { s: string }) {
  return (
    <>
      <Rings stroke={s} />
      <rect x="50" y="66" width="100" height="70" rx="8" stroke={s} strokeOpacity="0.6" strokeWidth="2" />
      <path d="M52 74l44 32a8 8 0 009 0l43-32" stroke={s} strokeWidth="2.5" strokeLinecap="round" />
      <path d="M30 92h20M22 106h28M34 120h16" stroke={s} strokeOpacity="0.3" strokeWidth="3" strokeLinecap="round" />
      <circle cx="146" cy="140" r="16" fill="#000" stroke={s} strokeWidth="2.5" />
      <path d="M140 140l4 4 8-9" stroke={s} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    </>
  );
}

function SearchGlyph({ s }: { s: string }) {
  return (
    <>
      <Rings stroke={s} />
      <circle cx="92" cy="90" r="34" stroke={s} strokeWidth="3" />
      <circle cx="92" cy="90" r="20" stroke={s} strokeOpacity="0.3" strokeWidth="2" />
      <path d="M117 115l28 28" stroke={s} strokeWidth="5" strokeLinecap="round" />
      <path d="M74 84h36M74 96h24" stroke={s} strokeOpacity="0.65" strokeWidth="3" strokeLinecap="round" />
      <path d="M44 148h44" stroke={s} strokeOpacity="0.3" strokeWidth="3" strokeLinecap="round" />
    </>
  );
}

const GLYPH: Record<AgentId, (props: { s: string }) => React.ReactElement> = {
  "form-filler": FormGlyph,
  "linkedin-apply": LinkedInGlyph,
  "mail-automation": MailGlyph,
  "web-search": SearchGlyph,
};

export function AgentGlyph({
  id,
  className,
}: {
  id: AgentId;
  className?: string;
}) {
  const gradientId = useId();
  const tint = AGENT_TINT[id];
  const Glyph = GLYPH[id];

  return (
    <svg
      viewBox="0 0 200 200"
      fill="none"
      aria-hidden="true"
      className={cn("w-20 h-20", className)}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor={tint.from} />
          <stop offset="100%" stopColor={tint.to} />
        </linearGradient>
      </defs>
      <Glyph s={`url(#${gradientId})`} />
    </svg>
  );
}
