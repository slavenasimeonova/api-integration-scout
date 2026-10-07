import type { ProgressStep } from "./types";

export type Tone = "neutral" | "page" | "found" | "missing" | "warn" | "error" | "done";

/** How each progress event appears in the timeline. */
export const STEP_META: Record<ProgressStep, { label: string; tone: Tone }> = {
  run_started: { label: "start", tone: "neutral" },
  page_fetched: { label: "page", tone: "page" },
  page_skipped: { label: "skip", tone: "missing" },
  low_text_warning: { label: "js page?", tone: "warn" },
  page_truncated: { label: "truncated", tone: "warn" },
  base_url_found: { label: "base url", tone: "found" },
  auth_found: { label: "auth", tone: "found" },
  endpoint_found: { label: "endpoint", tone: "found" },
  pagination_found: { label: "pagination", tone: "found" },
  rate_limit_found: { label: "rate limit", tone: "found" },
  webhooks_found: { label: "webhooks", tone: "found" },
  error_format_found: { label: "errors", tone: "found" },
  versioning_found: { label: "versioning", tone: "found" },
  not_found: { label: "not found", tone: "missing" },
  risk_found: { label: "risk", tone: "warn" },
  note: { label: "note", tone: "neutral" },
  usage_update: { label: "tokens", tone: "neutral" },
  budget_exceeded: { label: "budget", tone: "error" },
  verification_downgrade: { label: "unverified", tone: "warn" },
  endpoint_host_corrected: { label: "host fixed", tone: "warn" },
  endpoint_host_ambiguous: { label: "host?", tone: "warn" },
  auth_primary_changed: { label: "auth rule", tone: "neutral" },
  run_completed: { label: "done", tone: "done" },
  run_failed: { label: "failed", tone: "error" },
};

/** Token updates drive the meter instead of cluttering the timeline. */
export const HIDDEN_STEPS = new Set<ProgressStep>(["usage_update"]);
