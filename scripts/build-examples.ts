import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyCodeRulesToAnalysis, type Analysis, type ProgressEvent } from "../src/core/index.js";
import { exampleOutputs, prepareRecording } from "./examples-lib.js";

/**
 * Regenerates every saved example offline (no model calls) with the current
 * code rules and generators:
 * - web/public/examples/<name>.json from examples/recordings/<name>/
 *   (analysis.json + events.jsonl): { analysis, events, slug, files, postmanErrors }
 * - examples/ipinfo/ (the README example) from examples/ipinfo/analysis.json
 *
 * Usage: npm run build:examples
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = async <T>(file: string) => JSON.parse(await readFile(file, "utf8")) as T;

// 1. Web examples.
const recordings = path.join(root, "examples", "recordings");
const webDir = path.join(root, "web", "public", "examples");
await mkdir(webDir, { recursive: true });
for (const name of (await readdir(recordings)).sort()) {
  const dir = path.join(recordings, name);
  const recordedEvents = (await readFile(path.join(dir, "events.jsonl"), "utf8"))
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as ProgressEvent);
  const { analysis, events } = prepareRecording(await readJson<Analysis>(path.join(dir, "analysis.json")), recordedEvents);
  const { slug, files, postmanValidation } = exampleOutputs(analysis, name);
  await writeFile(path.join(webDir, `${name}.json`), JSON.stringify({ analysis, events, slug, files, postmanErrors: postmanValidation.errors }) + "\n");
  console.log(`web/${name}: ${events.length} events, ${Object.keys(files).length} files`);
}

// 2. The README example. Its analysis.json is kept up to date with the rules too.
const ipinfoDir = path.join(root, "examples", "ipinfo");
const { analysis: ipinfo, notices } = applyCodeRulesToAnalysis(await readJson<Analysis>(path.join(ipinfoDir, "analysis.json")));
const { files } = exampleOutputs(ipinfo, "ipinfo-readme");
for (const name of ["analysis.json", "analysis.md", "postman_collection.json", "postman_environment.json", "sequence.mmd"]) {
  await writeFile(path.join(ipinfoDir, name), files[name]!);
}
console.log(`examples/ipinfo: ${Object.keys(files).length} files${notices.length ? `; ${notices.map((n) => n.event.detail).join("; ")}` : ""}`);
