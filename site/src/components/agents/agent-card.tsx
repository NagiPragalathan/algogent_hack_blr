import { useState } from "react";
import { Link } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowUpRight, ChevronDown } from "lucide-react";
import { AgentGlyph } from "@/components/agents/agent-glyph";
import { AgentContract } from "@/components/agents/agent-contract";
import { HealthBadge } from "@/components/agents/agent-health";
import { tintVars } from "@/data/agent-theme";
import { quote, SAMPLE_CALL, type Agent } from "@/data/agents";
import type { HealthState } from "@/hooks/use-agent-health";
import { cn } from "@/lib/utils";

/**
 * One agent in a grid, on the cream ground.
 *
 * The contract stays collapsed behind a disclosure rather than being cut to a
 * summary, because a truncated schema is the one thing a buyer cannot act on —
 * they are here to find out exactly what comes back. The link beside it goes
 * to the same agent on the directory page, where the contract is open by
 * default and there is room for two columns of it.
 */
export function AgentCard({
  agent,
  health,
  delay,
}: {
  agent: Agent;
  health: HealthState;
  delay: number;
}) {
  const [open, setOpen] = useState(false);
  const price = quote(
    agent.pricing,
    SAMPLE_CALL.inputTokens,
    SAMPLE_CALL.outputTokens,
  );

  return (
    <motion.article
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-100px" }}
      transition={{ duration: 0.6, delay, ease: "easeOut" }}
      style={tintVars(agent.id)}
      className="tint-card bg-paper border border-sand rounded-3xl p-6 flex flex-col"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="relative -ml-1">
          {/* Sits behind the glyph and is purely light — aria-hidden on the
              glyph covers it, and it must never take a pointer event. */}
          <div className="tint-bloom absolute inset-3 rounded-full pointer-events-none" />
          <AgentGlyph id={agent.id} className="relative w-20 h-20" />
        </div>
        <HealthBadge health={health} />
      </div>

      <p className="mt-4 text-[10px] tracking-[2px] uppercase text-[hsl(var(--tint))] font-semibold">
        {agent.category}
      </p>

      <h3 className="mt-2 text-ink font-semibold text-lg">
        {agent.name.replace(agent.accent, "").trim()}{" "}
        <em className="not-italic accent-serif text-xl">{agent.accent}</em>
      </h3>
      <p className="mt-2 text-ink/65 text-sm leading-relaxed">{agent.tagline}</p>

      {/* mt-auto rather than a fixed margin: the taglines run to different
          line counts, and without it the price row sits at a different height
          in every card of the row. */}
      <dl className="mt-auto pt-5 border-t border-sand space-y-2 text-xs">
        <div className="flex justify-between gap-3">
          <dt className="text-ink/55">Typical call</dt>
          <dd className="font-semibold tabular-nums text-[hsl(var(--tint))]">
            ${price.toFixed(4)}
          </dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-ink/55">Runtime</dt>
          <dd className="text-ink/75 text-right">{agent.runtime}</dd>
        </div>
      </dl>

      <div className="mt-5 flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex items-center gap-1.5 text-xs text-ink/60 hover:text-ink transition-colors"
        >
          {open ? "Hide contract" : "View contract"}
          <ChevronDown
            className={cn(
              "w-3.5 h-3.5 transition-transform",
              open && "rotate-180",
            )}
          />
        </button>

        <Link
          to={`/agents#${agent.id}`}
          className="flex items-center gap-1 text-xs font-medium text-[hsl(var(--tint))] hover:opacity-70 transition-opacity"
        >
          Full spec
          <ArrowUpRight className="w-3.5 h-3.5" />
        </Link>
      </div>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: "easeOut" }}
            className="overflow-hidden"
          >
            <AgentContract agent={agent} className="pt-5" />
          </motion.div>
        )}
      </AnimatePresence>
    </motion.article>
  );
}
