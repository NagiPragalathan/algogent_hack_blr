import { AGENTS, quote, SAMPLE_CALL } from "@/data/agents";
import { AGENT_TINT } from "@/data/agent-theme";

const usd = (n: number) => `$${n.toFixed(4)}`;

/**
 * The price is shown as arithmetic rather than as a number, because the whole
 * claim of the marketplace is that a charge can be reconciled against the work
 * behind it. A single headline figure is exactly what that claim is not.
 *
 * The table keeps its own horizontal scroll container: five numeric columns do
 * not fold onto a phone, and letting them push the page sideways would break
 * every section above it.
 */
export function Pricing() {
  const { inputTokens, outputTokens } = SAMPLE_CALL;

  return (
    <section id="pricing" className="bg-ink py-24 md:py-36 px-6">
      <div className="max-w-5xl mx-auto">
        <p className="text-xs tracking-[3px] uppercase text-paper/50 text-center">
          Pricing
        </p>

        <h2 className="text-paper text-4xl md:text-6xl font-normal tracking-tight text-center mt-6 leading-[1.1]">
          Priced by the token,{" "}
          <em className="not-italic accent-serif">not the seat</em>
        </h2>

        <p className="text-paper/60 text-base md:text-lg max-w-2xl mx-auto text-center mt-6 font-medium leading-relaxed">
          A flat component covers the work that costs money but burns no tokens
          — a browser session, an outbound API call. Everything else is metered
          on what the request actually consumed.
        </p>

        <div className="mt-14 rounded-3xl border border-paper/10 bg-paper/[0.03] p-5 md:p-8">
          <p className="text-sm text-paper/60 mb-6">
            Worked against a representative call of{" "}
            <span className="text-paper tabular-nums">
              {inputTokens.toLocaleString()}
            </span>{" "}
            input and{" "}
            <span className="text-paper tabular-nums">
              {outputTokens.toLocaleString()}
            </span>{" "}
            output tokens.
          </p>

          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse min-w-[640px]">
              <thead>
                <tr className="text-left text-[11px] tracking-[2px] uppercase text-paper/45">
                  <th className="pb-4 font-normal">Agent</th>
                  <th className="pb-4 font-normal text-right">Base</th>
                  <th className="pb-4 font-normal text-right">Input</th>
                  <th className="pb-4 font-normal text-right">Output</th>
                  <th className="pb-4 font-normal text-right">Per call</th>
                </tr>
              </thead>
              <tbody>
                {AGENTS.map((agent) => {
                  const inCost =
                    (inputTokens / 1_000_000) * agent.pricing.perMillionInputUsd;
                  const outCost =
                    (outputTokens / 1_000_000) * agent.pricing.perMillionOutputUsd;
                  const total = quote(agent.pricing, inputTokens, outputTokens);
                  return (
                    <tr key={agent.id} className="border-t border-paper/10">
                      <td className="py-4 font-medium text-paper">
                        <span className="inline-flex items-center gap-2.5">
                          {/* The same hue the agent wears on its card, so the
                              row and the listing are recognisably one thing. */}
                          <span
                            className="w-2 h-2 rounded-full shrink-0"
                            style={{ background: AGENT_TINT[agent.id].from }}
                          />
                          {agent.name}
                        </span>
                      </td>
                      <td className="py-4 text-right tabular-nums text-paper/55">
                        {usd(agent.pricing.baseUsd)}
                      </td>
                      <td className="py-4 text-right tabular-nums text-paper/55">
                        {usd(inCost)}
                      </td>
                      <td className="py-4 text-right tabular-nums text-paper/55">
                        {usd(outCost)}
                      </td>
                      <td className="py-4 text-right tabular-nums font-medium text-paper">
                        {usd(total)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <p className="text-xs text-paper/45 mt-6 leading-relaxed">
            A call that returns a structured error is charged the tokens it
            consumed reaching that error and nothing more. A call that never
            reached the agent is not charged at all.
          </p>
        </div>
      </div>
    </section>
  );
}
