// Public API of the agent core, shared by the CLI and the future web app.
export { runScout, ScoutError, type AgentRunner, type RunScoutOptions, type ScoutFailureReason } from "./scout.js";
export { loadConfig, DEFAULT_CONFIG, type ScoutConfig } from "./config.js";
export type { ProgressEvent, ProgressStep, OnEvent, AgentStep } from "./events.js";
export type { Fetcher, FetchResponse } from "./fetcher.js";
export type * from "./schema.js";
export type { AnalysisEndpoint, HostCheck } from "./hosts.js";
export { normalizeAuth, authRank, credentialParamKeys, primaryChangeDetail, type AuthNormalization } from "./auth.js";
export { applyCodeRules, applyCodeRulesToAnalysis, type RuleNotice } from "./rules.js";
export type { PendingEvent } from "./events.js";
