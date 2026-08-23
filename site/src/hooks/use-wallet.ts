/**
 * useWallet — Algorand wallet state and connection logic for the site.
 *
 * Implements the exact GalaxyPay/lute-connect protocol:
 *   1. open("https://lute.app/connect", siteName, params)
 *   2. on "ready" → postMessage({ action: "network", genesisID }, "*")
 *   3. on "connect" → receive addrs[0], finalize session
 *
 * Supports: Lute Wallet, Pera Web, Defly, Exodus (injected)
 */

import { useState, useEffect, useCallback, useRef } from "react";

export type NetworkId = "testnet" | "mainnet";
export type WalletId = "lute" | "pera" | "defly" | "exodus";

export interface NetworkConfig {
  id: NetworkId;
  name: string;
  genesisID: string;
  algodUrl: string;
  usdcAssetId: number;
  explorerUrl: string;
  faucetUrl: string | null;
}

export const NETWORKS: Record<NetworkId, NetworkConfig> = {
  testnet: {
    id: "testnet",
    name: "TestNet",
    genesisID: "testnet-v1.0",
    algodUrl: "https://testnet-api.algonode.cloud",
    usdcAssetId: 10458941,
    explorerUrl: "https://lora.algokit.io/testnet/account/",
    faucetUrl: "https://lora.algokit.io/testnet/fund",
  },
  mainnet: {
    id: "mainnet",
    name: "MainNet",
    genesisID: "mainnet-v1.0",
    algodUrl: "https://mainnet-api.algonode.cloud",
    usdcAssetId: 31566704,
    explorerUrl: "https://lora.algokit.io/mainnet/account/",
    faucetUrl: null,
  },
};

export interface WalletState {
  connected: boolean;
  providerId: WalletId | null;
  providerName: string;
  address: string;
  network: NetworkId;
  algoBalance: string;
  usdcBalance: string;
  loading: boolean;
  error: string | null;
}

const STORAGE_KEY = "aw_site_wallet_v1";
const ALGO_ADDR_RE = /^[A-Z2-7]{58}$/;

export function isValidAlgorandAddress(addr: string): boolean {
  return ALGO_ADDR_RE.test(addr?.trim() ?? "");
}

export function ellipseAddress(
  addr: string,
  prefix = 5,
  suffix = 4
): string {
  if (!addr) return "";
  const t = addr.trim();
  if (t.length <= prefix + suffix) return t;
  return `${t.slice(0, prefix)}…${t.slice(-suffix)}`;
}

const DEFAULT_STATE: WalletState = {
  connected: false,
  providerId: null,
  providerName: "",
  address: "",
  network: "testnet",
  algoBalance: "—",
  usdcBalance: "—",
  loading: false,
  error: null,
};

/** Fetch on-chain balances for a connected address */
async function fetchBalances(
  address: string,
  network: NetworkId
): Promise<Pick<WalletState, "algoBalance" | "usdcBalance">> {
  const cfg = NETWORKS[network];
  try {
    const res = await fetch(`${cfg.algodUrl}/v2/accounts/${address}`, {
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return { algoBalance: "0.00 (unfunded)", usdcBalance: "0.00" };
    const data = await res.json();
    const algoBalance =
      data.amount != null
        ? (data.amount / 1_000_000).toLocaleString("en-US", {
            minimumFractionDigits: 2,
            maximumFractionDigits: 4,
          })
        : "0.00";
    let usdcBalance = "0.00";
    if (Array.isArray(data.assets) && cfg.usdcAssetId) {
      const usdc = data.assets.find(
        (a: { "asset-id": number; amount: number }) =>
          a["asset-id"] === cfg.usdcAssetId
      );
      usdcBalance = usdc
        ? (usdc.amount / 1_000_000).toLocaleString("en-US", {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          })
        : "0.00 (opt-in needed)";
    }
    return { algoBalance, usdcBalance };
  } catch {
    return { algoBalance: "—", usdcBalance: "—" };
  }
}

/** Open lute.app/connect and complete the handshake protocol */
function luteConnect(genesisID: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const left = 100 + (window.screenX ?? 0);
    const top = 100 + (window.screenY ?? 0);
    const win = window.open(
      "https://lute.app/connect",
      "AgenticWallet",
      `width=500,height=750,left=${left},top=${top}`
    );
    if (!win) {
      reject(new Error("Popup blocked. Allow popups for this site."));
      return;
    }

    const handler = (event: MessageEvent) => {
      if (event.origin !== "https://lute.app") return;
      const d = event.data as { action?: string; addrs?: string[]; accounts?: (string | { address: string })[] };
      if (!d?.action) return;

      if (d.action === "ready") {
        win.postMessage({ action: "network", genesisID }, "*");
      } else if (d.action === "connect") {
        window.removeEventListener("message", handler);
        const addr =
          d.addrs?.[0] ??
          (typeof d.accounts?.[0] === "string"
            ? d.accounts[0]
            : (d.accounts?.[0] as { address: string } | undefined)?.address);
        if (addr && isValidAlgorandAddress(addr)) {
          resolve(addr);
        } else {
          reject(new Error("No valid address from Lute"));
        }
      } else if (d.action === "error" || d.action === "close") {
        window.removeEventListener("message", handler);
        reject(new Error("Lute connect cancelled"));
      }
    };

    window.addEventListener("message", handler);

    // Poll handshake in case "ready" fires before the listener
    let tries = 0;
    const iv = setInterval(() => {
      tries++;
      if (tries > 50 || win.closed) {
        clearInterval(iv);
        window.removeEventListener("message", handler);
        reject(new Error("Lute connect timed out or closed"));
        return;
      }
      try {
        win.postMessage({ action: "network", genesisID }, "*");
      } catch { /* cross-origin before lute loads — safe to ignore */ }
    }, 800);
  });
}

export function useWallet() {
  const [state, setState] = useState<WalletState>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const saved = JSON.parse(raw) as Partial<WalletState>;
        if (saved.connected && saved.address) return { ...DEFAULT_STATE, ...saved };
      }
    } catch { /* ignore */ }
    return DEFAULT_STATE;
  });

  const stateRef = useRef(state);
  stateRef.current = state;

  // Hydrate balances on mount if already connected
  useEffect(() => {
    if (state.connected && state.address) {
      fetchBalances(state.address, state.network).then((balances) => {
        setState((s) => ({ ...s, ...balances }));
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const persist = useCallback((s: WalletState) => {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          connected: s.connected,
          providerId: s.providerId,
          providerName: s.providerName,
          address: s.address,
          network: s.network,
        })
      );
    } catch { /* ignore */ }
  }, []);

  const finalize = useCallback(
    async (providerId: WalletId, providerName: string, address: string, network: NetworkId) => {
      const balances = await fetchBalances(address, network);
      const next: WalletState = {
        ...DEFAULT_STATE,
        connected: true,
        providerId,
        providerName,
        address: address.trim(),
        network,
        ...balances,
        loading: false,
        error: null,
      };
      setState(next);
      persist(next);
    },
    [persist]
  );

  const connect = useCallback(
    async (providerId: WalletId) => {
      const network = stateRef.current.network;
      const cfg = NETWORKS[network];

      setState((s) => ({ ...s, loading: true, error: null }));

      // Try injected browser wallet first (Lute / Pera / Defly / Exodus extension)
      interface InjectedWallet {
        enable: (opts: { genesisID: string }) => Promise<(string | { address: string })[]>;
      }
      const win = window as Window & {
        algorand?: InjectedWallet;
        pera?: InjectedWallet;
        defly?: InjectedWallet;
        lute?: InjectedWallet;
        exodus?: { algorand?: InjectedWallet };
      };
      const injected: InjectedWallet | undefined =
        win.algorand ?? win.exodus?.algorand ?? win.pera ?? win.defly ?? win.lute;

      if (injected?.enable) {
        try {
          const accounts = await injected.enable({ genesisID: cfg.genesisID });
          const first = accounts?.[0];
          const addr = typeof first === "string" ? first : first?.address;
          if (addr && isValidAlgorandAddress(addr)) {
            await finalize(
              providerId,
              providerId.charAt(0).toUpperCase() + providerId.slice(1),
              addr,
              network
            );
            return;
          }
        } catch { /* fall through to web flow */ }
      }

      if (providerId === "lute") {
        try {
          const addr = await luteConnect(cfg.genesisID);
          if (addr) {
            await finalize("lute", "Lute Wallet", addr, network);
          }
        } catch (err) {
          setState((s) => ({
            ...s,
            loading: false,
            error: (err as Error).message,
          }));
        }
        return;
      }

      if (providerId === "pera") {
        window.open(
          "https://web.perawallet.app",
          "pera_connect",
          "width=520,height=720,menubar=no,toolbar=no"
        );
        setState((s) => ({ ...s, loading: false }));
        return;
      }

      if (providerId === "defly") {
        window.open(
          "https://defly.app",
          "defly_connect",
          "width=520,height=720,menubar=no,toolbar=no"
        );
        setState((s) => ({ ...s, loading: false }));
        return;
      }

      setState((s) => ({ ...s, loading: false }));
    },
    [finalize]
  );

  const disconnect = useCallback(() => {
    setState(DEFAULT_STATE);
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch { /* ignore */ }
  }, []);

  const switchNetwork = useCallback(
    async (network: NetworkId) => {
      const next = { ...stateRef.current, network };
      setState(next);
      persist(next);
      if (next.connected && next.address) {
        const balances = await fetchBalances(next.address, network);
        setState((s) => ({ ...s, ...balances }));
      }
    },
    [persist]
  );

  const refreshBalance = useCallback(async () => {
    const s = stateRef.current;
    if (!s.connected || !s.address) return;
    const balances = await fetchBalances(s.address, s.network);
    setState((cur) => ({ ...cur, ...balances }));
  }, []);

  return { state, connect, disconnect, switchNetwork, refreshBalance, ellipseAddress, isValidAlgorandAddress, NETWORKS };
}
