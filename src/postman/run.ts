import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import newman, { type NewmanRunSummary } from "newman";
import { planCollection, type Collection, type PlannedRequest } from "./plan.js";

/**
 * Runs a generated collection with Newman and writes a report that is safe to
 * share: request names (path templates), status codes, timings and test
 * results only. No headers, bodies or full URLs are recorded, and the token
 * is scrubbed from every message as a second line of defense.
 */

export type RunOptions = {
  collectionPath: string;
  environmentPath?: string;
  /** Credential for the target API; set as {{apiKey}} in memory only. */
  token: string;
  allowWrites: boolean;
  delayMs: number;
  timeoutMs: number;
  outDir: string;
  now?: () => Date;
};

export type TestResult = { name: string; passed: boolean; error?: string };

export type RequestResult = {
  name: string;
  folder: string;
  method: string;
  status?: number;
  responseTimeMs?: number;
  error?: string;
  tests: TestResult[];
  passed: boolean;
};

export type RunReport = {
  collection: string;
  startedAt: string;
  finishedAt: string;
  options: { allowWrites: boolean; delayMs: number; timeoutMs: number };
  totals: { requests: number; run: number; passed: number; failed: number; skipped: number };
  results: RequestResult[];
  skipped: PlannedRequest[];
};

export type RunOutcome = { report: RunReport; jsonPath: string; markdownPath: string };

const REDACTED = "[redacted]";

/** Removes the token and turns URLs into origin + path (query strings can hold credentials). */
export function scrub(text: string, token: string): string {
  let out = text.replace(/https?:\/\/[^\s"'<>]+/gi, (raw) => {
    try {
      const u = new URL(raw);
      return `${u.origin}${u.pathname}`;
    } catch {
      return raw;
    }
  });
  if (token) out = out.split(token).join(REDACTED);
  return out;
}

function runNewman(collection: Collection, environment: object | undefined, opts: RunOptions): Promise<NewmanRunSummary> {
  return new Promise((resolve, reject) => {
    newman.run(
      {
        collection,
        ...(environment ? { environment } : {}),
        envVar: [{ key: "apiKey", value: opts.token }],
        delayRequest: opts.delayMs,
        timeoutRequest: opts.timeoutMs,
        reporters: [],
      },
      (err, summary) => (err ? reject(err) : resolve(summary)),
    );
  });
}

export async function runCollection(opts: RunOptions): Promise<RunOutcome> {
  const now = opts.now ?? (() => new Date());
  const startedAt = now();
  const collection = JSON.parse(await readFile(opts.collectionPath, "utf8")) as Collection;
  const environment = opts.environmentPath ? (JSON.parse(await readFile(opts.environmentPath, "utf8")) as object) : undefined;

  const { plan, runnable } = planCollection(collection, { allowWrites: opts.allowWrites });
  const toRun = plan.filter((p) => p.run);

  const results: RequestResult[] = [];
  if (toRun.length) {
    const summary = await runNewman(runnable, environment, opts);
    // Executions follow the collection order, so they line up with the runnable plan entries.
    summary.run.executions.forEach((ex, i) => {
      const planned = toRun[i];
      const tests = (ex.assertions ?? [])
        .filter((a) => !a.skipped)
        .map((a) => ({
          name: scrub(a.assertion, opts.token),
          passed: !a.error,
          ...(a.error ? { error: scrub(a.error.message ?? "failed", opts.token) } : {}),
        }));
      const error = ex.requestError ? scrub(ex.requestError.message ?? "request failed", opts.token) : undefined;
      results.push({
        name: scrub(ex.item.name, opts.token),
        folder: planned?.folder ?? "",
        method: planned?.method ?? ex.request?.method ?? "GET",
        ...(ex.response ? { status: ex.response.code, responseTimeMs: ex.response.responseTime } : {}),
        ...(error ? { error } : {}),
        tests,
        passed: !error && tests.every((t) => t.passed),
      });
    });
  }

  const skipped = plan.filter((p) => !p.run);
  const passed = results.filter((r) => r.passed).length;
  const report: RunReport = {
    collection: scrub(collection.info?.name ?? path.basename(opts.collectionPath), opts.token),
    startedAt: startedAt.toISOString(),
    finishedAt: now().toISOString(),
    options: { allowWrites: opts.allowWrites, delayMs: opts.delayMs, timeoutMs: opts.timeoutMs },
    totals: { requests: plan.length, run: results.length, passed, failed: results.length - passed, skipped: skipped.length },
    results,
    skipped,
  };

  const json = JSON.stringify(report, null, 2) + "\n";
  const markdown = renderMarkdown(report);
  // Second line of defense: refuse to write anything that still contains the token.
  if (opts.token && (json.includes(opts.token) || markdown.includes(opts.token))) {
    throw new Error("Report would contain the API token; not written.");
  }

  await mkdir(opts.outDir, { recursive: true });
  const stamp = startedAt.toISOString().replace(/[:.]/g, "-").replace(/Z$/, "Z");
  const slug = report.collection.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "collection";
  const base = path.join(opts.outDir, `${slug}-${stamp}`);
  await writeFile(`${base}.json`, json);
  await writeFile(`${base}.md`, markdown);
  return { report, jsonPath: `${base}.json`, markdownPath: `${base}.md` };
}

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");

export function renderMarkdown(r: RunReport): string {
  const t = r.totals;
  const lines = [
    `# Postman run: ${r.collection}`,
    "",
    `Run ${r.startedAt} with Newman. ${t.run} of ${t.requests} requests sent: **${t.passed} passed, ${t.failed} failed**, ${t.skipped} skipped.`,
    `Writes ${r.options.allowWrites ? "allowed (--allow-writes)" : "not sent (GET only)"}; ${r.options.delayMs} ms between requests; ${r.options.timeoutMs} ms timeout.`,
    "",
    "This report has no headers, bodies, full URLs or credentials.",
    "",
    "## Requests sent",
    "",
  ];
  if (r.results.length) {
    lines.push("| Result | Request | Status | Time | Tests |", "| --- | --- | --- | --- | --- |");
    for (const res of r.results) {
      const tests = res.error
        ? `Request failed: ${res.error}`
        : res.tests.map((x) => `${x.passed ? "pass" : "FAIL"}: ${x.name}${x.error ? ` (${x.error})` : ""}`).join("; ");
      lines.push(
        `| ${res.passed ? "PASS" : "FAIL"} | ${cell(res.name)} | ${res.status ?? "-"} | ${res.responseTimeMs !== undefined ? `${res.responseTimeMs} ms` : "-"} | ${cell(tests)} |`,
      );
    }
  } else {
    lines.push("None.");
  }
  lines.push("", "## Skipped", "");
  if (r.skipped.length) {
    lines.push("| Request | Reason |", "| --- | --- |", ...r.skipped.map((s) => `| ${cell(s.name)} | ${cell(s.reason ?? "")} |`));
  } else {
    lines.push("None.");
  }
  return lines.join("\n") + "\n";
}
