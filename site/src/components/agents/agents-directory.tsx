import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { Search, X } from "lucide-react";
import { AgentRow } from "@/components/agents/agent-row";
import { useAgentHealth } from "@/hooks/use-agent-health";
import {
  AGENTS,
  quote,
  SAMPLE_CALL,
  type Agent,
  type AgentCategory,
} from "@/data/agents";
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
        "rounded-full px-3.5 py-2 text-xs font-medium tracking-wide whitespace-nowrap transition-colors border",
        active
          ? "bg-ink text-paper border-ink"
          : "border-sand text-ink/60 hover:text-ink hover:border-sand-strong",
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
        className="flex flex-col lg:flex-row lg:items-center gap-4 lg:gap-6"
      >
        <div className="bg-paper border border-sand rounded-full flex items-center gap-3 px-5 h-12 lg:w-64 shrink-0">
          <Search className="w-4 h-4 text-ink/45 shrink-0" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search agents, fields, codes"
            aria-label="Search agents"
            className="flex-1 min-w-0 bg-transparent text-sm text-ink placeholder:text-ink/40 focus:outline-none"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="Clear search"
              className="text-ink/45 hover:text-ink transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 lg:flex-1">
          <Chip active={category === "all"} onClick={() => setCategory("all")}>
            All
          </Chip>
          {USED_CATEGORIES.map((c) => (
            <Chip key={c} active={category === c} onClick={() => setCategory(c)}>
              {c}
            </Chip>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2 lg:ml-auto">
          <span className="text-[11px] tracking-[2px] uppercase text-ink/45">
            Sort
          </span>
          {SORTS.map((s) => (
            <Chip key={s.id} active={sort === s.id} onClick={() => setSort(s.id)}>
              {s.label}
            </Chip>
          ))}
        </div>
      </motion.div>

      <p className="mt-6 text-sm text-ink/55" aria-live="polite">
        Showing {results.length} of {AGENTS.length} agents
      </p>

      {results.length === 0 ? (
        <div className="bg-paper border border-sand rounded-3xl mt-8 p-12 text-center">
          <p className="text-ink text-lg">
            Nothing in the catalogue matches that.
          </p>
          <p className="text-ink/60 text-sm mt-2">
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
