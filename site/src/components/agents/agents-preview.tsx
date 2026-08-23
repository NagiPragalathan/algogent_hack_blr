import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import { ArrowRight } from "lucide-react";
import { AGENTS } from "@/data/agents";
import { useAgentHealth } from "@/hooks/use-agent-health";
import { AgentCard } from "@/components/agents/agent-card";
import { Button } from "@/components/ui/button";
import { fadeUp, pressable } from "@/lib/motion";

/**
 * Written out rather than rendered as a digit: the heading is a sentence, and
 * "4 agents. Real actions." reads as a spec sheet. Anything past the map falls
 * back to the numeral, which is the right failure — a marketplace with ten
 * agents has outgrown the word anyway.
 */
const WORD = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
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
    <section id="agents" className="pt-52 md:pt-64 pb-6 md:pb-9 px-8 md:px-28">
      <motion.h2
        {...fadeUp(0)}
        className="text-5xl md:text-7xl lg:text-8xl font-medium tracking-[-2px] text-center leading-[1.05] capitalize"
      >
        {countWord(AGENTS.length)} agents.{" "}
        <span className="font-serif italic font-normal normal-case">
          Real actions.
        </span>
      </motion.h2>

      <motion.p
        {...fadeUp(0.1)}
        className="text-muted-foreground text-lg max-w-2xl mx-auto text-center mt-6 mb-24"
      >
        Each one performs its work against the real service, with credentials
        you supply for that session alone. There is no sandbox mode and no
        sample payload — a call that cannot be completed returns the reason.
      </motion.p>

      <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-12 md:gap-8 mb-16">
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
        className="flex flex-col items-center gap-4"
      >
        <motion.div {...pressable}>
          <Button asChild shape="pill" size="lg" className="tracking-wide">
            <Link to="/agents">
              SEE ALL {AGENTS.length} AGENTS
              <ArrowRight className="w-4 h-4" />
            </Link>
          </Button>
        </motion.div>

        <p className="text-muted-foreground text-sm text-center">
          Every contract, failure mode and price, worked line by line.
        </p>
      </motion.div>

      <motion.p
        {...fadeUp(0.2)}
        className="text-muted-foreground text-sm text-center mt-16"
      >
        An agent that cannot answer a health check does not get listed as
        available.
      </motion.p>
    </section>
  );
}
