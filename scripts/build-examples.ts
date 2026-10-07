import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeAuth, primaryChangeDetail, type Analysis, type ProgressEvent } from "../src/core/index.js";
import { buildOutputs } from "../src/generators/index.js";

/**
 * Turns the recorded example runs (examples/recordings/<slug>/analysis.json +
 * events.jsonl) into static bundles the web UI serves for free:
 * web/public/examples/<slug>.json = { analysis, events, slug, files, postmanErrors }.
 *
 * No model calls. The model's findings stay exactly as recorded; the
 * deterministic post-processing added since the recording is re-applied, as a
 * run with the current code would:
 * - auth rules (src/core/auth.ts): primary method ranking and credential params,
 *   with the same warning and auth_primary_changed event runScout emits
 * - page numbers in completion order (page_fetched events are recorded in that order)
 * - output files rebuilt with the current generators
 *
 * Usage: npm run build:examples
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const recordings = path.join(root, "examples", "recordings");
const outDir = path.join(root, "web", "public", "examples");

function renumberPages(events: ProgressEvent[]): ProgressEvent[] {
  let n = 0;
  return events.map((e) => {
    if (e.step !== "page_fetched") return e;
    const pageCount = ++n;
    return { ...e, pageCount, detail: e.detail.replace(/\(\d+\/(\d+)\)$/, `(${pageCount}/$1)`) };
  });
}

function applyAuthRules(analysis: Analysis, events: ProgressEvent[]): { analysis: Analysis; events: ProgressEvent[] } {
  const normalized = normalizeAuth(analysis);
  const next: Analysis = {
    ...analysis,
    auth: normalized.auth,
    authAlternatives: normalized.authAlternatives,
    endpoints: normalized.endpoints,
  };
  if (!normalized.primaryChange || analysis.warnings.some((w) => w.startsWith("Primary auth set to"))) {
    return { analysis: next, events };
  }
  const detail = primaryChangeDetail(normalized.primaryChange);
  next.warnings = [...analysis.warnings, detail];
  // runScout emits it after verification, just before run_completed.
  const done = events.findIndex((e) => e.step === "run_completed");
  const at = events[done]?.at ?? events.at(-1)!.at;
  const event: ProgressEvent = { step: "auth_primary_changed", detail, ...normalized.primaryChange, at };
  const withEvent = done >= 0 ? [...events.slice(0, done), event, ...events.slice(done)] : [...events, event];
  return { analysis: next, events: withEvent };
}

await mkdir(outDir, { recursive: true });
for (const name of (await readdir(recordings)).sort()) {
  const dir = path.join(recordings, name);
  const recorded = JSON.parse(await readFile(path.join(dir, "analysis.json"), "utf8")) as Analysis;
  const recordedEvents = (await readFile(path.join(dir, "events.jsonl"), "utf8"))
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as ProgressEvent);

  const { analysis, events } = applyAuthRules(recorded, renumberPages(recordedEvents));
  const { slug, files, postmanValidation } = buildOutputs(analysis);
  const bundle = { analysis, events, slug, files, postmanErrors: postmanValidation.errors };
  await writeFile(path.join(outDir, `${name}.json`), JSON.stringify(bundle) + "\n");
  const change = events.find((e) => e.step === "auth_primary_changed");
  console.log(`${name}: ${events.length} events, ${Object.keys(files).length} files${change ? `; ${change.detail}` : ""}`);
}
