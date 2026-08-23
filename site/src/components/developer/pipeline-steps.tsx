/**
 * PipelineSteps — visual 3-step diagram showing the SKILL.md → live agent pipeline.
 *
 * Each step changes state based on props:
 *   idle → active (currently on this step) → done (completed)
 */

import { motion } from "framer-motion";
import { Upload, Cpu, Zap, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { fadeUp } from "@/lib/motion";

type StepStatus = "idle" | "active" | "done";

export interface PipelineStatus {
  upload: StepStatus;
  parse: StepStatus;
  live: StepStatus;
}

const STEPS = [
  {
    key: "upload" as const,
    icon: Upload,
    label: "Upload SKILL.md",
    desc: "Drop your skill definition file. Required: name, description, trigger, inputs, and outputs.",
  },
  {
    key: "parse" as const,
    icon: Cpu,
    label: "Parse & Validate",
    desc: "Schema is checked field-by-field. Missing sections produce specific, actionable errors.",
  },
  {
    key: "live" as const,
    icon: Zap,
    label: "Go Live",
    desc: "Agent appears in the marketplace catalog. Every invocation settles 80% to your wallet on-chain.",
  },
];

function StepNode({
  icon: Icon,
  label,
  desc,
  status,
  index,
}: {
  icon: typeof Upload;
  label: string;
  desc: string;
  status: StepStatus;
  index: number;
}) {
  return (
    <motion.div {...fadeUp(0.08 * index)} className="flex gap-4">
      {/* Icon circle */}
      <div className="flex flex-col items-center gap-2 shrink-0">
        <div
          className={cn(
            "w-10 h-10 rounded-full flex items-center justify-center border-2 transition-colors duration-300",
            status === "done"
              ? "bg-status-live border-status-live"
              : status === "active"
              ? "bg-ink border-ink"
              : "bg-paper border-sand"
          )}
        >
          {status === "done" ? (
            <Check className="w-4 h-4 text-paper" />
          ) : (
            <Icon
              className={cn(
                "w-4 h-4",
                status === "active" ? "text-paper" : "text-ink/35"
              )}
            />
          )}
        </div>
        {index < STEPS.length - 1 && (
          <div
            className={cn(
              "w-px flex-1 min-h-[28px] transition-colors duration-300",
              status === "done" ? "bg-status-live/40" : "bg-sand/60"
            )}
          />
        )}
      </div>

      {/* Text */}
      <div className="pb-6">
        <p
          className={cn(
            "text-sm font-medium tracking-tight transition-colors",
            status === "active"
              ? "text-ink"
              : status === "done"
              ? "text-status-live"
              : "text-ink/50"
          )}
        >
          {label}
        </p>
        <p className="text-xs text-ink/45 mt-1 leading-relaxed max-w-xs">{desc}</p>
      </div>
    </motion.div>
  );
}

export function PipelineSteps({ status }: { status: PipelineStatus }) {
  return (
    <div className="bg-paper border border-sand rounded-3xl p-6 md:p-8">
      <p className="text-[11px] tracking-[2px] uppercase text-ink/50 mb-6">
        Pipeline
      </p>
      <div>
        {STEPS.map((step, i) => (
          <StepNode
            key={step.key}
            icon={step.icon}
            label={step.label}
            desc={step.desc}
            status={status[step.key]}
            index={i}
          />
        ))}
      </div>
    </div>
  );
}
