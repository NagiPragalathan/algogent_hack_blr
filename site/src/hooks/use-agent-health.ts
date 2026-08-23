import { useEffect, useState } from "react";
import type { AgentId } from "@/data/agents";
import { AGENTS } from "@/data/agents";

/**
 * Availability is asked, never assumed.
 *
 * The marketplace rule is that an agent which cannot answer a health check at
 * request time must not be presented as available — a stale green dot is worse
 * than no dot, because it is the one piece of the listing a buyer acts on. So
 * there are four states and `unconfigured` is a real one: with no registry URL
 * set this build genuinely does not know, and says so rather than defaulting
 * to something reassuring.
 */
export type HealthState = "checking" | "online" | "offline" | "unconfigured";

/** Where the agent registry lives. Unset in a static preview build. */
const REGISTRY = import.meta.env.VITE_REGISTRY_URL as string | undefined;

/** A health check that has not answered in this long is not a live agent. */
const TIMEOUT_MS = 4_000;

type HealthMap = Record<AgentId, HealthState>;

const allUnconfigured = (): HealthMap =>
  Object.fromEntries(AGENTS.map((a) => [a.id, "unconfigured"])) as HealthMap;

const allChecking = (): HealthMap =>
  Object.fromEntries(AGENTS.map((a) => [a.id, "checking"])) as HealthMap;

async function probe(id: AgentId, signal: AbortSignal): Promise<HealthState> {
  try {
    const res = await fetch(`${REGISTRY}/agents/${id}/health`, {
      signal,
      headers: { accept: "application/json" },
    });
    // A registry that answers with anything other than 2xx is reporting a
    // problem, not a network failure — either way the agent is not callable.
    return res.ok ? "online" : "offline";
  } catch {
    return "offline";
  }
}

export function useAgentHealth(): HealthMap {
  const [health, setHealth] = useState<HealthMap>(() =>
    REGISTRY ? allChecking() : allUnconfigured(),
  );

  useEffect(() => {
    if (!REGISTRY) return;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    // Probed in parallel and written per agent as each answers, so one slow
    // agent does not hold the whole row on "checking".
    for (const agent of AGENTS) {
      void probe(agent.id, controller.signal).then((state) =>
        setHealth((prev) => ({ ...prev, [agent.id]: state })),
      );
    }

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, []);

  return health;
}

/** Wording for each state. `unconfigured` must not read like a failure. */
export const HEALTH_LABEL: Record<HealthState, string> = {
  checking: "Checking",
  online: "Live",
  offline: "Unreachable",
  unconfigured: "No registry",
};
