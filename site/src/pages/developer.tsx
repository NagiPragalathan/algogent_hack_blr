import { useState } from "react";
import { motion } from "framer-motion";
import { Link } from "react-router-dom";
import { ArrowLeft, Sparkles } from "lucide-react";
import { WalletGate } from "@/components/developer/wallet-gate";
import { SkillUploadForm } from "@/components/developer/skill-upload-form";
import { PipelineSteps, type PipelineStatus } from "@/components/developer/pipeline-steps";
import { RevenueSplit } from "@/components/publish/revenue-split";
import { useRegistryListing } from "@/hooks/use-registry-listing";
import { usePageTitle } from "@/hooks/use-page-title";
import { fadeUp } from "@/lib/motion";

/**
 * Developer Portal — Skill-to-Agent Marketplace Pipeline.
 *
 * Developers upload a SKILL.md file describing an agent's capabilities.
 * Wallet connectivity is required: the developer's connected wallet address
 * is automatically set as the payout address (where 80% developer revenue settles).
 */
export function DeveloperPage() {
  usePageTitle("Developer Portal — Convert SKILL.md to Agent");
  const { listing, error } = useRegistryListing();
  const [pipelineStatus, setPipelineStatus] = useState<PipelineStatus>({
    upload: "idle",
    parse: "idle",
    live: "idle",
  });

  return (
    <section className="bg-cream pt-32 md:pt-40 pb-24 md:pb-32 px-6 min-h-screen">
      <div className="max-w-6xl mx-auto">
        <motion.div {...fadeUp(0)}>
          <Link
            to="/"
            className="inline-flex items-center gap-2 text-sm text-ink/60 hover:text-ink transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to home
          </Link>
        </motion.div>

        <motion.div {...fadeUp(0.06)} className="flex items-center gap-2 mt-10">
          <span className="text-xs tracking-[3px] uppercase text-ink/50 font-semibold">
            Developer Portal
          </span>
          <span className="inline-flex items-center gap-1 text-[11px] bg-ink/10 text-ink font-medium px-2.5 py-0.5 rounded-full">
            <Sparkles className="w-3 h-3 text-ink/70" />
            Skill-to-Agent Pipeline
          </span>
        </motion.div>

        <motion.h1
          {...fadeUp(0.12)}
          className="text-ink text-5xl md:text-7xl font-normal tracking-tight leading-[1.05] mt-6 max-w-4xl"
        >
          Convert SKILL.md into a{" "}
          <em className="not-italic accent-serif">live agent</em>
        </motion.h1>

        <motion.p
          {...fadeUp(0.18)}
          className="text-ink/65 text-base md:text-lg max-w-2xl mt-6 leading-relaxed"
        >
          Upload your <code className="font-mono text-sm bg-ink/5 px-1.5 py-0.5 rounded text-ink font-medium">SKILL.md</code> file
          to turn your capability into a containerized, monetized agent. Connect your wallet to receive 80% on-chain payouts per invocation via x402.
        </motion.p>

        <div className="grid lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] gap-8 lg:gap-12 mt-14 items-start">
          {/* Main upload section gated by wallet */}
          <motion.div {...fadeUp(0.24)}>
            <WalletGate>
              <SkillUploadForm
                listing={listing}
                onPipelineChange={setPipelineStatus}
              />
            </WalletGate>
          </motion.div>

          {/* Sidebar */}
          <motion.div {...fadeUp(0.3)} className="space-y-6 lg:sticky lg:top-28">
            <PipelineSteps status={pipelineStatus} />

            <RevenueSplit listing={listing} error={error} />

            <div className="bg-paper border border-sand rounded-3xl p-6 md:p-8">
              <p className="text-[11px] tracking-[2px] uppercase text-ink/50">
                SKILL.md Specification
              </p>
              <ul className="mt-4 space-y-3 text-sm text-ink/70 leading-relaxed">
                <li>
                  <strong className="text-ink font-medium">Frontmatter</strong>: Must include <code className="font-mono text-xs">name</code>, <code className="font-mono text-xs">description</code>, and <code className="font-mono text-xs">trigger</code>.
                </li>
                <li>
                  <strong className="text-ink font-medium">Inputs & Outputs</strong>: Must contain structured <code className="font-mono text-xs">## Inputs</code> and <code className="font-mono text-xs">## Outputs</code> sections.
                </li>
                <li>
                  <strong className="text-ink font-medium">Payout Address</strong>: Strictly bound to your connected Algorand wallet for deterministic on-chain settlement.
                </li>
              </ul>
            </div>
          </motion.div>
        </div>
      </div>
    </section>
  );
}
