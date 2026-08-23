import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { quote, SAMPLE_CALL, type Agent } from "@/data/agents";
import { HEALTH_LABEL, type HealthState } from "@/hooks/use-agent-health";

/** The dot beside the status word. Grey for anything that is not confirmed up. */
const DOT: Record<HealthState, string> = {
  online: "bg-foreground",
  checking: "bg-muted-foreground animate-pulse",
  offline: "bg-muted-foreground/40",
  unconfigured: "bg-muted-foreground/40",
};

function SchemaList({ title, rows }: { title: string; rows: Agent["input"] }) {
  return (
    <div>
      <p className="text-[11px] tracking-[2px] uppercase text-muted-foreground mb-3">
        {title}
      </p>
      <ul className="space-y-2">
        {rows.map((f) => (
          <li key={f.name} className="text-sm leading-relaxed">
            <span className="text-foreground font-medium">{f.name}</span>
            <span className="text-muted-foreground"> · {f.type}</span>
            {f.required && (
              <span className="text-muted-foreground/60"> · required</span>
            )}
            {f.note && (
              <span className="block text-muted-foreground/70 text-xs">
                {f.note}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

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
  const price = quote(agent.pricing, SAMPLE_CALL.inputTokens, SAMPLE_CALL.outputTokens);

  return (
    <motion.article
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-100px" }}
      transition={{ duration: 0.6, delay, ease: "easeOut" }}
      className="liquid-glass rounded-2xl p-6 flex flex-col"
    >
      <div className="flex items-start justify-between gap-3">
        <img
          src={agent.icon}
          alt=""
          width={200}
          height={200}
          className="w-20 h-20 -ml-1"
        />
        <Badge variant="outline" className="shrink-0">
          <span className={cn("w-1.5 h-1.5 rounded-full", DOT[health])} />
          {HEALTH_LABEL[health]}
        </Badge>
      </div>

      <h3 className="mt-5 font-semibold text-base">
        {agent.name.replace(agent.accent, "").trim()}{" "}
        <span className="font-serif italic font-normal text-lg">
          {agent.accent}
        </span>
      </h3>
      <p className="mt-2 text-muted-foreground text-sm leading-relaxed">
        {agent.tagline}
      </p>

      {/* mt-auto rather than a fixed margin: the taglines run to different
          line counts, and without it the price row sits at a different height
          in every card of the row. */}
      <dl className="mt-auto pt-5 border-t border-border/40 space-y-2 text-xs">
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">Typical call</dt>
          <dd className="font-medium tabular-nums">${price.toFixed(4)}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">Runtime</dt>
          <dd className="text-secondary-foreground text-right">{agent.runtime}</dd>
        </div>
      </dl>

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="mt-5 flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        {open ? "Hide contract" : "View contract"}
        <ChevronDown
          className={cn("w-3.5 h-3.5 transition-transform", open && "rotate-180")}
        />
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: "easeOut" }}
            className="overflow-hidden"
          >
            <div className="pt-5 space-y-6">
              <p className="text-sm text-muted-foreground leading-relaxed">
                {agent.description}
              </p>

              <SchemaList title="Input" rows={agent.input} />
              <SchemaList title="Output" rows={agent.output} />

              <div>
                <p className="text-[11px] tracking-[2px] uppercase text-muted-foreground mb-3">
                  Returns on failure
                </p>
                <ul className="space-y-2">
                  {agent.failures.map((f) => (
                    <li key={f.code} className="text-sm">
                      <code className="text-foreground text-xs bg-secondary rounded px-1.5 py-0.5">
                        {f.code}
                      </code>
                      <span className="block text-muted-foreground/70 text-xs mt-1">
                        {f.when}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>

              <div>
                <p className="text-[11px] tracking-[2px] uppercase text-muted-foreground mb-2">
                  You supply
                </p>
                <p className="text-sm text-muted-foreground">{agent.credentials}</p>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.article>
  );
}
