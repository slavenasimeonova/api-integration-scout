/**
 * Progress events emitted by the agent core through the onEvent callback.
 * Every event has a `step` discriminator and a human-readable `detail`, so a
 * UI can render any event generically and special-case the ones it cares about.
 */

/** Steps the agent itself reports via the report_progress tool. */
export const AGENT_STEPS = [
  "base_url_found",
  "auth_found",
  "endpoint_found",
  "pagination_found",
  "rate_limit_found",
  "webhooks_found",
  "error_format_found",
  "versioning_found",
  "not_found",
  "risk_found",
  "note",
] as const;
export type AgentStep = (typeof AGENT_STEPS)[number];

type Base<S extends string> = { step: S; detail: string; at: string };

export type ProgressEvent =
  | (Base<"run_started"> & { url: string; model: string })
  | (Base<"page_fetched"> & { url: string; pageCount: number; maxPages: number; textLength: number })
  | (Base<"page_skipped"> & { url: string; reason: "off_domain" | "page_limit" | "already_fetched" | "fetch_error" })
  | (Base<"low_text_warning"> & { url: string; textLength: number })
  | Base<AgentStep>
  | (Base<"usage_update"> & { totalTokens: number; maxTokens: number })
  | (Base<"budget_exceeded"> & { totalTokens: number; maxTokens: number })
  | (Base<"verification_downgrade"> & { field: string })
  | (Base<"run_completed"> & { totalTokens: number; costUsd: number })
  | Base<"run_failed">;

export type ProgressStep = ProgressEvent["step"];

export type OnEvent = (event: ProgressEvent) => void;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** Builds an emitter that stamps each event and never lets a listener crash the run. */
export function createEmitter(onEvent: OnEvent | undefined) {
  return (event: DistributiveOmit<ProgressEvent, "at">): void => {
    if (!onEvent) return;
    try {
      onEvent({ ...event, at: new Date().toISOString() } as ProgressEvent);
    } catch {
      // A broken listener (e.g. a closed UI stream) must not abort the analysis.
    }
  };
}
