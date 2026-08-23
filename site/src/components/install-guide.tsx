/**
 * InstallGuide — Step-by-step interactive visual instructions on how to
 * download, load unpacked, and use the Algogent Chrome Extension.
 *
 * Placed on the Home page (anchored at #how-it-works).
 */

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Download,
  FolderOpen,
  Chrome,
  Wallet,
  Copy,
  Check,
  ExternalLink,
  Sparkles,
  Command,
  ArrowRight,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { fadeUp } from "@/lib/motion";

const REPO_URL = "https://github.com/NagiPragalathan/algogent_hack_blr.git";
const CLONE_CMD = "git clone https://github.com/NagiPragalathan/algogent_hack_blr.git";

interface Step {
  id: string;
  stepNumber: string;
  title: string;
  subtitle: string;
  description: string;
  icon: typeof Download;
  codeSnippet?: string;
  badge?: string;
  details: string[];
}

const STEPS: Step[] = [
  {
    id: "download",
    stepNumber: "01",
    title: "Clone or Download Repository",
    subtitle: "Get the extension source directory onto your machine",
    description:
      "Algogent runs as an unpacked Manifest V3 extension with zero bundler overhead and no remote telemetry. Clone the repository locally:",
    icon: Download,
    codeSnippet: CLONE_CMD,
    details: [
      "No build step or npm compile needed for the extension core.",
      "Files are plain ES modules running directly in your browser.",
    ],
  },
  {
    id: "load",
    stepNumber: "02",
    title: "Load Unpacked in Chrome / Edge",
    subtitle: "Enable developer mode and select the root directory",
    description:
      "Open your browser extension manager and load the unpacked extension:",
    icon: Chrome,
    badge: "chrome://extensions",
    details: [
      "1. Navigate to chrome://extensions (or edge://extensions).",
      "2. Toggle 'Developer mode' ON in the top-right corner.",
      "3. Click 'Load unpacked' and choose the cloned 'algogent_hack_blr' root folder.",
    ],
  },
  {
    id: "open",
    stepNumber: "03",
    title: "Open Side Panel & Drive Models",
    subtitle: "Your active frontier model sessions in a high-speed panel",
    description:
      "Pin Algogent to your toolbar. Click the extension icon or press the global keyboard shortcut to launch the side panel:",
    icon: FolderOpen,
    badge: "Ctrl + Shift + Y (⌘ + Shift + Y)",
    details: [
      "Instantly ask ChatGPT, Gemini, Claude, and Meta AI about your active tab.",
      "Direct API fast-path posts directly via your logged-in cookies for 2s turn speeds.",
    ],
  },
  {
    id: "wallet",
    stepNumber: "04",
    title: "Connect Algorand Wallet & Act",
    subtitle: "Real-time x402 micropayments for autonomous agent runs",
    description:
      "Click the 'Connect' pill in the side panel header to connect your Lute, Pera, Defly, or Exodus wallet:",
    icon: Wallet,
    details: [
      "Pay strictly for completed agent runs (0.02 - 0.05 ALGO) via x402 atomic transactions.",
      "Zero monthly subscriptions, zero seats. Developer receives 80% directly on-chain.",
    ],
  },
];

export function InstallGuide() {
  const [activeStep, setActiveStep] = useState(0);
  const [copied, setCopied] = useState(false);

  const copyCloneCmd = async () => {
    try {
      await navigator.clipboard.writeText(CLONE_CMD);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  };

  const step = STEPS[activeStep];
  const StepIcon = step.icon;

  return (
    <section id="how-it-works" className="bg-cream py-24 md:py-36 px-6 scroll-mt-20">
      <div className="max-w-6xl mx-auto">
        {/* Section Header */}
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-6">
          <div>
            <motion.p
              {...fadeUp(0)}
              className="text-xs tracking-[3px] uppercase text-ink/50 font-semibold"
            >
              Getting Started
            </motion.p>
            <motion.h2
              {...fadeUp(0.06)}
              className="text-ink text-4xl sm:text-5xl md:text-6xl font-normal tracking-tight leading-[1.08] mt-4"
            >
              How to install and{" "}
              <em className="not-italic accent-serif text-[1.12em]">use Algogent</em>
            </motion.h2>
          </div>
          <motion.p
            {...fadeUp(0.12)}
            className="text-ink/65 text-sm md:text-base max-w-md leading-relaxed"
          >
            Load in 60 seconds with Chrome Developer mode. No API keys required,
            no subscriptions — your logged-in AI sessions and on-chain wallet.
          </motion.p>
        </div>

        {/* Interactive Step Selector Grid */}
        <div className="grid lg:grid-cols-12 gap-8 mt-14 items-start">
          {/* Step list pills (Left column) */}
          <div className="lg:col-span-5 space-y-3">
            {STEPS.map((s, i) => {
              const Icon = s.icon;
              const isSelected = i === activeStep;
              return (
                <button
                  key={s.id}
                  onClick={() => setActiveStep(i)}
                  className={cn(
                    "w-full text-left p-5 rounded-2xl border transition-all duration-200 flex items-start gap-4",
                    isSelected
                      ? "bg-paper border-sand shadow-sm"
                      : "bg-paper/50 border-sand/50 hover:bg-paper/80 hover:border-sand"
                  )}
                >
                  <div
                    className={cn(
                      "w-10 h-10 rounded-xl flex items-center justify-center font-mono text-sm font-semibold shrink-0 transition-colors",
                      isSelected
                        ? "bg-ink text-paper"
                        : "bg-ink/5 text-ink/50"
                    )}
                  >
                    {s.stepNumber}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span
                        className={cn(
                          "text-sm font-semibold tracking-tight",
                          isSelected ? "text-ink" : "text-ink/70"
                        )}
                      >
                        {s.title}
                      </span>
                    </div>
                    <p className="text-xs text-ink/50 mt-1 truncate">
                      {s.subtitle}
                    </p>
                  </div>
                  <ArrowRight
                    className={cn(
                      "w-4 h-4 mt-1 transition-transform",
                      isSelected
                        ? "text-ink translate-x-0.5"
                        : "text-ink/20 opacity-0"
                    )}
                  />
                </button>
              );
            })}
          </div>

          {/* Active Step Detailed Card (Right column) */}
          <div className="lg:col-span-7">
            <AnimatePresence mode="wait">
              <motion.div
                key={step.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.25, ease: "easeOut" }}
                className="bg-paper border border-sand rounded-3xl p-7 md:p-10 shadow-sm"
              >
                {/* Header */}
                <div className="flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3">
                    <div className="w-12 h-12 rounded-2xl bg-ink/5 border border-sand flex items-center justify-center">
                      <StepIcon className="w-5 h-5 text-ink" />
                    </div>
                    <div>
                      <span className="font-mono text-xs text-ink/40 font-semibold tracking-widest uppercase">
                        Step {step.stepNumber} of 04
                      </span>
                      <h3 className="text-xl md:text-2xl font-normal text-ink tracking-tight">
                        {step.title}
                      </h3>
                    </div>
                  </div>

                  {step.badge && (
                    <span className="hidden sm:inline-flex items-center gap-1.5 text-xs font-mono bg-ink/5 border border-sand text-ink/70 px-3 py-1.5 rounded-lg">
                      <Command className="w-3 h-3 text-ink/40" />
                      {step.badge}
                    </span>
                  )}
                </div>

                <p className="text-ink/75 text-sm md:text-base leading-relaxed mt-6">
                  {step.description}
                </p>

                {/* Code snippet block if available */}
                {step.codeSnippet && (
                  <div className="mt-5 bg-ink text-paper/90 rounded-2xl p-4 font-mono text-xs flex items-center justify-between gap-3 border border-ink-strong">
                    <span className="truncate select-all text-paper/80">
                      $ {step.codeSnippet}
                    </span>
                    <button
                      onClick={copyCloneCmd}
                      className="shrink-0 flex items-center gap-1.5 bg-paper/10 hover:bg-paper/20 text-paper text-xs px-3 py-1.5 rounded-lg transition-colors"
                      title="Copy clone command"
                    >
                      {copied ? (
                        <>
                          <Check className="w-3.5 h-3.5 text-status-live" />
                          <span>Copied</span>
                        </>
                      ) : (
                        <>
                          <Copy className="w-3.5 h-3.5" />
                          <span>Copy</span>
                        </>
                      )}
                    </button>
                  </div>
                )}

                {/* Step Detailed Bullets */}
                <div className="mt-6 pt-6 border-t border-sand/60 space-y-3">
                  <p className="text-[11px] tracking-[2px] uppercase text-ink/40 font-semibold">
                    Key Instructions
                  </p>
                  <ul className="space-y-2.5">
                    {step.details.map((d, idx) => (
                      <li
                        key={idx}
                        className="flex items-start gap-2.5 text-xs md:text-sm text-ink/70 leading-relaxed"
                      >
                        <Sparkles className="w-3.5 h-3.5 text-ink/40 mt-1 shrink-0" />
                        <span>{d}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                {/* Next step button */}
                <div className="mt-8 pt-6 border-t border-sand/60 flex items-center justify-between">
                  <a
                    href={REPO_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs text-ink/60 hover:text-ink flex items-center gap-1.5 transition-colors"
                  >
                    View on GitHub
                    <ExternalLink className="w-3 h-3" />
                  </a>

                  {activeStep < STEPS.length - 1 ? (
                    <button
                      onClick={() => setActiveStep((s) => s + 1)}
                      className="inline-flex items-center gap-2 bg-ink text-paper text-xs font-medium uppercase tracking-wider rounded-full px-5 py-2.5 hover:bg-ink-strong transition-colors"
                    >
                      Next Step
                      <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                  ) : (
                    <a
                      href="#pricing"
                      className="inline-flex items-center gap-2 bg-status-live text-paper text-xs font-medium uppercase tracking-wider rounded-full px-5 py-2.5 hover:opacity-90 transition-opacity"
                    >
                      Explore x402 Pricing
                    </a>
                  )}
                </div>
              </motion.div>
            </AnimatePresence>
          </div>
        </div>
      </div>
    </section>
  );
}
