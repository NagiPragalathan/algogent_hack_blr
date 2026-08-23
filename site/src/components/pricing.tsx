import { motion } from "framer-motion";
import { AGENTS, quote, SAMPLE_CALL } from "@/data/agents";
import { fadeUp } from "@/lib/motion";

const usd = (n: number) => `$${n.toFixed(4)}`;

/**
 * The price is shown as arithmetic rather than as a number, because the whole
 * claim of the marketplace is that a charge can be reconciled against the work
 * behind it. A single headline figure is exactly what that claim is not.
 */
export function Pricing() {
  const { inputTokens, outputTokens } = SAMPLE_CALL;

  return (
    <section
      id="pricing"
      className="py-32 md:py-44 px-8 md:px-28 border-t border-border/30"
    >
      <motion.p
        {...fadeUp(0)}
        className="text-xs tracking-[3px] uppercase text-muted-foreground text-center"
      >
        Pricing
      </motion.p>

      <motion.h2
        {...fadeUp(0.08)}
        className="text-4xl md:text-6xl font-medium tracking-[-1.5px] text-center mt-6 max-w-4xl mx-auto leading-[1.1]"
      >
        Priced by the{" "}
        <span className="font-serif italic font-normal">token</span>, not the
        seat
      </motion.h2>

      <motion.p
        {...fadeUp(0.14)}
        className="text-muted-foreground text-lg max-w-2xl mx-auto text-center mt-6"
      >
        A flat component covers the work that costs money but burns no tokens —
        a browser session, an outbound API call. Everything else is metered on
        what the request actually consumed.
      </motion.p>

      <motion.div
        {...fadeUp(0.2)}
        className="liquid-glass rounded-2xl mt-16 max-w-5xl mx-auto p-6 md:p-8"
      >
        <p className="text-sm text-muted-foreground mb-6">
          Worked against a representative call of{" "}
          <span className="text-foreground tabular-nums">
            {inputTokens.toLocaleString()}
          </span>{" "}
          input and{" "}
          <span className="text-foreground tabular-nums">
            {outputTokens.toLocaleString()}
          </span>{" "}
          output tokens.
        </p>

        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse min-w-[640px]">
            <thead>
              <tr className="text-left text-[11px] tracking-[2px] uppercase text-muted-foreground">
                <th className="pb-4 font-normal">Agent</th>
                <th className="pb-4 font-normal text-right">Base</th>
                <th className="pb-4 font-normal text-right">Input</th>
                <th className="pb-4 font-normal text-right">Output</th>
                <th className="pb-4 font-normal text-right">Per call</th>
              </tr>
            </thead>
            <tbody>
              {AGENTS.map((agent) => {
                const inCost = (inputTokens / 1_000_000) * agent.pricing.perMillionInputUsd;
                const outCost = (outputTokens / 1_000_000) * agent.pricing.perMillionOutputUsd;
                const total = quote(agent.pricing, inputTokens, outputTokens);
                return (
                  <tr key={agent.id} className="border-t border-border/40">
                    <td className="py-4 font-medium">{agent.name}</td>
                    <td className="py-4 text-right tabular-nums text-muted-foreground">
                      {usd(agent.pricing.baseUsd)}
                    </td>
                    <td className="py-4 text-right tabular-nums text-muted-foreground">
                      {usd(inCost)}
                    </td>
                    <td className="py-4 text-right tabular-nums text-muted-foreground">
                      {usd(outCost)}
                    </td>
                    <td className="py-4 text-right tabular-nums font-medium">
                      {usd(total)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <p className="text-xs text-muted-foreground/70 mt-6 leading-relaxed">
          A call that returns a structured error is charged the tokens it
          consumed reaching that error and nothing more. A call that never
          reached the agent is not charged at all.
        </p>
      </motion.div>
    </section>
  );
}
