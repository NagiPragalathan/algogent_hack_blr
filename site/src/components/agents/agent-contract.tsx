import type { Agent } from "@/data/agents";
import { cn } from "@/lib/utils";

/**
 * The contract block — input, output, failure modes, credentials.
 *
 * Shared by the card on the home page and the full listing on /agents, which
 * is the reason it is its own file: the two surfaces show the same contract at
 * different widths, and a second copy of this markup would be the thing that
 * drifts the first time a field is added.
 */

export function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[11px] tracking-[2px] uppercase text-ink/50 mb-3">
      {children}
    </p>
  );
}

function SchemaList({ title, rows }: { title: string; rows: Agent["input"] }) {
  return (
    <div>
      <SectionLabel>{title}</SectionLabel>
      <ul className="space-y-2">
        {rows.map((f) => (
          <li key={f.name} className="text-sm leading-relaxed">
            <span className="text-ink font-medium">{f.name}</span>
            <span className="text-ink/55"> · {f.type}</span>
            {f.required && (
              <span className="text-[hsl(var(--tint))] font-medium">
                {" "}
                · required
              </span>
            )}
            {f.note && (
              <span className="block text-ink/50 text-xs">{f.note}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function FailureList({ rows }: { rows: Agent["failures"] }) {
  return (
    <div>
      <SectionLabel>Returns on failure</SectionLabel>
      <ul className="space-y-2">
        {rows.map((f) => (
          <li key={f.code} className="text-sm">
            <code className="text-status-down text-xs bg-status-down/[0.08] border border-status-down/25 rounded px-1.5 py-0.5">
              {f.code}
            </code>
            <span className="block text-ink/50 text-xs mt-1">{f.when}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Capability chips. Tinted, because they are the agent talking about itself. */
export function CapabilityChips({ items }: { items: string[] }) {
  return (
    <ul className="flex flex-wrap gap-2">
      {items.map((c) => (
        <li
          key={c}
          className="text-xs text-ink/75 rounded-full px-3 py-1 border border-[hsl(var(--tint)/0.3)] bg-[hsl(var(--tint)/0.08)]"
        >
          {c}
        </li>
      ))}
    </ul>
  );
}

export function AgentContract({
  agent,
  className,
  columns = 1,
}: {
  agent: Agent;
  className?: string;
  /** Two columns on the wide directory listing, one inside a narrow card. */
  columns?: 1 | 2;
}) {
  return (
    <div className={cn("space-y-6", className)}>
      <p className="text-sm text-ink/70 leading-relaxed">{agent.description}</p>

      <div>
        <SectionLabel>What it does</SectionLabel>
        <CapabilityChips items={agent.capabilities} />
      </div>

      <div
        className={cn("gap-6", columns === 2 ? "grid sm:grid-cols-2" : "space-y-6")}
      >
        <SchemaList title="Input" rows={agent.input} />
        <SchemaList title="Output" rows={agent.output} />
      </div>

      <FailureList rows={agent.failures} />

      <div>
        <SectionLabel>You supply</SectionLabel>
        <p className="text-sm text-ink/70">{agent.credentials}</p>
      </div>
    </div>
  );
}
