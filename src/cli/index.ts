import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadConfig, runScout, ScoutError, type ProgressEvent, type RunStats, type ScoutConfig } from "../core/index.js";
import { buildOutputs } from "../generators/index.js";

const USAGE = `Usage: npm run scout -- <docs-url> [options]

Options:
  --max-pages <n>   Pages to fetch (default 15, env SCOUT_MAX_PAGES)
  --model <id>      Model id (default claude-sonnet-5-5, env SCOUT_MODEL)
  --out <dir>       Output directory (default outputs)
  --json            Print progress events as JSON lines
  -h, --help        Show this help

Budgets: SCOUT_MAX_TOKENS (default 150000), SCOUT_MAX_BUDGET_USD (default 0.5)`;

function parseCli(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      "max-pages": { type: "string" },
      model: { type: "string" },
      out: { type: "string", default: "outputs" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const overrides: Partial<ScoutConfig> = {};
  if (values["max-pages"] !== undefined) {
    const n = Number(values["max-pages"]);
    if (!Number.isInteger(n) || n < 1) throw new Error(`--max-pages must be a positive integer`);
    overrides.maxPages = n;
  }
  if (values.model) overrides.model = values.model;
  return { url: positionals[0], help: values.help, outDir: values.out, json: values.json, overrides };
}

const MARKERS: Partial<Record<ProgressEvent["step"], string>> = {
  run_started: ">>",
  page_fetched: "[page]",
  page_skipped: "[skip]",
  low_text_warning: "[warn]",
  page_truncated: "[warn]",
  budget_exceeded: "[STOP]",
  verification_downgrade: "[check]",
  run_completed: "[done]",
  run_failed: "[fail]",
};

function createPrinter(json: boolean) {
  let lastUsageDecile = 0;
  return (event: ProgressEvent) => {
    if (json) {
      console.log(JSON.stringify(event));
      return;
    }
    if (event.step === "usage_update") {
      // Only print at each 10% of the token budget to keep the log readable.
      const decile = Math.floor((event.totalTokens / event.maxTokens) * 10);
      if (decile <= lastUsageDecile) return;
      lastUsageDecile = decile;
    }
    const time = new Date(event.at).toLocaleTimeString("en-GB");
    const marker = MARKERS[event.step] ?? (event.step === "usage_update" ? "[tokens]" : `[${event.step}]`);
    console.log(`${time} ${marker} ${event.detail}`);
  };
}

function formatUsage(run: RunStats): string {
  return [
    `Tokens: ${run.inputTokens.toLocaleString("en-US")} input, ${run.outputTokens.toLocaleString("en-US")} output,`,
    `${run.cacheCreationInputTokens.toLocaleString("en-US")} cache write, ${run.cacheReadInputTokens.toLocaleString("en-US")} cache read`,
    `| Cost: $${run.costUsd.toFixed(4)} | Turns: ${run.numTurns} | ${(run.durationMs / 1000).toFixed(1)}s`,
  ].join(" ");
}

/** One line per run (success or failure) so spend can be tracked across runs. */
async function logRun(outDir: string, entry: Record<string, unknown>): Promise<void> {
  await mkdir(outDir, { recursive: true });
  await appendFile(path.join(outDir, "runs.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
}

async function main(): Promise<number> {
  let cli;
  try {
    cli = parseCli(process.argv.slice(2));
  } catch (err) {
    console.error((err as Error).message + "\n\n" + USAGE);
    return 1;
  }
  if (cli.help || !cli.url) {
    console.log(USAGE);
    return cli.help ? 0 : 1;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is not set. Add it to the .env file in the project folder (see .env.example).");
    return 1;
  }

  let config: ScoutConfig;
  try {
    config = loadConfig(process.env, cli.overrides);
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  }

  const outRoot = path.resolve(cli.outDir);
  const controller = new AbortController();
  process.once("SIGINT", () => {
    console.error("\nCancelling...");
    controller.abort();
  });

  if (!cli.json) {
    console.log(
      `Model ${config.model} | max ${config.maxPages} pages | budget ${config.maxTokens.toLocaleString("en-US")} tokens / $${config.maxBudgetUsd}\n`,
    );
  }

  try {
    const analysis = await runScout(cli.url, { config, onEvent: createPrinter(cli.json), signal: controller.signal });
    const { slug, files, postmanValidation } = buildOutputs(analysis);
    const dir = path.join(outRoot, slug);
    await mkdir(dir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      await writeFile(path.join(dir, name), content, "utf8");
    }
    await logRun(outRoot, { url: cli.url, status: "success", slug, ...analysis.run });

    console.log(`\n${formatUsage(analysis.run)}`);
    console.log(`\nSaved to ${dir}`);
    for (const name of Object.keys(files).sort()) console.log(`  ${name}`);
    if (analysis.warnings.length) {
      console.log("\nWarnings:");
      for (const w of analysis.warnings) console.log(`  - ${w}`);
    }
    if (!postmanValidation.valid) {
      console.error("\npostman_collection.json was NOT saved: it failed Postman v2.1 schema validation:");
      for (const e of postmanValidation.errors) console.error(`  - ${e}`);
      return 2;
    }
    return 0;
  } catch (err) {
    if (err instanceof ScoutError) {
      console.error(`\nFailed (${err.reason}): ${err.message}`);
      if (err.run) console.error(formatUsage(err.run));
      await logRun(outRoot, { url: cli.url, status: "failed", reason: err.reason, ...err.run }).catch(() => {});
      return 1;
    }
    console.error(`\nUnexpected error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

main().then((code) => {
  process.exitCode = code;
});
