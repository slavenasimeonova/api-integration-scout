import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { applyCodeRulesToAnalysis, type Analysis, type ProgressEvent } from "../src/core/index.js";
import { exampleOutputs, prepareRecording } from "../scripts/examples-lib.js";

/**
 * Committed examples must match what the current pipeline produces from their
 * saved model output. A regeneration that skipped a code rule (the host check)
 * once sent IPinfo's /{ip}/json to api.ipinfo.io and Newman got a 404.
 * If this fails after an intended change: npm run build:examples.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Git may check files out with CRLF on Windows.
const read = (...p: string[]) => readFileSync(path.join(root, ...p), "utf8").replace(/\r\n/g, "\n");

describe("committed examples are up to date", () => {
  it("examples/ipinfo matches the pipeline output", () => {
    const { analysis } = applyCodeRulesToAnalysis(JSON.parse(read("examples", "ipinfo", "analysis.json")) as Analysis);
    const { files } = exampleOutputs(analysis, "ipinfo-readme");
    for (const name of ["analysis.json", "analysis.md", "postman_collection.json", "postman_environment.json", "sequence.mmd"]) {
      expect(read("examples", "ipinfo", name), name).toBe(files[name]);
    }
  });

  it.each(readdirSync(path.join(root, "examples", "recordings")))("web example %s matches the pipeline output", (name) => {
    const recordedEvents = read("examples", "recordings", name, "events.jsonl")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as ProgressEvent);
    const recorded = JSON.parse(read("examples", "recordings", name, "analysis.json")) as Analysis;
    const { analysis, events } = prepareRecording(recorded, recordedEvents);
    const { slug, files, postmanValidation } = exampleOutputs(analysis, name);
    expect(JSON.parse(read("web", "public", "examples", `${name}.json`))).toEqual({ analysis, events, slug, files, postmanErrors: postmanValidation.errors });
  });

  it("sends IPinfo's legacy /{ip}/json request to ipinfo.io, as its verified quote shows", () => {
    const collection = JSON.parse(read("examples", "ipinfo", "postman_collection.json")) as {
      item: { item: { name: string; request: { url: { raw: string } } }[] }[];
    };
    const legacy = collection.item.flatMap((f) => f.item).find((i) => i.name.includes("/json"))!;
    expect(legacy.request.url.raw).toBe("https://ipinfo.io/:ip/json");
  });
});
