import { useEffect, useState } from "react";
import { listAgents, type RegistryListing } from "@/lib/registry";

export interface RegistryState {
  listing: RegistryListing | null;
  /** A sentence written to be shown verbatim. Null while loading or once loaded. */
  error: string | null;
  loading: boolean;
}

/**
 * The live registry, asked once.
 *
 * Two surfaces on the publish page need it and they need it for different
 * reasons — the revenue split comes from `companyBps`, and the taken ids come
 * from `agents` — so it is fetched here and passed down rather than fetched
 * twice. Same rule as the health check: what the API says now beats a number
 * typed into a component months ago.
 *
 * A failure is kept as a sentence, not swallowed. The publish form still works
 * without this (the API validates everything server-side regardless), so an
 * unreachable registry degrades the page rather than blocking it.
 */
export function useRegistryListing(): RegistryState {
  const [state, setState] = useState<RegistryState>({
    listing: null,
    error: null,
    loading: true,
  });

  useEffect(() => {
    let cancelled = false;

    void listAgents().then((result) => {
      if (cancelled) return;
      setState(
        result.ok
          ? { listing: result.data, error: null, loading: false }
          : { listing: null, error: result.error.message, loading: false },
      );
    });

    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
