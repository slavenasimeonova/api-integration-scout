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
  /** Request names whose 401/402/403 counts as an expected failure. */
  expectFail?: string[];
  delayMs: number;
  timeoutMs: number;
  outDir: string;
  now?: () => Date;
};

export type TestResult = { name: string; passed: boolean; error?: string };

export type Outcome = "pass" | "fail" | "expected_failure";

export type RequestResult = {
  name: string;
  folder: string;
  method: string;
  status?: number;
  responseTimeMs?: number;
  error?: string;
  tests: TestResult[];
  outcome: Outcome;
  /** Why a failure was expected, e.g. "tier-gated per analysis: requires Core, Plus or Max plan". */
  expected?: string;
};

export type RunReport = {
  collection: string;
  startedAt: string;
  finishedAt: string;
  options: { allowWrites: boolean; expectFail: string[]; delayMs: number; timeoutMs: number };
  totals: { requests: number; run: number; passed: number; failed: number; expectedFailures: number; skipped: number };
  results: RequestResult[];
  skipped: PlannedRequest[];
  /** --expect-fail names that matched no request in the collection. */
  unmatchedExpectFail: string[];
};

/** Statuses that mean "not allowed for this plan or credential". Anything else on a gated request is a real failure. */
const ACCESS_DENIED = new Set([401, 402, 403]);

function expectedReason(planned: PlannedRequest | undefined): string | undefined {
  if (planned?.requires) return `tier-gated per analysis: requires ${planned.requires}`;
  if (planned?.expectFail) return "marked with --expect-fail";
  return undefined;
}

export type RunOutcome = { report: RunReport; jsonPath: string; markdownPath: string };

const REDACTED = "[redacted]";

/**
 * Removes the token, and cuts query strings, fragments and user:password@
 * from URLs (they can hold credentials). Done on the text, not via new URL(),
 * which would percent-encode path placeholders: {ip} must stay {ip}.
 */
export function scrub(text: string, token: string): string {
  let out = text.replace(/https?:\/\/[^\s"'<>]+/gi, (raw) => raw.replace(/^(https?:\/\/)[^/@]*@/i, "$1").replace(/[?#].*$/, ""));
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

  const { plan, runnable, unmatchedExpectFail } = planCollection(collection, { allowWrites: opts.allowWrites, expectFail: opts.expectFail });
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
      const passed = !error && tests.every((t) => t.passed);
      const because = expectedReason(planned);
      const outcome: Outcome =
        passed ? "pass" : because && ex.response && ACCESS_DENIED.has(ex.response.code) ? "expected_failure" : "fail";
      results.push({
        name: scrub(ex.item.name, opts.token),
        folder: planned?.folder ?? "",
        method: planned?.method ?? ex.request?.method ?? "GET",
        ...(ex.response ? { status: ex.response.code, responseTimeMs: ex.response.responseTime } : {}),
        ...(error ? { error } : {}),
        tests,
        outcome,
        ...(outcome === "expected_failure" ? { expected: scrub(because!, opts.token) } : {}),
      });
    });
  }

  const skipped = plan.filter((p) => !p.run);
  const count = (o: Outcome) => results.filter((r) => r.outcome === o).length;
  const report: RunReport = {
    collection: scrub(collection.info?.name ?? path.basename(opts.collectionPath), opts.token),
    startedAt: startedAt.toISOString(),
    finishedAt: now().toISOString(),
    options: {
      allowWrites: opts.allowWrites,
      expectFail: (opts.expectFail ?? []).map((n) => scrub(n, opts.token)),
      delayMs: opts.delayMs,
      timeoutMs: opts.timeoutMs,
    },
    totals: {
      requests: plan.length,
      run: results.length,
      passed: count("pass"),
      failed: count("fail"),
      expectedFailures: count("expected_failure"),
      skipped: skipped.length,
    },
    results,
    skipped,
    unmatchedExpectFail: unmatchedExpectFail.map((n) => scrub(n, opts.token)),
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

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** One-line totals for the CLI, e.g. "2 passed, 0 failed, 1 expected failure, 0 skipped of 3 requests". */
export function summaryLine(t: RunReport["totals"]): string {
  return `${t.passed} passed, ${t.failed} failed, ${plural(t.expectedFailures, "expected failure")}, ${t.skipped} skipped of ${plural(t.requests, "request")}`;
}

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");

export function renderMarkdown(r: RunReport): string {
  const t = r.totals;
  const lines = [
    `# Postman run: ${r.collection}`,
    "",
    `Run ${r.startedAt} with Newman. ${t.run} of ${plural(t.requests, "request")} sent: **${t.passed} passed, ${t.failed} failed**, ${plural(t.expectedFailures, "expected failure")}, ${t.skipped} skipped.`,
    `Writes ${r.options.allowWrites ? "allowed (--allow-writes)" : "not sent (GET only)"}; ${r.options.delayMs} ms between requests; ${r.options.timeoutMs} ms timeout.`,
    "",
    "This report has no headers, bodies, full URLs or credentials.",
    "An expected failure is a 401, 402 or 403 on a request that the analysis says needs a plan or permission, or that was named with --expect-fail. Any other status is a real failure.",
    ...(r.unmatchedExpectFail.length
      ? ["", `Note: --expect-fail matched no request: ${r.unmatchedExpectFail.map((n) => `"${n}"`).join(", ")}.`]
      : []),
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
      const label = res.outcome === "pass" ? "PASS" : res.outcome === "fail" ? "FAIL" : "EXPECTED FAIL";
      lines.push(
        `| ${label} | ${cell(res.name)} | ${res.status ?? "-"} | ${res.responseTimeMs !== undefined ? `${res.responseTimeMs} ms` : "-"} | ${cell(res.expected ? `Expected failure: ${res.expected}. ${tests}` : tests)} |`,
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
