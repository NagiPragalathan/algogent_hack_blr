/**
 * SkillUploadForm — the developer upload form for the /developer page.
 *
 * Stages:
 *   1. Drop zone — accepts .md files via drag-and-drop or file picker
 *   2. Parse & validate — runs client-side SKILL.md schema validation immediately
 *      on file selection, shows field-specific errors if invalid
 *   3. Preview — shows extracted name, description, trigger, inputs, outputs
 *   4. Submit form — Agent ID (editable, auto-suggested), price, payout address
 *      (read-only, from wallet). Calls registerAgent().
 *   5. Success screen — shows registered agent details
 *
 * The payout address is ALWAYS taken from the connected wallet.
 * It is shown in a locked field — not editable.
 */

import { useState, useRef, useCallback, type FormEvent, type DragEvent } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Upload,
  FileText,
  AlertCircle,
  CheckCircle2,
  Lock,
  Loader2,
  X,
  RefreshCw,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { parseSkillMd, type SkillDefinition, type SkillFieldError } from "@/lib/skill-schema";
import { useWallet } from "@/hooks/use-wallet";
import { registerAgent, priceProblem, type RegistryListing } from "@/lib/registry";
import type { PipelineStatus } from "./pipeline-steps";
import { fadeUp } from "@/lib/motion";

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;

interface Props {
  listing: RegistryListing | null;
  onPipelineChange: (s: PipelineStatus) => void;
}

interface Published {
  id: string;
  name: string;
  priceAlgo: string;
  payoutAddress: string;
  network: string;
  status: string;
}

export function SkillUploadForm({ listing, onPipelineChange }: Props) {
  const { state: wallet } = useWallet();

  // File state
  const [file, setFile] = useState<File | null>(null);
  const [fileContent, setFileContent] = useState<string>("");
  const [dragging, setDragging] = useState(false);

  // Parse state
  const [parsed, setParsed] = useState<SkillDefinition | null>(null);
  const [parseErrors, setParseErrors] = useState<SkillFieldError[]>([]);
  const [parseWarnings, setParseWarnings] = useState<string[]>([]);
  const [showWarnings, setShowWarnings] = useState(false);

  // Form state
  const [agentId, setAgentId] = useState("");
  const [agentIdError, setAgentIdError] = useState("");
  const [price, setPrice] = useState("0.05");
  const [priceError, setPriceError] = useState("");
  const [email, setEmail] = useState("");

  // Submit state
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [published, setPublished] = useState<Published | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  /** Process a selected file */
  const processFile = useCallback(
    (f: File) => {
      if (!f.name.endsWith(".md")) {
        setParseErrors([{ field: "file", message: "File must be a .md (Markdown) file." }]);
        return;
      }
      const reader = new FileReader();
      reader.onload = (e) => {
        const text = e.target?.result as string;
        setFile(f);
        setFileContent(text);
        setParseErrors([]);
        setParseWarnings([]);
        setParsed(null);

        const result = parseSkillMd(text);
        if (!result.valid) {
          setParseErrors(result.errors);
          setParseWarnings(result.warnings);
          onPipelineChange({ upload: "done", parse: "active", live: "idle" });
        } else {
          setParsed(result.parsed);
          setParseWarnings(result.warnings);
          // Auto-fill agent ID from skill name
          const takenIds = listing?.agents.map((a) => a.id) ?? [];
          let suggested = result.parsed.suggestedId;
          if (takenIds.includes(suggested)) {
            suggested = `${suggested}-2`;
          }
          setAgentId(suggested);
          onPipelineChange({ upload: "done", parse: "done", live: "active" });
        }
      };
      reader.readAsText(f);
      onPipelineChange({ upload: "active", parse: "idle", live: "idle" });
    },
    [listing, onPipelineChange]
  );

  // Drag events
  const onDragOver = (e: DragEvent) => {
    e.preventDefault();
    setDragging(true);
  };
  const onDragLeave = () => setDragging(false);
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files[0];
    if (f) processFile(f);
  };
  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) processFile(f);
  };

  const reset = () => {
    setFile(null);
    setFileContent("");
    setParsed(null);
    setParseErrors([]);
    setParseWarnings([]);
    setAgentId("");
    setAgentIdError("");
    setPrice("0.05");
    setPriceError("");
    setEmail("");
    setSubmitError(null);
    onPipelineChange({ upload: "idle", parse: "idle", live: "idle" });
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const validateForm = (): boolean => {
    let ok = true;
    if (!ID_PATTERN.test(agentId.trim())) {
      setAgentIdError(
        "2–64 characters: lowercase letters, numbers and hyphens, starting with a letter or number."
      );
      ok = false;
    } else {
      const taken = listing?.agents.map((a) => a.id) ?? [];
      if (taken.includes(agentId.trim())) {
        setAgentIdError(`Agent ID "${agentId}" is already taken.`);
        ok = false;
      }
    }
    const pp = priceProblem(price);
    if (pp) {
      setPriceError(pp);
      ok = false;
    }
    return ok;
  };

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!parsed || !wallet.connected) return;
    if (!validateForm()) return;

    setSubmitting(true);
    setSubmitError(null);

    const skillMdBase64 = btoa(unescape(encodeURIComponent(fileContent)));

    const result = await registerAgent({
      id: agentId.trim(),
      name: parsed.name,
      priceAlgo: price.trim(),
      payoutAddress: wallet.address,
      description: parsed.description,
      body: parsed.trigger,
      email: email.trim() || undefined,
      skillMd: skillMdBase64,
    });

    setSubmitting(false);

    if (!result.ok) {
      // Map known error codes to form fields
      if (result.error.error === "id_taken") setAgentIdError(result.error.message);
      else if (result.error.error === "invalid_id") setAgentIdError(result.error.message);
      else if (result.error.error === "invalid_price") setPriceError(result.error.message);
      else setSubmitError(result.error.message);
      return;
    }

    setPublished({
      id: result.data.id,
      name: result.data.name,
      priceAlgo: result.data.priceAlgo,
      payoutAddress: result.data.payoutAddress,
      network: result.data.network,
      status: result.data.status,
    });
    onPipelineChange({ upload: "done", parse: "done", live: "done" });
  }

  // ── Success Screen ──────────────────────────────────────────────────────────
  if (published) {
    return (
      <motion.div {...fadeUp(0)} className="bg-paper border border-sand rounded-3xl p-8 md:p-10">
        <div className="w-11 h-11 rounded-full bg-status-live/15 flex items-center justify-center">
          <CheckCircle2 className="w-5 h-5 text-status-live" />
        </div>
        <h2 className="text-ink text-2xl font-normal tracking-tight mt-5">
          {published.name} is{" "}
          <em className="not-italic accent-serif text-[1.6rem]">live</em>
        </h2>
        <p className="text-ink/60 text-sm mt-2 leading-relaxed">
          Your agent is now listed on the marketplace. Every call settles 80% to
          your wallet address on-chain.
        </p>

        <dl className="mt-6 space-y-3 text-sm">
          {[
            ["Agent ID", published.id],
            ["Price per call", `${published.priceAlgo} ALGO`],
            ["Payout address", published.payoutAddress.slice(0, 10) + "…" + published.payoutAddress.slice(-10)],
            ["Network", published.network],
            ["Status", published.status],
          ].map(([label, value]) => (
            <div
              key={label}
              className="flex justify-between gap-4 border-b border-sand pb-3"
            >
              <dt className="text-ink/55">{label}</dt>
              <dd className="text-ink font-medium text-right break-all">{value}</dd>
            </div>
          ))}
        </dl>

        <button
          type="button"
          onClick={() => {
            setPublished(null);
            reset();
          }}
          className="mt-6 text-sm font-medium text-ink underline underline-offset-4 hover:opacity-70 transition-opacity"
        >
          Publish another agent
        </button>
      </motion.div>
    );
  }

  // ── Drop Zone (no file yet) ─────────────────────────────────────────────────
  const dropZone = !file && (
    <motion.div {...fadeUp(0)}>
      <input
        ref={fileInputRef}
        type="file"
        accept=".md"
        className="sr-only"
        id="skill-file-input"
        onChange={onFileChange}
      />
      <label
        htmlFor="skill-file-input"
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className={cn(
          "flex flex-col items-center gap-4 p-10 md:p-14 rounded-3xl border-2 border-dashed cursor-pointer",
          "transition-colors duration-200 text-center",
          dragging
            ? "border-ink bg-ink/5"
            : "border-sand hover:border-ink/30 hover:bg-ink/[0.02] bg-paper"
        )}
      >
        <div
          className={cn(
            "w-14 h-14 rounded-2xl flex items-center justify-center transition-colors",
            dragging ? "bg-ink text-paper" : "bg-sand/40 text-ink/50"
          )}
        >
          <Upload className="w-6 h-6" />
        </div>
        <div>
          <p className="text-ink font-medium text-base">
            {dragging ? "Drop your SKILL.md here" : "Drop your SKILL.md file"}
          </p>
          <p className="text-ink/50 text-sm mt-1">
            or{" "}
            <span className="text-ink underline underline-offset-2">browse</span>{" "}
            to choose a .md file
          </p>
        </div>
        <div className="text-xs text-ink/40 max-w-xs leading-relaxed">
          Required: <code className="font-mono">name</code>,{" "}
          <code className="font-mono">description</code>,{" "}
          <code className="font-mono">trigger</code> in frontmatter + {" "}
          <code className="font-mono">## Inputs</code> and{" "}
          <code className="font-mono">## Outputs</code> sections
        </div>
      </label>
    </motion.div>
  );

  // ── Parse Errors ───────────────────────────────────────────────────────────
  const errorPanel = parseErrors.length > 0 && (
    <motion.div {...fadeUp(0)} className="bg-paper border border-sand rounded-3xl p-6 space-y-4">
      {/* File header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <FileText className="w-4 h-4 text-ink/50" />
          <span className="text-sm font-medium text-ink">{file?.name}</span>
        </div>
        <button
          type="button"
          onClick={reset}
          className="text-ink/40 hover:text-ink transition-colors"
          title="Remove file"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="border-t border-sand pt-4 space-y-3">
        <div className="flex items-center gap-2 text-sm font-medium text-status-down">
          <AlertCircle className="w-4 h-4 shrink-0" />
          {parseErrors.length === 1
            ? "1 validation error found"
            : `${parseErrors.length} validation errors found`}
        </div>
        {parseErrors.map((err, i) => (
          <div
            key={i}
            className="bg-status-down/[0.06] border border-status-down/20 rounded-xl px-4 py-3"
          >
            <span className="text-xs font-mono font-semibold text-status-down/80 uppercase">
              {err.field}
            </span>
            <p className="text-sm text-ink/75 mt-1 whitespace-pre-wrap leading-relaxed">
              {err.message}
            </p>
          </div>
        ))}
      </div>

      <button
        type="button"
        onClick={reset}
        className="flex items-center gap-2 text-sm text-ink/60 hover:text-ink transition-colors"
      >
        <RefreshCw className="w-3.5 h-3.5" />
        Upload a different file
      </button>
    </motion.div>
  );

  // ── Parsed Preview + Form ──────────────────────────────────────────────────
  const form = parsed && (
    <motion.form {...fadeUp(0)} onSubmit={onSubmit} noValidate className="space-y-6">
      {/* Parsed preview card */}
      <div className="bg-paper border border-sand rounded-3xl p-6 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 rounded-lg bg-ink/8 flex items-center justify-center shrink-0">
              <FileText className="w-4 h-4 text-ink/60" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-medium text-ink truncate">{file?.name}</p>
              <p className="text-xs text-ink/40">{(file!.size / 1024).toFixed(1)} KB</p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <CheckCircle2 className="w-4 h-4 text-status-live" />
            <span className="text-xs text-status-live font-medium">Valid SKILL.md</span>
            <button
              type="button"
              onClick={reset}
              className="text-ink/30 hover:text-ink/60 ml-1 transition-colors"
              title="Replace file"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Parsed data preview */}
        <div className="border-t border-sand pt-4 grid sm:grid-cols-2 gap-4">
          <div>
            <p className="text-[10px] uppercase tracking-widest text-ink/40 mb-1">Name</p>
            <p className="text-sm text-ink font-medium">{parsed.name}</p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-widest text-ink/40 mb-1">Version</p>
            <p className="text-sm text-ink font-mono">{parsed.version}</p>
          </div>
          <div className="sm:col-span-2">
            <p className="text-[10px] uppercase tracking-widest text-ink/40 mb-1">Description</p>
            <p className="text-sm text-ink/75 leading-relaxed">{parsed.description}</p>
          </div>
          <div className="sm:col-span-2">
            <p className="text-[10px] uppercase tracking-widest text-ink/40 mb-1">Trigger</p>
            <p className="text-sm text-ink/75 leading-relaxed">{parsed.trigger}</p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-widest text-ink/40 mb-1">
              Inputs ({parsed.inputs.length})
            </p>
            {parsed.inputs.length > 0 ? (
              <ul className="space-y-1">
                {parsed.inputs.map((inp) => (
                  <li key={inp.name} className="text-xs text-ink/65 font-mono">
                    <span className="text-ink">{inp.name}</span>
                    <span className="text-ink/40">
                      {" "}({inp.type}{inp.required ? ", required" : ""})
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-ink/40 italic">none parsed</p>
            )}
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-widest text-ink/40 mb-1">
              Outputs ({parsed.outputs.length})
            </p>
            {parsed.outputs.length > 0 ? (
              <ul className="space-y-1">
                {parsed.outputs.map((out) => (
                  <li key={out.name} className="text-xs text-ink/65 font-mono">
                    <span className="text-ink">{out.name}</span>
                    <span className="text-ink/40"> ({out.type})</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-ink/40 italic">none parsed</p>
            )}
          </div>
        </div>

        {/* Warnings */}
        {parseWarnings.length > 0 && (
          <div className="border-t border-sand pt-3">
            <button
              type="button"
              onClick={() => setShowWarnings((v) => !v)}
              className="flex items-center gap-2 text-xs text-status-wait/80 hover:text-status-wait transition-colors"
            >
              <AlertCircle className="w-3.5 h-3.5" />
              {parseWarnings.length} warning{parseWarnings.length > 1 ? "s" : ""}
              {showWarnings ? (
                <ChevronUp className="w-3 h-3" />
              ) : (
                <ChevronDown className="w-3 h-3" />
              )}
            </button>
            <AnimatePresence>
              {showWarnings && (
                <motion.ul
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  className="mt-2 space-y-1 overflow-hidden"
                >
                  {parseWarnings.map((w, i) => (
                    <li key={i} className="text-xs text-ink/55 leading-relaxed pl-5">
                      {w}
                    </li>
                  ))}
                </motion.ul>
              )}
            </AnimatePresence>
          </div>
        )}
      </div>

      {/* Agent ID */}
      <div>
        <label className="text-xs tracking-[2px] uppercase text-ink/50 block mb-2" htmlFor="agent-id">
          Agent ID <span className="text-status-down">*</span>
        </label>
        <input
          id="agent-id"
          type="text"
          value={agentId}
          onChange={(e) => {
            setAgentId(e.target.value.toLowerCase());
            setAgentIdError("");
          }}
          className={cn(
            "w-full bg-paper border rounded-xl px-4 py-3 text-sm font-mono text-ink",
            "focus:outline-none focus:ring-2 transition-shadow",
            agentIdError
              ? "border-status-down focus:ring-status-down/20"
              : "border-sand focus:ring-ink/20"
          )}
          placeholder="my-agent-id"
          maxLength={64}
          spellCheck={false}
        />
        {agentIdError ? (
          <p className="mt-1.5 text-xs text-status-down">{agentIdError}</p>
        ) : (
          <p className="mt-1.5 text-xs text-ink/40">
            Permanent — payouts key on it. Already taken:{" "}
            {listing?.agents.map((a) => a.id).join(", ") || "none"}.
          </p>
        )}
      </div>

      {/* Price per call */}
      <div>
        <label className="text-xs tracking-[2px] uppercase text-ink/50 block mb-2" htmlFor="agent-price">
          Price per call (ALGO) <span className="text-status-down">*</span>
        </label>
        <input
          id="agent-price"
          type="text"
          value={price}
          onChange={(e) => {
            setPrice(e.target.value);
            setPriceError("");
          }}
          onBlur={() => {
            const pp = priceProblem(price);
            if (pp) setPriceError(pp);
          }}
          className={cn(
            "w-full bg-paper border rounded-xl px-4 py-3 text-sm font-mono text-ink",
            "focus:outline-none focus:ring-2 transition-shadow",
            priceError
              ? "border-status-down focus:ring-status-down/20"
              : "border-sand focus:ring-ink/20"
          )}
          placeholder="0.05"
        />
        {priceError ? (
          <p className="mt-1.5 text-xs text-status-down">{priceError}</p>
        ) : (
          <p className="mt-1.5 text-xs text-ink/40">
            Plain decimal in ALGO, at most 6 places. Floor: 0.020000 ALGO.
          </p>
        )}
      </div>

      {/* Payout address — locked from wallet */}
      <div>
        <label className="text-xs tracking-[2px] uppercase text-ink/50 block mb-2">
          Payout address
        </label>
        <div className="flex items-center gap-2 bg-ink/[0.03] border border-sand rounded-xl px-4 py-3">
          <Lock className="w-3.5 h-3.5 text-ink/35 shrink-0" />
          <span className="flex-1 font-mono text-sm text-ink/70 truncate select-all">
            {wallet.address}
          </span>
          <span className="text-[10px] bg-status-live/10 text-status-live border border-status-live/20 rounded-md px-1.5 py-0.5 shrink-0">
            from wallet
          </span>
        </div>
        <p className="mt-1.5 text-xs text-ink/40">
          80% of every call lands here. Taken from your connected wallet — not editable.
        </p>
      </div>

      {/* Email (optional) */}
      <div>
        <label className="text-xs tracking-[2px] uppercase text-ink/50 block mb-2" htmlFor="agent-email">
          Email (optional)
        </label>
        <input
          id="agent-email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full bg-paper border border-sand rounded-xl px-4 py-3 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-ink/20 transition-shadow"
          placeholder="you@example.com"
        />
        <p className="mt-1.5 text-xs text-ink/40">Only used to reach you about this listing.</p>
      </div>

      {/* Submit error */}
      {submitError && (
        <p
          role="alert"
          className="text-sm text-status-down bg-status-down/[0.08] border border-status-down/25 rounded-xl px-4 py-3"
        >
          {submitError}
        </p>
      )}

      {/* Submit */}
      <button
        type="submit"
        disabled={submitting}
        className="inline-flex items-center gap-2 bg-ink text-paper text-sm font-medium uppercase tracking-wide rounded-full px-7 py-3.5 hover:bg-ink-strong disabled:opacity-60 disabled:pointer-events-none transition-colors"
      >
        {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
        {submitting ? "Publishing…" : "Publish agent"}
      </button>
    </motion.form>
  );

  return (
    <div className="space-y-4">
      {dropZone}
      {errorPanel}
      {form}
    </div>
  );
}
