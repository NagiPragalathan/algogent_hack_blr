import { motion } from "framer-motion";
import { AGENTS } from "@/data/agents";
import { useAgentHealth } from "@/hooks/use-agent-health";
import { AgentCard } from "@/components/agent-card";
import { fadeUp } from "@/lib/motion";

export function AgentsSection() {
  const health = useAgentHealth();

  return (
    <section id="agents" className="pt-52 md:pt-64 pb-6 md:pb-9 px-8 md:px-28">
      <motion.h2
        {...fadeUp(0)}
        className="text-5xl md:text-7xl lg:text-8xl font-medium tracking-[-2px] text-center leading-[1.05]"
      >
        Four agents.{" "}
        <span className="font-serif italic font-normal">Real actions.</span>
      </motion.h2>

      <motion.p
        {...fadeUp(0.1)}
        className="text-muted-foreground text-lg max-w-2xl mx-auto text-center mt-6 mb-24"
      >
        Each one performs its work against the real service, with credentials
        you supply for that session alone. There is no sandbox mode and no
        sample payload — a call that cannot be completed returns the reason.
      </motion.p>

      <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-12 md:gap-8 mb-20">
        {AGENTS.map((agent, i) => (
          <AgentCard
            key={agent.id}
            agent={agent}
            health={health[agent.id]}
            delay={i * 0.08}
          />
        ))}
      </div>

      <motion.p
        {...fadeUp(0.2)}
        className="text-muted-foreground text-sm text-center"
      >
        An agent that cannot answer a health check does not get listed as
        available.
      </motion.p>
    </section>
  );
}
