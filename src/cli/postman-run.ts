import path from "node:path";
import { parseArgs } from "node:util";
import { runCollection, summaryLine } from "../postman/run.js";

const USAGE = `Usage: npm run postman:run -- <postman_collection.json> [options]
(PowerShell: npm.cmd run postman:run -- ...)

Runs a generated collection with Newman and writes a report to outputs/postman-runs/.
Only GET requests are sent unless you pass --allow-writes.

The target API's token is read from the TARGET_API_TOKEN environment variable
(or .env) and is never written to disk or printed.
  PowerShell:      $env:TARGET_API_TOKEN="..."
  Command Prompt:  set TARGET_API_TOKEN=...

Options:
  --env <file>      Postman environment file (e.g. postman_environment.json)
  --allow-writes    Also send POST, PUT, PATCH and DELETE requests
  --expect-fail <name>
                    Treat a 401/402/403 on this request as an expected failure,
                    e.g. --expect-fail "GET /lookup/{ip}" (repeatable). Requests the
                    analysis marks as plan-gated are handled this way automatically.
  --delay <ms>      Pause between requests (default 500)
  --timeout <ms>    Per-request timeout (default 15000)
  --out <dir>       Report folder (default outputs/postman-runs)
  -h, --help        Show this help`;

function positiveInt(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`--${name} must be a whole number of milliseconds, got "${raw}"`);
  return n;
}

async function main(): Promise<number> {
  let args;
  try {
    args = parseArgs({
      allowPositionals: true,
      options: {
        env: { type: "string" },
        "allow-writes": { type: "boolean", default: false },
        "expect-fail": { type: "string", multiple: true, default: [] },
        delay: { type: "string" },
        timeout: { type: "string" },
        out: { type: "string", default: "outputs/postman-runs" },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (err) {
    console.error(`${(err as Error).message}\n\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = args;
  if (values.help || positionals.length !== 1) {
    (values.help ? console.log : console.error)(USAGE);
    return values.help ? 0 : 2;
  }

  const token = process.env.TARGET_API_TOKEN?.trim();
  if (!token) {
    console.error(
      "TARGET_API_TOKEN is not set. Set the target API's token first:\n" +
        '  PowerShell:      $env:TARGET_API_TOKEN="..."\n' +
        "  Command Prompt:  set TARGET_API_TOKEN=...\n" +
        "or add TARGET_API_TOKEN=... to .env. It is never written to the report.",
    );
    return 2;
  }

  let delayMs: number;
  let timeoutMs: number;
  try {
    delayMs = positiveInt("delay", values.delay, 500);
    timeoutMs = positiveInt("timeout", values.timeout, 15_000);
  } catch (err) {
    console.error((err as Error).message);
    return 2;
  }

  const { report, markdownPath, jsonPath } = await runCollection({
    collectionPath: positionals[0]!,
    environmentPath: values.env,
    token,
    allowWrites: values["allow-writes"],
    expectFail: values["expect-fail"],
    delayMs,
    timeoutMs,
    outDir: values.out,
  });

  console.log(`Postman run: ${report.collection}${report.options.allowWrites ? " (writes allowed)" : " (GET only)"}`);
  for (const r of report.results) {
    const detail = r.error ? `request failed: ${r.error}` : `${r.status} in ${r.responseTimeMs} ms`;
    const label = r.outcome === "pass" ? "PASS" : r.outcome === "fail" ? "FAIL" : "EXPECTED FAIL";
    console.log(`  ${label}  ${r.name}  ${detail}${r.expected ? `  (${r.expected})` : ""}`);
    if (r.outcome === "fail") for (const t of r.tests.filter((x) => !x.passed)) console.log(`        - ${t.name}: ${t.error}`);
  }
  for (const s of report.skipped) console.log(`  SKIP  ${s.name}  (${s.reason})`);
  for (const name of report.unmatchedExpectFail) console.log(`  Note: --expect-fail "${name}" matched no request`);
  console.log(`\n${summaryLine(report.totals)}`);
  console.log(`Report: ${path.relative(process.cwd(), markdownPath)}`);
  console.log(`        ${path.relative(process.cwd(), jsonPath)}`);
  return report.totals.failed > 0 ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`Postman run failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
