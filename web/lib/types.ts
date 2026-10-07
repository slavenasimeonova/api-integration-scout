// Types come straight from the agent core and the worker (type-only imports,
// so nothing from ../src ends up in the browser bundle).
export type {
  Analysis,
  AnalysisEndpoint,
  Auth,
  Finding,
  FindingStatus,
  ProgressEvent,
  ProgressStep,
  Risk,
  Source,
} from "../../src/core/index.js";
export type { RunStreamLine } from "../../worker/server.js";
export type { LimitStatus } from "../../worker/limits.js";

import type { Analysis, ProgressEvent } from "../../src/core/index.js";

/** What the results view needs, from a live run or a precomputed example. */
export type RunResult = {
  analysis: Analysis;
  slug: string;
  files: Record<string, string>;
  postmanErrors: string[];
};

export type ExampleBundle = RunResult & { events: ProgressEvent[] };
