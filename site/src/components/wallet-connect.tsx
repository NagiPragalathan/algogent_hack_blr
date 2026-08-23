import { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Wallet, X, ExternalLink, Copy, RefreshCw, Zap, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// ─── Network config ───────────────────────────────────────────────────────────

const NETWORKS: Record<string, Network> = {
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

interface Network {
  id: string;
  name: string;
  genesisID: string;
  algodUrl: string;
  usdcAssetId: number;
  explorerUrl: string;
  faucetUrl: string | null;
}

// ─── Wallet provider list ─────────────────────────────────────────────────────

const WALLETS = [
  {
    id: "lute",
    name: "Lute Wallet",
    letter: "L",
    color: "from-indigo-500 to-violet-600",
    tag: "Web",
    desc: "Connect existing accounts via lute.app",
    url: "https://lute.app/connect",
  },
  {
    id: "pera",
    name: "Pera Wallet",
    letter: "P",
    color: "from-sky-500 to-blue-600",
    tag: "Official",
    desc: "Official Algorand mobile & web wallet",
    url: "https://web.perawallet.app",
  },
  {
    id: "defly",
    name: "Defly Wallet",
    letter: "D",
    color: "from-emerald-500 to-teal-600",
    tag: "DeFi",
    desc: "DeFi-native Algorand mobile wallet",
    url: "https://defly.app",
  },
];

// ─── Types ────────────────────────────────────────────────────────────────────

interface WalletState {
  connected: boolean;
  providerId: string | null;
  providerName: string;
  address: string;
  network: string;
  algoBalance: string;
  usdcBalance: string;
}

const DEFAULT_STATE: WalletState = {
  connected: false,
  providerId: null,
  providerName: "",
  address: "",
  network: "testnet",
  algoBalance: "0.00",
  usdcBalance: "0.00",
};

const STORAGE_KEY = "agenticwallet_site_v1";
const ADDR_RE = /^[A-Z2-7]{58}$/;

function isValid(addr: string) {
  return ADDR_RE.test(addr?.trim() ?? "");
}
function ellipse(addr: string, p = 5, s = 4) {
  if (!addr || addr.length <= p + s) return addr;
  return `${addr.slice(0, p)}…${addr.slice(-s)}`;
}

// ─── Lute Connect handshake (identical to extension protocol) ─────────────────

function luteConnect(genesisID: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const left = 100 + (window.screenX || 0);
    const top = 100 + (window.screenY || 0);
    const win = window.open(
      "https://lute.app/connect",
      "AgenticWallet",
      `width=500,height=750,left=${left},top=${top}`,
    );

    if (!win) {
      reject(new Error("Popup blocked – allow popups for this site"));
      return;
    }

    const handler = (event: MessageEvent) => {
      if (event.origin !== "https://lute.app") return;
      const data = event.data as { action: string; addrs?: string[]; message?: string };
      if (!data) return;

      switch (data.action) {
        case "ready":
          win.postMessage({ action: "network", genesisID }, "*");
          break;
        case "connect": {
          window.removeEventListener("message", handler);
          clearInterval(ping);
          const addr = data.addrs?.[0] ?? "";
          if (addr) resolve(addr);
          else reject(new Error("No accounts returned from Lute"));
          break;
        }
        case "error":
        case "close":
          window.removeEventListener("message", handler);
          clearInterval(ping);
          reject(new Error(data.message ?? "Lute connect cancelled"));
          break;
      }
    };

    window.addEventListener("message", handler);

    // Periodic re-ping in case "ready" fired before our listener attached
    let tries = 0;
    const ping = setInterval(() => {
      if (++tries > 45 || win.closed) {
        clearInterval(ping);
        window.removeEventListener("message", handler);
        if (win.closed) reject(new Error("Lute connect window closed"));
      }
      try { win.postMessage({ action: "network", genesisID }, "*"); } catch { /* ignore */ }
    }, 800);
  });
}

// ─── Balance fetch ────────────────────────────────────────────────────────────

async function fetchBalance(state: WalletState): Promise<Partial<WalletState>> {
  const net = NETWORKS[state.network] ?? NETWORKS.testnet;
  try {
    const res = await fetch(`${net.algodUrl}/v2/accounts/${state.address}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { algoBalance: "0.00 (unfunded)", usdcBalance: "0.00" };
    const data = await res.json() as {
      amount?: number;
      assets?: { "asset-id": number; amount: number }[];
    };

    const algo = data.amount != null
      ? (data.amount / 1_000_000).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })
      : "0.00";

    let usdc = "0.00";
    const usdcEntry = data.assets?.find((a) => a["asset-id"] === net.usdcAssetId);
    if (usdcEntry) {
      usdc = (usdcEntry.amount / 1_000_000).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    return { algoBalance: algo, usdcBalance: usdc };
  } catch {
    return {};
  }
}

// ─── Main component ───────────────────────────────────────────────────────────

export function WalletConnect() {
  const [open, setOpen] = useState(false);
  const [ws, setWs] = useState<WalletState>(DEFAULT_STATE);
  const [stage, setStage] = useState<"list" | "lute-connecting" | "web-connecting">("list");
  const [connectingWallet, setConnectingWallet] = useState<(typeof WALLETS)[number] | null>(null);
  const [notice, setNotice] = useState("");
  const [luteInput, setLuteInput] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [copied, setCopied] = useState(false);

  // Load from localStorage
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const saved = JSON.parse(raw) as WalletState;
        if (saved.connected && isValid(saved.address)) {
          setWs(saved);
          fetchBalance(saved).then((upd) => setWs((p) => ({ ...p, ...upd }))).catch(() => undefined);
        }
      }
    } catch { /* ignore */ }
  }, []);

  function persist(state: WalletState) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* ignore */ }
  }

  function flash(msg: string) {
    setNotice(msg);
    setTimeout(() => setNotice(""), 3000);
  }

  const finalize = useCallback(async (providerId: string, providerName: string, address: string) => {
    const next: WalletState = {
      connected: true,
      providerId,
      providerName,
      address: address.trim(),
      network: ws.network,
      algoBalance: "…",
      usdcBalance: "…",
    };
    setWs(next);
    setStage("list");
    persist(next);
    flash(`Connected to ${providerName} (${ellipse(address)})`);

    const upd = await fetchBalance(next);
    setWs((p) => { const n = { ...p, ...upd }; persist(n); return n; });
  }, [ws.network]);

  const disconnect = useCallback(() => {
    const next = { ...DEFAULT_STATE, network: ws.network };
    setWs(next);
    persist(next);
    setStage("list");
    flash("Wallet disconnected");
  }, [ws.network]);

  const switchNetwork = useCallback((networkId: string) => {
    setWs((prev) => {
      const next = { ...prev, network: networkId };
      persist(next);
      return next;
    });
    flash(`Switched to ${NETWORKS[networkId]?.name ?? networkId}`);
  }, []);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    const upd = await fetchBalance(ws);
    setWs((p) => { const n = { ...p, ...upd }; persist(n); return n; });
    setRefreshing(false);
  }, [ws]);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(ws.address);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* ignore */ }
  }, [ws.address]);

  async function connectLute() {
    const wallet = WALLETS.find((w) => w.id === "lute")!;
    setConnectingWallet(wallet);
    setStage("lute-connecting");

    // Try to prefill from clipboard
    try {
      const text = await navigator.clipboard.readText();
      if (isValid(text.trim().toUpperCase())) setLuteInput(text.trim().toUpperCase());
    } catch { /* clipboard not available */ }

    const net = NETWORKS[ws.network] ?? NETWORKS.testnet;
    luteConnect(net.genesisID)
      .then((addr) => { if (isValid(addr)) finalize("lute", "Lute Wallet", addr); })
      .catch(() => { /* cancelled — user can still paste manually */ });
  }

  function connectWebWallet(w: typeof WALLETS[number]) {
    setConnectingWallet(w);
    setStage("web-connecting");
    window.open(w.url, `${w.id}_connect`, "width=520,height=720,menubar=no,toolbar=no,status=no");
  }

  function handleConnect(walletId: string) {
    if (walletId === "lute") { connectLute(); return; }
    const w = WALLETS.find((x) => x.id === walletId);
    if (w) connectWebWallet(w);
  }

  function doQuickSync() {
    const addr = luteInput.trim().toUpperCase();
    if (isValid(addr)) {
      finalize("lute", "Lute Wallet", addr);
    } else {
      flash("Please paste a valid 58-character Algorand address from Lute");
    }
  }

  const net = NETWORKS[ws.network] ?? NETWORKS.testnet;

  return (
    <>
      {/* ── Navbar button ───────────────────────────── */}
      <motion.button
        onClick={() => setOpen((o) => !o)}
        whileTap={{ scale: 0.96 }}
        className={cn(
          "relative flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium transition-all",
          ws.connected
            ? "bg-foreground text-background shadow-sm"
            : "liquid-glass text-foreground hover:bg-foreground/[0.06]",
        )}
        aria-label="Wallet"
      >
        {ws.connected && (
          <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-emerald-400 border-2 border-background" />
        )}
        <Wallet className="w-4 h-4" strokeWidth={1.75} />
        <span className="hidden sm:inline">
          {ws.connected ? ellipse(ws.address) : "Connect Wallet"}
        </span>
      </motion.button>

      {/* ── Dropdown panel ──────────────────────────── */}
      <AnimatePresence>
        {open && (
          <>
            {/* Backdrop */}
            <motion.div
              key="backdrop"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-40"
              onClick={() => { setOpen(false); setStage("list"); }}
            />

            <motion.div
              key="panel"
              initial={{ opacity: 0, y: -6, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -6, scale: 0.98 }}
              transition={{ duration: 0.18, ease: "easeOut" }}
              className="fixed top-16 right-6 md:right-8 z-50 w-80 rounded-2xl border border-border/40 bg-background/90 backdrop-blur-xl shadow-2xl overflow-hidden"
            >
              {/* Header */}
              <div className="flex items-center justify-between px-4 py-3 border-b border-border/30">
                <div className="flex items-center gap-2">
                  {ws.connected && <span className="w-2 h-2 rounded-full bg-emerald-400" />}
                  <span className="text-sm font-medium">
                    {ws.connected ? ws.providerName : "Connect Wallet"}
                  </span>
                </div>
                <div className="flex items-center gap-1">
                  {ws.connected && (
                    <select
                      value={ws.network}
                      onChange={(e) => switchNetwork(e.target.value)}
                      className="text-xs bg-transparent text-muted-foreground border border-border/30 rounded-md px-2 py-0.5 cursor-pointer focus:outline-none"
                    >
                      {Object.values(NETWORKS).map((n) => (
                        <option key={n.id} value={n.id}>{n.name}</option>
                      ))}
                    </select>
                  )}
                  <button
                    onClick={() => { setOpen(false); setStage("list"); }}
                    className="p-1 rounded-full text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {/* Flash notice */}
              <AnimatePresence>
                {notice && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    className="px-4 py-2 text-xs bg-emerald-500/10 text-emerald-400 border-b border-border/20"
                  >
                    {notice}
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Body */}
              <div className="p-4">
                {/* ── CONNECTED VIEW ── */}
                {ws.connected && stage === "list" && (
                  <div className="space-y-3">
                    {/* Address */}
                    <div className="flex items-center gap-2 p-3 rounded-xl bg-foreground/[0.04] border border-border/30">
                      <span className="font-mono text-xs text-muted-foreground flex-1 truncate" title={ws.address}>
                        {ws.address}
                      </span>
                      <button
                        onClick={copy}
                        className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
                        title={copied ? "Copied!" : "Copy address"}
                      >
                        <Copy className="w-3.5 h-3.5" />
                      </button>
                      <a
                        href={`${net.explorerUrl}${ws.address}`}
                        target="_blank"
                        rel="noreferrer"
                        className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
                        title="View in explorer"
                      >
                        <ExternalLink className="w-3.5 h-3.5" />
                      </a>
                    </div>

                    {/* Balances */}
                    <div className="grid grid-cols-2 gap-2">
                      <div className="p-3 rounded-xl bg-foreground/[0.04] border border-border/30">
                        <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">ALGO</p>
                        <p className="text-sm font-medium tabular-nums">{ws.algoBalance}</p>
                      </div>
                      <div className="p-3 rounded-xl bg-foreground/[0.04] border border-border/30">
                        <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">USDC (x402)</p>
                        <p className="text-sm font-medium tabular-nums">{ws.usdcBalance}</p>
                      </div>
                    </div>

                    {/* x402 badge */}
                    <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-indigo-500/10 border border-indigo-500/20 text-xs text-indigo-400">
                      <Zap className="w-3 h-3 shrink-0" />
                      <span>x402 HTTP payment protocol active</span>
                    </div>

                    {/* Actions */}
                    <div className="flex gap-2">
                      <button
                        onClick={refresh}
                        className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg border border-border/30 text-xs text-muted-foreground hover:text-foreground transition-colors"
                      >
                        <RefreshCw className={cn("w-3 h-3", refreshing && "animate-spin")} />
                        Refresh
                      </button>
                      {net.faucetUrl && (
                        <a
                          href={net.faucetUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg border border-border/30 text-xs text-muted-foreground hover:text-foreground transition-colors"
                        >
                          <Zap className="w-3 h-3" />
                          Faucet
                        </a>
                      )}
                      <button
                        onClick={disconnect}
                        className="flex-1 py-2 rounded-lg border border-red-500/20 text-xs text-red-400 hover:bg-red-500/10 transition-colors"
                      >
                        Disconnect
                      </button>
                    </div>
                  </div>
                )}

                {/* ── WALLET LIST ── */}
                {!ws.connected && stage === "list" && (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 mb-3">
                      <span className="text-xs text-muted-foreground">Network:</span>
                      <select
                        value={ws.network}
                        onChange={(e) => switchNetwork(e.target.value)}
                        className="text-xs bg-transparent text-foreground border border-border/30 rounded-md px-2 py-0.5 cursor-pointer focus:outline-none flex-1"
                      >
                        {Object.values(NETWORKS).map((n) => (
                          <option key={n.id} value={n.id}>{n.name} (x402)</option>
                        ))}
                      </select>
                    </div>

                    {WALLETS.map((w) => (
                      <button
                        key={w.id}
                        onClick={() => handleConnect(w.id)}
                        className="w-full flex items-center gap-3 p-3 rounded-xl border border-border/30 hover:bg-foreground/[0.04] transition-all group text-left"
                      >
                        <div className={cn("w-9 h-9 rounded-lg bg-gradient-to-br flex items-center justify-center text-white text-sm font-bold shrink-0", w.color)}>
                          {w.letter}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium">{w.name}</span>
                            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-foreground/10 text-muted-foreground">{w.tag}</span>
                          </div>
                          <p className="text-xs text-muted-foreground mt-0.5 truncate">{w.desc}</p>
                        </div>
                        <ChevronRight className="w-4 h-4 text-muted-foreground/40 group-hover:text-muted-foreground transition-colors shrink-0" />
                      </button>
                    ))}

                    <p className="text-[10px] text-center text-muted-foreground/50 pt-1">
                      Powered by{" "}
                      <a href="https://github.com/marotipatre/x402-Project" target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-muted-foreground transition-colors">
                        x402 Protocol
                      </a>{" "}
                      on Algorand
                    </p>
                  </div>
                )}

                {/* ── LUTE CONNECTING STAGE ── */}
                {stage === "lute-connecting" && connectingWallet && (
                  <div className="space-y-4">
                    <div className="flex items-center gap-3">
                      <div className={cn("w-10 h-10 rounded-xl bg-gradient-to-br flex items-center justify-center text-white text-base font-bold", connectingWallet.color)}>
                        {connectingWallet.letter}
                      </div>
                      <div>
                        <p className="text-sm font-medium">Connecting to Lute</p>
                        <p className="text-xs text-muted-foreground">Approve in the Lute window</p>
                      </div>
                    </div>

                    {/* Spinner status */}
                    <div className="flex items-center gap-3 p-3 rounded-xl bg-foreground/[0.04] border border-border/30">
                      <div className="w-5 h-5 rounded-full border-2 border-indigo-500/30 border-t-indigo-500 animate-spin shrink-0" />
                      <div>
                        <p className="text-xs font-medium">Waiting for approval</p>
                        <p className="text-xs text-muted-foreground">Select your account in the Lute popup</p>
                      </div>
                    </div>

                    {/* Quick paste */}
                    <div className="space-y-1.5">
                      <label className="text-xs text-muted-foreground uppercase tracking-wide">
                        Or paste address from Lute
                      </label>
                      <div className="flex gap-2">
                        <input
                          type="text"
                          value={luteInput}
                          onChange={(e) => setLuteInput(e.target.value.toUpperCase())}
                          onKeyDown={(e) => e.key === "Enter" && doQuickSync()}
                          placeholder="ZYQRMS…"
                          spellCheck={false}
                          className="flex-1 bg-foreground/[0.04] border border-border/30 rounded-lg px-3 py-2 text-xs font-mono focus:outline-none focus:border-indigo-500/50 placeholder:text-muted-foreground/40"
                        />
                        <Button
                          onClick={doQuickSync}
                          size="sm"
                          className="shrink-0 text-xs px-3"
                        >
                          Connect
                        </Button>
                      </div>
                    </div>

                    <div className="flex gap-2">
                      <button
                        onClick={connectLute}
                        className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg border border-border/30 text-xs text-muted-foreground hover:text-foreground transition-colors"
                      >
                        <ExternalLink className="w-3 h-3" />
                        Re-open Lute
                      </button>
                      <button
                        onClick={() => { setStage("list"); setLuteInput(""); }}
                        className="flex-1 py-2 rounded-lg border border-border/30 text-xs text-muted-foreground hover:text-foreground transition-colors"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

                {/* ── WEB WALLET CONNECTING STAGE ── */}
                {stage === "web-connecting" && connectingWallet && (
                  <div className="space-y-4">
                    <div className="flex items-center gap-3">
                      <div className={cn("w-10 h-10 rounded-xl bg-gradient-to-br flex items-center justify-center text-white text-base font-bold", connectingWallet.color)}>
                        {connectingWallet.letter}
                      </div>
                      <div>
                        <p className="text-sm font-medium">Opening {connectingWallet.name}</p>
                        <p className="text-xs text-muted-foreground">Approve the connection in the popup</p>
                      </div>
                    </div>

                    <div className="flex items-center gap-3 p-3 rounded-xl bg-foreground/[0.04] border border-border/30">
                      <div className="w-5 h-5 rounded-full border-2 border-sky-500/30 border-t-sky-500 animate-spin shrink-0" />
                      <div>
                        <p className="text-xs font-medium">{connectingWallet.name} window opened</p>
                        <p className="text-xs text-muted-foreground">Connect your account to continue</p>
                      </div>
                    </div>

                    <div className="flex gap-2">
                      <button
                        onClick={() => connectWebWallet(connectingWallet)}
                        className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg border border-border/30 text-xs text-muted-foreground hover:text-foreground transition-colors"
                      >
                        <ExternalLink className="w-3 h-3" />
                        Re-open
                      </button>
                      <button
                        onClick={() => setStage("list")}
                        className="flex-1 py-2 rounded-lg border border-border/30 text-xs text-muted-foreground hover:text-foreground transition-colors"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </>
  );
}
