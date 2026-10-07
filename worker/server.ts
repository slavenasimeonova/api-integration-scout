import { timingSafeEqual } from "node:crypto";
import http from "node:http";
import { runScout, ScoutError, type AgentRunner, type Fetcher, type ProgressEvent, type ScoutConfig } from "../src/core/index.js";
import type { Analysis, RunStats } from "../src/core/schema.js";
import { buildOutputs } from "../src/generators/index.js";
import type { RunLimiter } from "./limits.js";
import { BlockedUrlError, checkUrl } from "./safe-fetch.js";

/**
 * HTTP front of the worker. One live run = one POST /api/run, answered with
 * NDJSON lines (see RunStreamLine) so the browser can render progress live.
 */

export type RunStreamLine =
  | { type: "event"; event: ProgressEvent }
  | { type: "result"; analysis: Analysis; slug: string; files: Record<string, string>; postmanErrors: string[] }
  | { type: "error"; reason: string; message: string };

export type WorkerDeps = {
  config: ScoutConfig;
  limiter: RunLimiter;
  fetcher: Fetcher;
  /** Checks a user-submitted URL before any money is spent. Defaults to the SSRF check. */
  checkStartUrl?: (url: string) => Promise<unknown>;
  runner?: AgentRunner;
  /** When set, every /api request must carry it in the x-scout-secret header (for a proxy in front). */
  secret?: string;
  /** Header holding the client IP when behind a trusted proxy, e.g. "x-forwarded-for". */
  clientIpHeader?: string;
  log?: (line: Record<string, unknown>) => void;
};

const MAX_BODY_BYTES = 4 * 1024;

export function createWorkerServer(deps: WorkerDeps): http.Server {
  const log = deps.log ?? ((line) => console.log(JSON.stringify(line)));
  return http.createServer((req, res) => {
    handle(req, res, deps, log).catch((err) => {
      log({ at: new Date().toISOString(), level: "error", message: err instanceof Error ? err.message : String(err) });
      if (!res.headersSent) json(res, 500, { error: "internal", message: "Unexpected server error" });
      else res.end();
    });
  });
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse, deps: WorkerDeps, log: NonNullable<WorkerDeps["log"]>) {
  const path = new URL(req.url ?? "/", "http://worker").pathname;
  if (req.method === "GET" && path === "/health") return json(res, 200, { ok: true });
  if (!path.startsWith("/api/")) return json(res, 404, { error: "not_found", message: "Not found" });
  if (deps.secret && !secretMatches(req.headers["x-scout-secret"], deps.secret)) {
    return json(res, 401, { error: "unauthorized", message: "Unauthorized" });
  }
  const ip = clientIp(req, deps.clientIpHeader);

  if (req.method === "GET" && path === "/api/limits") return json(res, 200, await deps.limiter.status(ip));
  if (req.method !== "POST" || path !== "/api/run") return json(res, 404, { error: "not_found", message: "Not found" });

  let url: string;
  try {
    const body = JSON.parse(await readBody(req)) as { url?: unknown };
    if (typeof body.url !== "string" || !body.url.trim()) throw new Error();
    url = body.url.trim();
  } catch {
    return json(res, 400, { error: "bad_request", message: 'Send JSON like {"url": "https://docs.example.com"}' });
  }

  // Reject unsafe or unresolvable URLs before a run slot is spent.
  try {
    await (deps.checkStartUrl ?? checkUrl)(url);
  } catch (err) {
    const message = err instanceof BlockedUrlError ? err.message : "That URL can't be checked";
    return json(res, 400, { error: "blocked_url", message });
  }

  const slot = await deps.limiter.reserve(ip);
  if (!slot.ok) return json(res, slot.reason === "busy" ? 503 : 429, { error: slot.reason, message: slot.message });

  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no",
  });
  const send = (line: RunStreamLine) => {
    if (!res.writableEnded && !res.destroyed) res.write(JSON.stringify(line) + "\n");
  };

  // A closed browser tab cancels the run (and stops spending).
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) controller.abort();
  });

  let run: RunStats | undefined;
  let status = "success";
  let reason: string | undefined;
  try {
    const analysis = await runScout(url, {
      config: deps.config,
      fetcher: deps.fetcher,
      runner: deps.runner,
      signal: controller.signal,
      onEvent: (event) => send({ type: "event", event }),
    });
    run = analysis.run;
    const { slug, files, postmanValidation } = buildOutputs(analysis);
    send({ type: "result", analysis, slug, files, postmanErrors: postmanValidation.errors });
  } catch (err) {
    status = "failed";
    if (err instanceof ScoutError) {
      run = err.run;
      reason = err.reason;
      send({ type: "error", reason: err.reason, message: err.message });
    } else {
      reason = "internal";
      send({ type: "error", reason: "internal", message: "The run failed unexpectedly" });
    }
  } finally {
    const costUsd = chargeFor(run, deps.config.maxBudgetUsd);
    await deps.limiter.settle(slot.reservation, costUsd);
    log({
      at: new Date().toISOString(),
      event: "run",
      url,
      status,
      reason,
      visitor: slot.reservation.visitor,
      model: deps.config.model,
      durationMs: run?.durationMs,
      totalTokens: run?.totalTokens ?? 0,
      reportedCostUsd: run?.costUsd ?? 0,
      chargedUsd: costUsd,
    });
    res.end();
  }
}

/**
 * Cost to count against the daily budget. A run cut short (abort, token
 * budget) has no SDK cost figure; if it used tokens, assume the per-run cap.
 */
export function chargeFor(run: RunStats | undefined, perRunUsd: number): number {
  if (!run) return 0;
  if (run.costUsd > 0) return run.costUsd;
  return run.totalTokens > 0 ? perRunUsd : 0;
}

function secretMatches(header: string | string[] | undefined, secret: string): boolean {
  if (typeof header !== "string") return false;
  const a = Buffer.from(header);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

function clientIp(req: http.IncomingMessage, header: string | undefined): string {
  if (header) {
    const value = req.headers[header.toLowerCase()];
    const first = (Array.isArray(value) ? value[0] : value)?.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? "unknown";
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}
