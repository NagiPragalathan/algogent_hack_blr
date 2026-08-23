import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import { ArrowRight } from "lucide-react";
import { AGENTS } from "@/data/agents";
import { useAgentHealth } from "@/hooks/use-agent-health";
import { AgentCard } from "@/components/agents/agent-card";
import { fadeUp } from "@/lib/motion";

/**
 * Written out rather than rendered as a digit: the heading is a sentence, and
 * "4 agents. Real actions." reads as a spec sheet. Anything past the map falls
 * back to the numeral, which is the right failure — a marketplace with ten
 * agents has outgrown the word anyway.
 */
const WORD = [
  "no",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
];
const countWord = (n: number) => WORD[n] ?? String(n);

/**
 * The home page's agent section: the whole catalogue as cards, and a way
 * through to the directory.
 *
 * The count in the heading is derived, not typed. It read "Four agents." as a
 * literal, which is a sentence that silently becomes false the day a fifth is
 * listed — and the file that would have to remember is this one, not the
 * catalogue.
 */
export function AgentsPreview() {
  const health = useAgentHealth();

  return (
    <section id="agents" className="bg-cream py-24 md:py-36 px-6">
      <div className="max-w-6xl mx-auto">
        <motion.h2
          {...fadeUp(0)}
          className="text-ink text-4xl md:text-6xl lg:text-7xl font-normal tracking-tight text-center leading-[1.1] first-letter:uppercase"
        >
          {countWord(AGENTS.length)} agents.{" "}
          <em className="not-italic accent-serif">Real actions.</em>
        </motion.h2>

        <motion.p
          {...fadeUp(0.1)}
          className="text-ink/65 text-base md:text-lg max-w-2xl mx-auto text-center mt-6 leading-relaxed"
        >
          Each one performs its work against the real service, with credentials
          you supply for that session alone. There is no sandbox mode and no
          sample payload — a call that cannot be completed returns the reason.
        </motion.p>

        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6 mt-16">
          {AGENTS.map((agent, i) => (
            <AgentCard
              key={agent.id}
              agent={agent}
              health={health[agent.id]}
              delay={i * 0.08}
            />
          ))}
        </div>

        <motion.div
          {...fadeUp(0.15)}
          className="flex flex-col items-center gap-4 mt-14"
        >
          <Link
            to="/agents"
            className="inline-flex items-center gap-2 bg-ink text-paper text-sm font-medium uppercase tracking-wide rounded-full pl-6 pr-2 py-2 hover:bg-ink-strong transition-colors"
          >
            See all {AGENTS.length} agents
            <span className="w-7 h-7 rounded-full bg-white flex items-center justify-center">
              <ArrowRight size={16} className="text-ink" />
            </span>
          </Link>

          <p className="text-ink/55 text-sm text-center max-w-md">
            Every contract, failure mode and price, worked line by line. An
            agent that cannot answer a health check is never listed as
            available.
          </p>
        </motion.div>
      </div>
    </section>
  );
}
