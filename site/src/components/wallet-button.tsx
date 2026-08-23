/**
 * WalletButton — top-bar wallet connection pill for the marketplace site.
 *
 * Shows:
 *  - "Connect Wallet" pill when disconnected
 *  - Address pill (green dot + truncated address) when connected
 *  - Dropdown panel for wallet selection / connected account details
 */

import { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Wallet,
  CheckCircle2,
  Copy,
  ExternalLink,
  RefreshCw,
  LogOut,
  Droplets,
  ChevronDown,
  X,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useWallet, NETWORKS, type WalletId } from "@/hooks/use-wallet";

const WALLETS: {
  id: WalletId;
  name: string;
  tag: string;
  letter: string;
  color: string;
  desc: string;
}[] = [
  {
    id: "lute",
    name: "Lute Wallet",
    tag: "Official",
    letter: "L",
    color: "from-violet-600 to-indigo-500",
    desc: "Connect your existing Lute accounts instantly",
  },
  {
    id: "pera",
    name: "Pera Wallet",
    tag: "Mobile & Web",
    letter: "P",
    color: "from-blue-500 to-cyan-400",
    desc: "Official Algorand wallet — mobile & browser",
  },
  {
    id: "defly",
    name: "Defly Wallet",
    tag: "DeFi",
    letter: "D",
    color: "from-emerald-500 to-teal-400",
    desc: "Algorand DeFi & payments wallet",
  },
  {
    id: "exodus",
    name: "Exodus",
    tag: "Web3",
    letter: "E",
    color: "from-purple-600 to-pink-500",
    desc: "Multi-asset browser wallet",
  },
];

export function WalletButton() {
  const { state, connect, disconnect, switchNetwork, refreshBalance, ellipseAddress, NETWORKS: nets } =
    useWallet();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open]);

  async function copyAddress() {
    try {
      await navigator.clipboard.writeText(state.address);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* ignore */ }
  }

  const cfg = NETWORKS[state.network];

  return (
    <div ref={ref} className="relative">
      {/* ── Pill Button ── */}
      <button
        id="wallet-connect-btn"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex items-center gap-2 h-9 px-3.5 rounded-full text-sm font-medium transition-all duration-200",
          "border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2",
          state.connected
            ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/20 focus-visible:ring-emerald-500"
            : "bg-white/10 border-white/20 text-white/90 hover:bg-white/20 focus-visible:ring-white/50"
        )}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        {state.loading ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
        ) : state.connected ? (
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
        ) : (
          <Wallet className="w-3.5 h-3.5" />
        )}
        <span>
          {state.connected
            ? ellipseAddress(state.address, 5, 4)
            : state.loading
            ? "Connecting…"
            : "Connect Wallet"}
        </span>
        <ChevronDown
          className={cn(
            "w-3 h-3 transition-transform duration-200",
            open && "rotate-180"
          )}
        />
      </button>

      {/* ── Dropdown Panel ── */}
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.97 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            className="absolute right-0 top-full mt-2 w-[340px] z-50 rounded-2xl overflow-hidden border border-white/10 shadow-2xl shadow-black/60"
            style={{
              background:
                "linear-gradient(145deg, rgba(22,17,34,0.97) 0%, rgba(14,10,24,0.99) 100%)",
              backdropFilter: "blur(24px)",
            }}
            role="dialog"
            aria-label="Wallet panel"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-white/8">
              <div className="flex items-center gap-2 text-sm font-semibold text-white/90">
                <Wallet className="w-3.5 h-3.5 text-violet-400" />
                {state.connected ? "Connected Wallet" : "Connect Wallet"}
              </div>
              <button
                onClick={() => setOpen(false)}
                className="w-6 h-6 flex items-center justify-center rounded-full text-white/40 hover:text-white/80 hover:bg-white/8 transition-colors"
                aria-label="Close wallet panel"
              >
                <X className="w-3 h-3" />
              </button>
            </div>

            {state.connected ? (
              /* ── Connected View ── */
              <div className="p-4 space-y-3">
                {/* Provider + network row */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                    <span className="text-sm font-medium text-emerald-300">
                      {state.providerName}
                    </span>
                  </div>
                  <select
                    value={state.network}
                    onChange={(e) => switchNetwork(e.target.value as "testnet" | "mainnet")}
                    className="text-xs bg-white/8 border border-white/12 rounded-lg px-2 py-1 text-white/70 focus:outline-none focus:ring-1 focus:ring-violet-500/50 cursor-pointer"
                    aria-label="Switch network"
                  >
                    {Object.values(nets).map((n) => (
                      <option key={n.id} value={n.id}>
                        {n.name}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Address bar */}
                <div className="flex items-center gap-2 bg-white/5 border border-white/8 rounded-xl px-3 py-2.5">
                  <span className="flex-1 font-mono text-xs text-white/60 truncate select-all">
                    {state.address}
                  </span>
                  <button
                    onClick={copyAddress}
                    className="shrink-0 text-white/40 hover:text-white/80 transition-colors"
                    title="Copy address"
                    aria-label="Copy address"
                  >
                    {copied ? (
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                    ) : (
                      <Copy className="w-3.5 h-3.5" />
                    )}
                  </button>
                  <a
                    href={`${cfg.explorerUrl}${state.address}`}
                    target="_blank"
                    rel="noreferrer"
                    className="shrink-0 text-white/40 hover:text-violet-400 transition-colors"
                    title="View in explorer"
                    aria-label="View in explorer"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                </div>

                {/* Balances */}
                <div className="grid grid-cols-2 gap-2">
                  <div className="bg-white/5 border border-white/8 rounded-xl p-3">
                    <div className="text-[10px] uppercase tracking-widest text-white/40 mb-1">
                      ALGO
                    </div>
                    <div className="text-sm font-semibold text-white/90">
                      {state.algoBalance}
                    </div>
                  </div>
                  <div className="bg-white/5 border border-white/8 rounded-xl p-3">
                    <div className="text-[10px] uppercase tracking-widest text-white/40 mb-1">
                      USDC (x402)
                    </div>
                    <div className="text-sm font-semibold text-white/90">
                      {state.usdcBalance}
                    </div>
                  </div>
                </div>

                {/* x402 badge */}
                <div className="flex items-center gap-2 text-[11px] text-violet-300/80 bg-violet-500/8 border border-violet-500/15 rounded-lg px-3 py-2">
                  <CheckCircle2 className="w-3 h-3 shrink-0" />
                  x402 HTTP payment protocol ready · {cfg.name}
                </div>

                {/* Actions */}
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => { refreshBalance(); }}
                    className="flex items-center gap-1.5 text-xs text-white/50 hover:text-white/80 transition-colors px-2 py-1.5 rounded-lg hover:bg-white/5"
                    title="Refresh balance"
                  >
                    <RefreshCw className="w-3 h-3" />
                    Refresh
                  </button>
                  {cfg.faucetUrl && (
                    <a
                      href={cfg.faucetUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-center gap-1.5 text-xs text-white/50 hover:text-emerald-400 transition-colors px-2 py-1.5 rounded-lg hover:bg-white/5"
                    >
                      <Droplets className="w-3 h-3" />
                      Faucet
                    </a>
                  )}
                  <button
                    onClick={() => { disconnect(); setOpen(false); }}
                    className="ml-auto flex items-center gap-1.5 text-xs text-red-400/70 hover:text-red-400 transition-colors px-2 py-1.5 rounded-lg hover:bg-red-500/8"
                    aria-label="Disconnect wallet"
                  >
                    <LogOut className="w-3 h-3" />
                    Disconnect
                  </button>
                </div>
              </div>
            ) : (
              /* ── Wallet Select View ── */
              <div className="p-3 space-y-1.5">
                {/* Network selector */}
                <div className="flex items-center justify-between px-1 pb-1">
                  <span className="text-[11px] text-white/40 uppercase tracking-widest">
                    Network
                  </span>
                  <select
                    value={state.network}
                    onChange={(e) => switchNetwork(e.target.value as "testnet" | "mainnet")}
                    className="text-xs bg-white/8 border border-white/12 rounded-lg px-2 py-1 text-white/70 focus:outline-none focus:ring-1 focus:ring-violet-500/50 cursor-pointer"
                    aria-label="Choose network"
                  >
                    {Object.values(nets).map((n) => (
                      <option key={n.id} value={n.id}>
                        Algorand {n.name}
                      </option>
                    ))}
                  </select>
                </div>

                {WALLETS.map((w) => (
                  <button
                    key={w.id}
                    id={`wallet-connect-${w.id}`}
                    onClick={() => { connect(w.id); }}
                    disabled={state.loading}
                    className={cn(
                      "w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-all duration-150",
                      "border border-transparent hover:border-white/10 hover:bg-white/5",
                      "disabled:opacity-50 disabled:cursor-not-allowed",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/50"
                    )}
                  >
                    {/* Icon */}
                    <div
                      className={cn(
                        "w-9 h-9 rounded-xl flex items-center justify-center text-sm font-bold text-white bg-gradient-to-br shrink-0",
                        w.color
                      )}
                    >
                      {w.letter}
                    </div>
                    {/* Labels */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-white/90">
                          {w.name}
                        </span>
                        <span className="text-[10px] bg-white/8 border border-white/12 text-white/50 px-1.5 py-0.5 rounded-md">
                          {w.tag}
                        </span>
                      </div>
                      <div className="text-xs text-white/40 mt-0.5 truncate">{w.desc}</div>
                    </div>
                    {/* Arrow */}
                    <ChevronDown className="w-3.5 h-3.5 text-white/25 -rotate-90 shrink-0" />
                  </button>
                ))}

                <div className="pt-1 pb-0.5 text-center text-[11px] text-white/30">
                  Powered by{" "}
                  <a
                    href="https://github.com/marotipatre/x402-Project"
                    target="_blank"
                    rel="noreferrer"
                    className="text-violet-400/70 hover:text-violet-400 transition-colors"
                  >
                    x402 on Algorand
                  </a>
                </div>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
