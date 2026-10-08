import { createHash } from "node:crypto";
import { applyCodeRulesToAnalysis, type Analysis, type ProgressEvent } from "../src/core/index.js";
import { buildOutputs, type OutputFiles } from "../src/generators/index.js";

/**
 * The offline pipeline for saved examples (no model calls). It applies the
 * same code rules as runScout (core/rules.ts), so a saved example always
 * matches what a run with the current code would produce from the same
 * model output. The drift test (tests/examples.test.ts) uses it too.
 */

/** Deterministic UUID-shaped id, so regenerated files only change when their content does. */
export function stableId(seed: string): string {
  const h = createHash("sha256").update(seed).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export function exampleOutputs(analysis: Analysis, name: string): OutputFiles {
  return buildOutputs(analysis, { collection: stableId(`${name}:collection`), environment: stableId(`${name}:environment`) });
}

/** Page numbers in completion order (page_fetched events are recorded in that order). */
function renumberPages(events: ProgressEvent[]): ProgressEvent[] {
  let n = 0;
  return events.map((e) => {
    if (e.step !== "page_fetched") return e;
    const pageCount = ++n;
    return { ...e, pageCount, detail: e.detail.replace(/\(\d+\/(\d+)\)$/, `(${pageCount}/$1)`) };
  });
}

/**
 * A recorded run (analysis + progress events) brought up to the current code:
 * code rules re-applied, and their events added just before run_completed,
 * where runScout emits them. The model's findings stay as recorded.
 */
export function prepareRecording(recorded: Analysis, recordedEvents: ProgressEvent[]): { analysis: Analysis; events: ProgressEvent[] } {
  const { analysis, notices } = applyCodeRulesToAnalysis(recorded);
  const events = renumberPages(recordedEvents);
  const already = new Set(events.map((e) => `${e.step}|${e.detail}`));
  const done = events.findIndex((e) => e.step === "run_completed");
  const at = events[done]?.at ?? events.at(-1)?.at ?? analysis.generatedAt;
  const added = notices
    .filter((n) => !already.has(`${n.event.step}|${n.event.detail}`))
    .map((n) => ({ ...n.event, at }) as ProgressEvent);
  const withAdded = done >= 0 ? [...events.slice(0, done), ...added, ...events.slice(done)] : [...events, ...added];
  return { analysis, events: withAdded };
}
