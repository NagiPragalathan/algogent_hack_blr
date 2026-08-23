/**
 * The typed client for the payments API. UI-free on purpose.
 *
 * Every function here returns data or a structured failure; none of them
 * renders, toasts or throws for an expected condition. The surfaces that use
 * them live in src/components and belong to whoever owns the palette — this
 * file exists so that boundary is a real one rather than a convention.
 *
 * Amounts are ALWAYS integer microALGO on the wire (`*MicroAlgo`) with a
 * pre-rendered string beside them (`*Algo`). Never do arithmetic on the string
 * and never render the integer directly: ALGO has exactly six decimals,
 * microALGO is the atomic unit the chain moves, and a float in a payments path
 * is money that stops reconciling.
 */

export interface RegisteredAgent {
  id: string;
  name: string;
  description: string;
  /** Where this agent's 80% lands. Public — it is on chain the moment it is paid. */
  payoutAddress: string;
  priceMicroAlgo: number;
  /** Already formatted to six decimals, e.g. "0.020000". */
  priceAlgo: string;
  developerMicroAlgo: number;
  companyMicroAlgo: number;
}

export interface RegistryListing {
  network: "testnet" | "mainnet" | "localnet";
  /** The marketplace cut in basis points. 2000 = 20%. */
  companyBps: number;
  agents: RegisteredAgent[];
}

/** What a developer fills in to publish an agent. */
export interface RegisterInput {
  /** 2-64 chars, lowercase letters, numbers and hyphens. Stable forever — payouts key on it. */
  id: string;
  name: string;
  /** A plain decimal in ALGO, at most 6 places: "0.02". Not a number — see the note above. */
  priceAlgo: string;
  /** 58 characters of base32. Checksummed, so one wrong character is caught. */
  payoutAddress: string;
  description?: string;
  body?: string;
  email?: string;
  displayName?: string;
  /** Base64-encoded SKILL.md content, when the agent was created from an uploaded skill file. */
  skillMd?: string;
}

export interface Receipt {
  receiptId: number;
  agentId: string;
  /** The tool's own label, as the user saw it in the panel. */
  toolLabel: string;
  paidAt: string;
  network: string;
  confirmedRound: number;
  total: { microAlgo: number; algo: string };
  developer: {
    address: string;
    microAlgo: number;
    algo: string;
    txid: string;
    /** A public explorer with nothing to do with us — the point is independent checking. */
    explorer: string;
  };
  company: {
    address: string;
    microAlgo: number;
    algo: string;
    bps: number;
    txid: string;
    explorer: string;
  } | null;
  networkFee: { microAlgo: number; algo: string };
}

export interface ReceiptHistory {
  count: number;
  truncated: boolean;
  totals: {
    totalMicroAlgo: number;
    totalAlgo: string;
    developerMicroAlgo: number;
    companyMicroAlgo: number;
    networkFeeMicroAlgo: number;
    spentMicroAlgo: number;
    spentAlgo: string;
  };
  receipts: Receipt[];
}

/** Every failure is a code you can branch on plus a sentence you can show. */
export interface ApiError {
  error: string;
  message: string;
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: ApiError };

/** Same origin in production; overridable for a preview build. */
const BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "";

async function call<T>(path: string, init?: RequestInit): Promise<Result<T>> {
  try {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers || {}) },
    });

    const data = await res.json().catch(() => null);

    if (!res.ok) {
      return {
        ok: false,
        error: (data as ApiError) ?? {
          error: "unreachable",
          message: `The payments API answered ${res.status}.`,
        },
      };
    }
    return { ok: true, data: data as T };
  } catch {
    // A network failure is not the same as a refusal, and a caller that treats
    // them alike will tell a developer their address was rejected when in fact
    // nothing was ever asked.
    return {
      ok: false,
      error: { error: "unreachable", message: "The payments API could not be reached." },
    };
  }
}

/** Every live agent, with its price and payout address. */
export const listAgents = () => call<RegistryListing>("/api/agents");

/** Just these ids — what the extension asks for, keyed on its own skill list. */
export const listAgentsByIds = (ids: string[]) =>
  call<RegistryListing>(`/api/agents?ids=${encodeURIComponent(ids.join(","))}`);

/**
 * Publish an agent, or update one you already own.
 *
 * Re-registering an id you do NOT own fails with `id_taken` rather than
 * silently repointing someone else's payouts at your address.
 */
export const registerAgent = (input: RegisterInput) =>
  call<{
    id: string;
    name: string;
    priceAlgo: string;
    priceMicroAlgo: number;
    network: string;
    status: string;
    payoutAddress: string;
  }>("/api/agents/register", { method: "POST", body: JSON.stringify(input) });

/** One chat or run's fee history, oldest first — the order the tools ran in. */
export const receiptsForSession = (sessionId: string) =>
  call<ReceiptHistory>(`/api/receipts?session=${encodeURIComponent(sessionId)}`);

/** Everything one wallet has spent, newest first. */
export const receiptsForBuyer = (address: string) =>
  call<ReceiptHistory>(`/api/receipts?buyer=${encodeURIComponent(address)}`);

/**
 * Client-side address check, so the form can say "that is not an address"
 * without a round trip. It is a SHAPE check only — the checksum is verified
 * server-side with algosdk, which is what actually catches a typo.
 */
export const looksLikeAlgorandAddress = (value: string) =>
  /^[A-Z2-7]{58}$/.test(value.trim());

/** The same price rule the API enforces, for inline form validation. */
export function priceProblem(priceAlgo: string): string | null {
  const text = priceAlgo.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(text)) {
    return "Use a plain decimal with at most 6 places, like 0.02.";
  }
  const [whole, fraction = ""] = text.split(".");
  const micro = Number(whole) * 1_000_000 + Number(fraction.padEnd(6, "0"));
  if (micro < 20_000) {
    return "The floor is 0.020000 ALGO — below that the network fees cost more than the sale.";
  }
  return null;
}
