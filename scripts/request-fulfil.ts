import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { isRequestId, requestKey, updateRequest, type ScoutRequest } from "../src/access/index.js";
import { loadConfig, runScout, ScoutError, type ProgressEvent, type RunStats } from "../src/core/index.js";
import { checkUrl, createSafeFetcher } from "../worker/safe-fetch.js";
import { confirm, describeRequest, openRequestStore, resultBundle, resultLink } from "./requests-lib.js";

/**
 * Reviews one request: shows it, asks before running (a paid Claude API call),
 * runs it with the SSRF-safe fetcher, saves web/public/results/<id>.json, asks
 * before publishing (git commit + push), then marks the request done.
 * Running it again after a declined publish skips the run and publishes.
 *
 * Usage:
 *   npm run request:fulfil -- <id> [--max-pages 5]
 *   npm run request:fulfil -- <id> --decline [--note "Reason shown to the visitor"]
 */

const USAGE = `Usage: npm run request:fulfil -- <id> [--max-pages 5]
       npm run request:fulfil -- <id> --decline [--note "reason shown to the visitor"]`;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

function printEvent(event: ProgressEvent) {
  if (event.step === "usage_update") return;
  console.log(`${new Date(event.at).toLocaleTimeString("en-GB")} [${event.step}] ${event.detail}`);
}

const money = (run: RunStats) => `$${run.costUsd.toFixed(4)}, ${(run.durationMs / 1000).toFixed(1)}s`;

async function logRun(entry: Record<string, unknown>) {
  const dir = path.join(root, "outputs");
  await mkdir(dir, { recursive: true });
  await appendFile(path.join(dir, "runs.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      "max-pages": { type: "string", default: "5" },
      decline: { type: "boolean", default: false },
      note: { type: "string" },
    },
  });
  const id = positionals[0];
  if (!id || positionals.length > 1 || !isRequestId(id)) {
    console.error(USAGE);
    return 1;
  }
  const maxPages = Number(values["max-pages"]);
  if (!Number.isInteger(maxPages) || maxPages < 1) throw new Error("--max-pages must be a positive whole number");

  const store = openRequestStore();
  const request = await store.getJSON<ScoutRequest>(requestKey(id));
  if (!request) throw new Error(`No request with id ${id}. List them with: npm.cmd run request:list`);
  console.log(`${describeRequest(request)}\n`);

  if (values.decline) {
    if (!(await confirm("Decline this request?"))) return 0;
    await updateRequest(store, id, { status: "declined", note: values.note });
    console.log(`Declined. The visitor sees this at ${resultLink(id)}`);
    return 0;
  }
  if (request.status !== "pending" && !(await confirm(`This request is already ${request.status}. Continue anyway?`))) return 0;

  const resultFile = path.join(root, "web", "public", "results", `${id}.json`);
  const relative = path.relative(root, resultFile).split(path.sep).join("/");

  if (existsSync(resultFile)) {
    console.log(`A saved result already exists (${relative}); skipping the run.`);
  } else {
    try {
      await checkUrl(request.url);
    } catch (err) {
      console.error(`The URL fails the safety check: ${err instanceof Error ? err.message : String(err)}`);
      console.error(`Decline it with: npm.cmd run request:fulfil -- ${id} --decline --note "..."`);
      return 1;
    }
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set in .env.");
    const config = loadConfig(process.env, { maxPages });
    const ok = await confirm(
      `Run it? This is a paid Claude API call (max ${config.maxPages} pages, budget $${config.maxBudgetUsd}; recent 5-page runs cost about $0.11 to $0.13).`,
    );
    if (!ok) return 0;

    const events: ProgressEvent[] = [];
    const controller = new AbortController();
    process.once("SIGINT", () => controller.abort());
    try {
      const analysis = await runScout(request.url, {
        config,
        goal: request.goal,
        fetcher: createSafeFetcher({ timeoutMs: config.fetchTimeoutMs }),
        signal: controller.signal,
        onEvent: (e) => {
          events.push(e);
          printEvent(e);
        },
      });
      await mkdir(path.dirname(resultFile), { recursive: true });
      await writeFile(resultFile, JSON.stringify(resultBundle(analysis, events)) + "\n");
      await logRun({ url: request.url, ...(request.goal ? { goal: request.goal } : {}), status: "success", requestId: id, codeName: request.codeName, ...analysis.run });
      console.log(`\nDone: ${money(analysis.run)}. Saved ${relative}`);
    } catch (err) {
      if (err instanceof ScoutError) {
        await logRun({ url: request.url, ...(request.goal ? { goal: request.goal } : {}), status: "failed", reason: err.reason, requestId: id, codeName: request.codeName, ...err.run });
        console.error(`\nRun failed (${err.reason}): ${err.message}${err.run ? ` (${money(err.run)})` : ""}`);
        console.error("The request stays pending. Retry, or decline it with --decline.");
        return 1;
      }
      throw err;
    }
  }

  // Publish: commit only the result file and push; GitHub Pages redeploys it.
  JSON.parse(await readFile(resultFile, "utf8")); // never publish a broken file
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  if (branch !== "main") {
    console.error(`You're on branch "${branch}"; switch to main, then run this command again to publish.`);
    return 1;
  }
  if (!(await confirm(`Publish now? Commits ${relative} and pushes to origin main.`))) {
    console.log(`Not published. Run npm.cmd run request:fulfil -- ${id} again to publish.`);
    return 0;
  }
  git("add", "--", relative);
  if (git("diff", "--cached", "--name-only", "--", relative)) git("commit", "-m", `Publish result for request ${id}`, "--", relative);
  git("push", "origin", "main");
  await updateRequest(store, id, { status: "done" });
  console.log(`\nPublished. GitHub Pages redeploys in about 2 minutes.\nThe visitor's link: ${resultLink(id)}`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
