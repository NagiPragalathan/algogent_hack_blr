import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { Search, X } from "lucide-react";
import { AgentRow } from "@/components/agents/agent-row";
import { Input } from "@/components/ui/input";
import { useAgentHealth } from "@/hooks/use-agent-health";
import { AGENTS, quote, SAMPLE_CALL, type Agent, type AgentCategory } from "@/data/agents";
import { fadeUp } from "@/lib/motion";
import { cn } from "@/lib/utils";

type Sort = "featured" | "price" | "name";

const SORTS: { id: Sort; label: string }[] = [
  { id: "featured", label: "Featured" },
  { id: "price", label: "Cheapest call" },
  { id: "name", label: "A–Z" },
];

/** Only the categories the catalogue actually uses, in catalogue order. */
const USED_CATEGORIES = [...new Set(AGENTS.map((a) => a.category))];

const typicalPrice = (agent: Agent) =>
  quote(agent.pricing, SAMPLE_CALL.inputTokens, SAMPLE_CALL.outputTokens);

/**
 * Everything an agent can be found by, flattened once.
 *
 * A buyer searching this page is as likely to type a failure code or a runtime
 * as a product name — "rate_limited", "Playwright", "OAuth" — so the haystack
 * is the whole record rather than the heading. Built per agent, not per
 * keystroke: the catalogue is static, and rebuilding these strings on every
 * character typed is work with no result that changes.
 */
const HAYSTACK = new Map(
  AGENTS.map((a) => [
    a.id,
    [
      a.name,
      a.category,
      a.tagline,
      a.description,
      a.runtime,
      a.credentials,
      ...a.capabilities,
      ...a.input.map((f) => `${f.name} ${f.type}`),
      ...a.output.map((f) => `${f.name} ${f.type}`),
      ...a.failures.map((f) => `${f.code} ${f.when}`),
    ]
      .join(" ")
      .toLowerCase(),
  ]),
);

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "rounded-full px-4 py-2 text-xs tracking-wide transition-colors border",
        active
          ? "bg-foreground text-background border-foreground"
          : "border-border text-muted-foreground hover:text-foreground hover:border-ring",
      )}
    >
      {children}
    </button>
  );
}

/**
 * The full listing.
 *
 * Filtering happens here and not in the page so the page stays a layout: this
 * component owns the query, the category and the order, and nothing above it
 * needs to know those exist.
 */
export function AgentsDirectory() {
  const health = useAgentHealth();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<AgentCategory | "all">("all");
  const [sort, setSort] = useState<Sort>("featured");

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();

    const matched = AGENTS.filter((agent) => {
      if (category !== "all" && agent.category !== category) return false;
      if (!needle) return true;
      return (HAYSTACK.get(agent.id) ?? "").includes(needle);
    });

    // Sorted on a copy: AGENTS is the catalogue every other surface reads, and
    // Array.prototype.sort mutates.
    if (sort === "price") {
      return [...matched].sort((a, b) => typicalPrice(a) - typicalPrice(b));
    }
    if (sort === "name") {
      return [...matched].sort((a, b) => a.name.localeCompare(b.name));
    }
    return matched;
  }, [query, category, sort]);

  return (
    <>
      <motion.div
        {...fadeUp(0)}
        className="flex flex-col lg:flex-row lg:items-center gap-5 lg:gap-8"
      >
        <div className="liquid-glass rounded-full flex items-center gap-3 px-5 h-12 lg:w-80 shrink-0">
          <Search className="w-4 h-4 text-muted-foreground shrink-0" />
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search agents, fields, failure codes"
            aria-label="Search agents"
            className="flex-1 min-w-0 px-0"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="Clear search"
              className="text-muted-foreground hover:text-foreground transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Chip active={category === "all"} onClick={() => setCategory("all")}>
            All
          </Chip>
          {USED_CATEGORIES.map((c) => (
            <Chip key={c} active={category === c} onClick={() => setCategory(c)}>
              {c}
            </Chip>
          ))}
        </div>

        <div className="flex items-center gap-2 lg:ml-auto">
          <span className="text-xs tracking-[2px] uppercase text-muted-foreground">
            Sort
          </span>
          {SORTS.map((s) => (
            <Chip key={s.id} active={sort === s.id} onClick={() => setSort(s.id)}>
              {s.label}
            </Chip>
          ))}
        </div>
      </motion.div>

      <p className="mt-6 text-sm text-muted-foreground" aria-live="polite">
        Showing {results.length} of {AGENTS.length} agents
      </p>

      {results.length === 0 ? (
        <div className="liquid-glass rounded-3xl mt-8 p-12 text-center">
          <p className="text-lg">Nothing in the catalogue matches that.</p>
          <p className="text-muted-foreground text-sm mt-2">
            The listing is not padded with agents that do not exist — try a
            broader term, or clear the filters.
          </p>
        </div>
      ) : (
        <div className="mt-8 space-y-8">
          {results.map((agent, i) => (
            <AgentRow
              key={agent.id}
              agent={agent}
              health={health[agent.id]}
              index={i}
            />
          ))}
        </div>
      )}
    </>
  );
}
