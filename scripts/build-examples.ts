import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Analysis, ProgressEvent } from "../src/core/index.js";
import { buildOutputs } from "../src/generators/index.js";

/**
 * Turns the recorded example runs (examples/recordings/<slug>/analysis.json +
 * events.jsonl) into static bundles the web UI serves for free:
 * web/public/examples/<slug>.json = { analysis, events, slug, files, postmanErrors }.
 * No model calls; the output files are regenerated with the current generators.
 *
 * Usage: npm run build:examples
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const recordings = path.join(root, "examples", "recordings");
const outDir = path.join(root, "web", "public", "examples");

await mkdir(outDir, { recursive: true });
for (const slug of (await readdir(recordings)).sort()) {
  const dir = path.join(recordings, slug);
  const analysis = JSON.parse(await readFile(path.join(dir, "analysis.json"), "utf8")) as Analysis;
  const events = (await readFile(path.join(dir, "events.jsonl"), "utf8"))
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as ProgressEvent);
  const { slug: apiSlug, files, postmanValidation } = buildOutputs(analysis);
  const bundle = { analysis, events, slug: apiSlug, files, postmanErrors: postmanValidation.errors };
  await writeFile(path.join(outDir, `${slug}.json`), JSON.stringify(bundle) + "\n");
  console.log(`${slug}: ${events.length} events, ${Object.keys(files).length} files`);
}
