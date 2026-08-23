import { motion } from "framer-motion";
import { AgentGlyph } from "@/components/agents/agent-glyph";
import { AgentContract, SectionLabel } from "@/components/agents/agent-contract";
import { HealthBadge } from "@/components/agents/agent-health";
import { tintVars } from "@/data/agent-theme";
import { quote, SAMPLE_CALL, type Agent } from "@/data/agents";
import type { HealthState } from "@/hooks/use-agent-health";

const usd = (n: number) => `$${n.toFixed(4)}`;

/**
 * One agent on the directory page, at full width and fully open.
 *
 * The card on the home page has to earn a click, so it leads with a tagline
 * and hides the schema. This is the page the click lands on, so nothing is
 * hidden: the whole contract is on screen and the price is shown as the three
 * terms that produce it rather than as a single figure, which is the same
 * claim the pricing section makes — a charge you can reconcile.
 *
 * `scroll-mt-32` is not decoration. The pill navbar floats over the page, so
 * an anchored jump from /agents#web-search would otherwise land with the
 * heading underneath it.
 */
export function AgentRow({
  agent,
  health,
  index,
}: {
  agent: Agent;
  health: HealthState;
  index: number;
}) {
  const { inputTokens, outputTokens } = SAMPLE_CALL;
  const inputCost = (inputTokens / 1_000_000) * agent.pricing.perMillionInputUsd;
  const outputCost =
    (outputTokens / 1_000_000) * agent.pricing.perMillionOutputUsd;
  const total = quote(agent.pricing, inputTokens, outputTokens);

  return (
    <motion.article
      id={agent.id}
      initial={{ opacity: 0, y: 24 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-80px" }}
      transition={{
        duration: 0.6,
        delay: Math.min(index, 3) * 0.06,
        ease: "easeOut",
      }}
      style={tintVars(agent.id)}
      className="tint-card bg-paper border border-sand rounded-3xl p-6 md:p-10 scroll-mt-32"
    >
      <div className="grid lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] gap-10">
        <div>
          <div className="flex items-start justify-between gap-3">
            <div className="relative -ml-2">
              <div className="tint-bloom absolute inset-4 rounded-full pointer-events-none" />
              <AgentGlyph id={agent.id} className="relative w-24 h-24" />
            </div>
            <HealthBadge health={health} />
          </div>

          <p className="mt-5 text-[10px] tracking-[2px] uppercase text-[hsl(var(--tint))] font-semibold">
            {agent.category}
          </p>

          <h2 className="mt-2 text-ink text-3xl font-normal tracking-tight">
            {agent.name.replace(agent.accent, "").trim()}{" "}
            <em className="not-italic accent-serif text-[2rem]">
              {agent.accent}
            </em>
          </h2>

          <p className="mt-3 text-ink/70 leading-relaxed">{agent.tagline}</p>

          <div className="mt-6">
            <SectionLabel>Runtime</SectionLabel>
            <p className="text-sm text-ink/75">{agent.runtime}</p>
          </div>

          <div className="mt-6 rounded-2xl border border-[hsl(var(--tint)/0.25)] bg-[hsl(var(--tint)/0.06)] p-4">
            <SectionLabel>
              Typical call · {inputTokens.toLocaleString()} in ·{" "}
              {outputTokens.toLocaleString()} out
            </SectionLabel>
            <dl className="space-y-1.5 text-xs">
              <div className="flex justify-between gap-3">
                <dt className="text-ink/55">Base</dt>
                <dd className="tabular-nums text-ink">
                  {usd(agent.pricing.baseUsd)}
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-ink/55">
                  Input · ${agent.pricing.perMillionInputUsd.toFixed(2)}/Mtok
                </dt>
                <dd className="tabular-nums text-ink">{usd(inputCost)}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-ink/55">
                  Output · ${agent.pricing.perMillionOutputUsd.toFixed(2)}/Mtok
                </dt>
                <dd className="tabular-nums text-ink">{usd(outputCost)}</dd>
              </div>
              <div className="flex justify-between gap-3 pt-2 mt-1 border-t border-[hsl(var(--tint)/0.25)]">
                <dt className="font-semibold text-ink">Total</dt>
                <dd className="tabular-nums font-semibold text-[hsl(var(--tint))]">
                  {usd(total)}
                </dd>
              </div>
            </dl>
          </div>
        </div>

        <AgentContract agent={agent} columns={2} />
      </div>
    </motion.article>
  );
}
