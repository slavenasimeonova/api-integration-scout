import type { Analysis } from "./types";

/**
 * The one source for run numbers shown in the UI. The timeline's meters show
 * live values while a run is going, then switch to these once it has finished,
 * so the meters and the results header always agree.
 */
export type RunFigures = {
  pagesRead: number;
  /** Wall clock from the start of the run to the verified result. */
  durationMs: number;
  /** Input + cache-write + output tokens: what the token budget counts. */
  budgetedTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  costUsd: number;
};

export function runFigures(a: Analysis): RunFigures {
  const r = a.run;
  return {
    pagesRead: a.pagesVisited.filter((p) => p.status === "fetched").length,
    durationMs: Math.max(0, Date.parse(a.generatedAt) - Date.parse(r.startedAt)),
    budgetedTokens: r.inputTokens + r.cacheCreationInputTokens + r.outputTokens,
    cacheReadTokens: r.cacheReadInputTokens,
    totalTokens: r.totalTokens,
    costUsd: r.costUsd,
  };
}

export const formatSeconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
export const formatTokens = (n: number) => n.toLocaleString("en-US");
export const formatUsd = (n: number) => `$${n.toFixed(4)}`;
