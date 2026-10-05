export type ScoutConfig = {
  model: string;
  maxPages: number;
  /** Total tokens (input + output + cache) before the run is stopped. */
  maxTokens: number;
  /** Hard USD cap enforced by the Agent SDK. */
  maxBudgetUsd: number;
  maxTurns: number;
  /** Pages with less extracted text than this are flagged as possibly JS-rendered. */
  minPageTextChars: number;
  fetchTimeoutMs: number;
};

export const DEFAULT_CONFIG: ScoutConfig = {
  model: "claude-sonnet-5-5",
  maxPages: 15,
  maxTokens: 150_000,
  maxBudgetUsd: 0.5,
  maxTurns: 40,
  minPageTextChars: 500,
  fetchTimeoutMs: 15_000,
};

type Env = Record<string, string | undefined>;

function positiveNumber(name: string, raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${name} must be a positive number, got "${raw}"`);
  }
  return n;
}

/** Reads SCOUT_* env vars, then applies explicit overrides (e.g. CLI flags). */
export function loadConfig(env: Env = process.env, overrides: Partial<ScoutConfig> = {}): ScoutConfig {
  const fromEnv: Partial<ScoutConfig> = {};
  if (env.SCOUT_MODEL?.trim()) fromEnv.model = env.SCOUT_MODEL.trim();
  const maxPages = positiveNumber("SCOUT_MAX_PAGES", env.SCOUT_MAX_PAGES);
  if (maxPages !== undefined) fromEnv.maxPages = Math.floor(maxPages);
  const maxTokens = positiveNumber("SCOUT_MAX_TOKENS", env.SCOUT_MAX_TOKENS);
  if (maxTokens !== undefined) fromEnv.maxTokens = Math.floor(maxTokens);
  const maxBudgetUsd = positiveNumber("SCOUT_MAX_BUDGET_USD", env.SCOUT_MAX_BUDGET_USD);
  if (maxBudgetUsd !== undefined) fromEnv.maxBudgetUsd = maxBudgetUsd;

  return { ...DEFAULT_CONFIG, ...fromEnv, ...overrides };
}
