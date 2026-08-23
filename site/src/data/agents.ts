/**
 * The marketplace catalogue.
 *
 * This file is product copy and contract, not runtime state: it describes what
 * each agent accepts, returns and charges. It deliberately holds no
 * availability field — whether an agent is up right now is answered by a live
 * health check (see hooks/use-agent-health.ts), because a status baked in here
 * would keep reading "online" for an agent that had been down for a week.
 */

import iconForm from "@/assets/agent-form.svg";
import iconLinkedIn from "@/assets/agent-linkedin.svg";
import iconMail from "@/assets/agent-mail.svg";
import iconSearch from "@/assets/agent-search.svg";

export type AgentId =
  | "form-filler"
  | "linkedin-apply"
  | "mail-automation"
  | "web-search";

export interface SchemaField {
  name: string;
  type: string;
  required: boolean;
  note: string;
}

export interface FailureMode {
  /** The structured code the agent returns. Never a thrown string. */
  code: string;
  /** The real-world condition that produces it. */
  when: string;
}

export interface Pricing {
  /**
   * Flat component covering work that costs money but consumes no tokens — a
   * Playwright session, an outbound API call, a page fetch.
   */
  baseUsd: number;
  /** Metered component, applied to tokens the request actually consumed. */
  perMillionInputUsd: number;
  perMillionOutputUsd: number;
}

export interface Agent {
  id: AgentId;
  name: string;
  /** Accent word rendered in serif italic in the card heading. */
  accent: string;
  icon: string;
  tagline: string;
  description: string;
  /** Runtime the agent actually executes on — shown so buyers can judge risk. */
  runtime: string;
  capabilities: string[];
  input: SchemaField[];
  output: SchemaField[];
  failures: FailureMode[];
  /** Secrets the caller supplies per session. Never stored by the marketplace. */
  credentials: string;
  pricing: Pricing;
}

export const AGENTS: Agent[] = [
  {
    id: "form-filler",
    name: "Form Filler",
    accent: "Filler",
    icon: iconForm,
    tagline: "Fills any web form from a structured profile.",
    description:
      "Opens the target URL in a real browser, reads the form from the DOM rather than a stored template, maps your profile onto the fields it finds, and hands back a screenshot of the filled state before anything is submitted.",
    runtime: "Playwright · headless Chromium",
    capabilities: [
      "Label, name and placeholder heuristics over live DOM",
      "Multi-step wizards, selects and file-upload fields",
      "CAPTCHA detected and handed back, never solved",
      "Review-before-submit by default",
    ],
    input: [
      { name: "url", type: "string", required: true, note: "Page holding the form" },
      { name: "profile", type: "object", required: true, note: "Field values to map" },
      { name: "attachments", type: "file[]", required: false, note: "Resume, cover letter" },
      { name: "mode", type: "review | submit", required: false, note: "Defaults to review" },
    ],
    output: [
      { name: "status", type: "filled | submitted | error", required: true, note: "" },
      { name: "fieldsFilled", type: "Array<FieldResult>", required: true, note: "Every field touched" },
      { name: "screenshot", type: "string (png, base64)", required: true, note: "Proof of end state" },
      { name: "confirmationId", type: "string | null", required: false, note: "Only if the site returns one" },
    ],
    failures: [
      { code: "human_intervention_required", when: "A CAPTCHA or 2FA challenge is on the page" },
      { code: "field_unmapped", when: "A required field has no match in the supplied profile" },
      { code: "navigation_timeout", when: "The target never reached a settled state" },
      { code: "selector_drift", when: "The form changed shape mid-run" },
    ],
    credentials: "None, unless the target page sits behind a login you supply",
    pricing: { baseUsd: 0.02, perMillionInputUsd: 3.0, perMillionOutputUsd: 15.0 },
  },
  {
    id: "linkedin-apply",
    name: "LinkedIn Apply",
    accent: "Apply",
    icon: iconLinkedIn,
    tagline: "Matches your resume against openings and applies.",
    description:
      "Searches roles against your criteria, scores each opening against your parsed resume, and walks the Easy Apply flow. Screening questions it cannot answer from your resume are handed back for you to answer — it will not invent one.",
    runtime: "Playwright · your authenticated session",
    capabilities: [
      "Match score computed from your parsed resume",
      "Easy Apply multi-step flow, including employer questions",
      "Unanswerable screening questions returned, never guessed",
      "Per-job application receipt",
    ],
    input: [
      { name: "resume", type: "object", required: true, note: "Skills, experience, education" },
      { name: "criteria", type: "object", required: true, note: "Role, location, filters" },
      { name: "maxApplications", type: "number", required: false, note: "Hard ceiling per run" },
      { name: "session", type: "string", required: true, note: "Supplied per run, never stored" },
    ],
    output: [
      { name: "jobs", type: "Array<JobMatch>", required: true, note: "With match score" },
      { name: "applied", type: "Array<Application>", required: true, note: "Confirmed submissions" },
      { name: "needsInput", type: "Array<OpenQuestion>", required: true, note: "Handed back to you" },
    ],
    failures: [
      { code: "auth_expired", when: "The supplied session is no longer valid" },
      { code: "rate_limited", when: "LinkedIn throttled the account" },
      { code: "checkpoint_challenge", when: "An identity checkpoint was raised" },
      { code: "not_easy_apply", when: "The posting sends applicants off-site" },
    ],
    credentials: "LinkedIn session — read the automation constraint before enabling",
    pricing: { baseUsd: 0.05, perMillionInputUsd: 3.0, perMillionOutputUsd: 15.0 },
  },
  {
    id: "mail-automation",
    name: "Mail Automation",
    accent: "Automation",
    icon: iconMail,
    tagline: "Sends, drafts and follows up from your own mailbox.",
    description:
      "Talks to the Gmail or Microsoft Graph API with tokens you grant over OAuth — no SMTP credential handling, no password anywhere. Composes, sends, replies in thread and schedules follow-ups, and surfaces bounces rather than swallowing them.",
    runtime: "Gmail API · Microsoft Graph",
    capabilities: [
      "Send, draft, reply-in-thread and scheduled follow-up",
      "OAuth token refresh handled in flight",
      "Provider rate limits surfaced with retry timing",
      "Bounce and rejection responses returned verbatim",
    ],
    input: [
      { name: "task", type: "send | draft | reply | sequence", required: true, note: "" },
      { name: "to", type: "string[]", required: true, note: "Recipients" },
      { name: "context", type: "string | object", required: true, note: "Template or brief" },
      { name: "oauth", type: "object", required: true, note: "Token you granted, per session" },
    ],
    output: [
      { name: "messageId", type: "string", required: true, note: "The provider's own id" },
      { name: "deliveryStatus", type: "sent | drafted | scheduled", required: true, note: "" },
      { name: "threadUrl", type: "string", required: true, note: "Deep link into your mailbox" },
    ],
    failures: [
      { code: "oauth_refresh_failed", when: "The refresh token was revoked or expired" },
      { code: "quota_exceeded", when: "The provider's send quota is spent" },
      { code: "recipient_rejected", when: "The receiving server bounced the message" },
      { code: "scope_insufficient", when: "The grant is missing a required scope" },
    ],
    credentials: "Google OAuth client, or a Microsoft Entra app registration",
    pricing: { baseUsd: 0.005, perMillionInputUsd: 3.0, perMillionOutputUsd: 15.0 },
  },
  {
    id: "web-search",
    name: "Web Search",
    accent: "Search",
    icon: iconSearch,
    tagline: "Real results with the page content attached.",
    description:
      "Queries a licensed search API, then fetches and extracts the readable body of each result. Dead links, paywalls and empty result sets come back marked as exactly that — the result count is whatever was really there.",
    runtime: "Licensed search API · readability extraction",
    capabilities: [
      "Recency, domain and result-count constraints",
      "Full text extraction for the results you expand",
      "Paywalled and dead results labelled, not dropped",
      "Empty result sets returned empty",
    ],
    input: [
      { name: "query", type: "string", required: true, note: "" },
      { name: "count", type: "number", required: false, note: "Defaults to 10" },
      { name: "recency", type: "day | week | month | year", required: false, note: "" },
      { name: "extract", type: "boolean", required: false, note: "Fetch page bodies" },
    ],
    output: [
      { name: "results", type: "Array<SearchResult>", required: true, note: "" },
      { name: "unreachable", type: "Array<DeadResult>", required: true, note: "Dead or paywalled" },
      { name: "totalFound", type: "number", required: true, note: "Real count, never padded" },
    ],
    failures: [
      { code: "no_results", when: "The query genuinely matched nothing" },
      { code: "upstream_quota", when: "The search API key is out of quota" },
      { code: "fetch_blocked", when: "A result refused the extraction fetch" },
      { code: "paywalled", when: "The body sits behind a paywall" },
    ],
    credentials: "A search API key — Brave, Tavily, Exa or SerpAPI",
    pricing: { baseUsd: 0.004, perMillionInputUsd: 3.0, perMillionOutputUsd: 15.0 },
  },
];

/**
 * What a request costs, given the tokens it actually consumed. The marketplace
 * quotes this alongside the result so the on-chain receipt and the work behind
 * it can be reconciled line by line.
 */
export function quote(
  pricing: Pricing,
  inputTokens: number,
  outputTokens: number,
): number {
  return (
    pricing.baseUsd +
    (inputTokens / 1_000_000) * pricing.perMillionInputUsd +
    (outputTokens / 1_000_000) * pricing.perMillionOutputUsd
  );
}

/** A representative call, used to show a worked price on each listing. */
export const SAMPLE_CALL = { inputTokens: 2_400, outputTokens: 800 } as const;
