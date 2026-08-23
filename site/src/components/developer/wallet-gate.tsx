/**
 * WalletGate — blocks the skill upload form until a wallet is connected.
 *
 * When disconnected: shows a connect prompt with explanation.
 * When connected: shows the address badge and "ready to publish" confirmation.
 *
 * The address shown is the payout address that will be locked into the agent
 * registration — no manual address entry, no override.
 */

import { motion } from "framer-motion";
import { Wallet, Lock, CheckCircle2, ExternalLink } from "lucide-react";
import { WalletButton } from "@/components/wallet-button";
import { useWallet, NETWORKS, ellipseAddress } from "@/hooks/use-wallet";
import { fadeUp } from "@/lib/motion";

export function WalletGate({ children }: { children: React.ReactNode }) {
  const { state } = useWallet();
  const cfg = NETWORKS[state.network];

  if (!state.connected) {
    return (
      <motion.div
        {...fadeUp(0.1)}
        className="bg-paper border border-sand rounded-3xl p-8 md:p-12 flex flex-col items-center text-center gap-6"
      >
        {/* Icon */}
        <div className="w-16 h-16 rounded-2xl bg-ink/8 flex items-center justify-center">
          <Wallet className="w-7 h-7 text-ink/50" />
        </div>

        {/* Copy */}
        <div className="max-w-md">
          <h2 className="text-ink text-2xl font-normal tracking-tight">
            Connect your wallet to publish
          </h2>
          <p className="text-ink/60 text-sm mt-3 leading-relaxed">
            Your connected wallet address becomes the <strong className="text-ink font-medium">payout address</strong> for
            every invocation of your agent. There is no manual entry — the
            address that receives your 80% share is the one you connect here.
          </p>
        </div>

        {/* Connect button */}
        <div className="flex flex-col items-center gap-3">
          <WalletButton />
          <p className="text-ink/40 text-xs">
            Supports Lute, Pera, Defly, and Exodus wallets
          </p>
        </div>

        {/* What happens after */}
        <div className="w-full max-w-sm bg-ink/[0.03] border border-sand/60 rounded-2xl p-5 text-left">
          <p className="text-[11px] tracking-[2px] uppercase text-ink/40 mb-3">
            After connecting
          </p>
          <ul className="space-y-2.5 text-sm text-ink/65">
            <li className="flex items-start gap-2.5">
              <CheckCircle2 className="w-4 h-4 text-status-live mt-0.5 shrink-0" />
              Upload your SKILL.md file
            </li>
            <li className="flex items-start gap-2.5">
              <CheckCircle2 className="w-4 h-4 text-status-live mt-0.5 shrink-0" />
              Payout address is auto-filled from your wallet
            </li>
            <li className="flex items-start gap-2.5">
              <CheckCircle2 className="w-4 h-4 text-status-live mt-0.5 shrink-0" />
              80% of every call settles on-chain to your address
            </li>
          </ul>
        </div>
      </motion.div>
    );
  }

  return (
    <>
      {/* Connected address confirmation banner */}
      <motion.div
        {...fadeUp(0)}
        className="bg-status-live/[0.06] border border-status-live/25 rounded-2xl px-5 py-3.5 flex items-center gap-3 mb-6"
      >
        <CheckCircle2 className="w-4 h-4 text-status-live shrink-0" />
        <div className="flex-1 min-w-0">
          <span className="text-sm text-ink/80">
            Payout address locked to wallet:{" "}
          </span>
          <span className="font-mono text-sm text-ink font-medium">
            {ellipseAddress(state.address, 8, 8)}
          </span>
          <span className="text-ink/50 text-xs ml-2">
            ({cfg.name} · {state.algoBalance} ALGO)
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <Lock className="w-3 h-3 text-ink/35" />
          <a
            href={`${cfg.explorerUrl}${state.address}`}
            target="_blank"
            rel="noreferrer"
            className="text-ink/40 hover:text-ink/70 transition-colors"
            title="View in explorer"
          >
            <ExternalLink className="w-3.5 h-3.5" />
          </a>
        </div>
      </motion.div>

      {children}
    </>
  );
}
