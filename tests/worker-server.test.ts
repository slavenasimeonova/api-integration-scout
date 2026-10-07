import type http from "node:http";
import type { AddressInfo } from "node:net";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import type { AgentRunner } from "../src/core/scout.js";
import { MemoryStore, RunLimiter, type LimitConfig } from "../worker/limits.js";
import { chargeFor, createWorkerServer, type RunStreamLine, type WorkerDeps } from "../worker/server.js";
import { ACME_ROOT, createFixtureFetcher } from "./helpers/fixtures.js";
import { ACME_OUTPUT, fakeRunner, type FakeStep } from "./helpers/fake-runner.js";

const SUCCESS: FakeStep[] = [
  { fetch: ACME_ROOT },
  { fetch: "/endpoints" },
  { progress: ["auth_found", "API key in X-Api-Key header"] },
  { assistant: { input_tokens: 1000, output_tokens: 400 } },
  { result: "success", output: ACME_OUTPUT, usage: { input_tokens: 1000, output_tokens: 400 }, costUsd: 0.05 },
];

let server: http.Server | undefined;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

async function start(overrides: Partial<WorkerDeps> & { limits?: Partial<LimitConfig>; steps?: FakeStep[] } = {}) {
  const logs: Record<string, unknown>[] = [];
  const limiter = new RunLimiter(
    new MemoryStore(),
    { perVisitorRuns: 3, globalRuns: 10, globalUsd: 2, perRunUsd: 0.5, maxConcurrent: 2, ...overrides.limits },
    "salt",
  );
  server = createWorkerServer({
    config: DEFAULT_CONFIG,
    limiter,
    fetcher: createFixtureFetcher(),
    runner: fakeRunner(overrides.steps ?? SUCCESS),
    // The Acme fixture host doesn't exist in DNS; the real check is tested in worker-safe-fetch.
    checkStartUrl: async () => [],
    log: (line) => logs.push(line),
    ...overrides,
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (url: string, init: RequestInit = {}) =>
    fetch(`${base}/api/run`, { method: "POST", body: JSON.stringify({ url }), headers: { "Content-Type": "application/json" }, ...init });
  return { base, post, logs, limiter };
}

async function lines(res: Response): Promise<RunStreamLine[]> {
  return (await res.text())
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as RunStreamLine);
}

describe("worker server", () => {
  it("streams progress events as NDJSON, then the analysis and output files", async () => {
    const { post, logs, base } = await start();
    const res = await post(ACME_ROOT);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");

    const out = await lines(res);
    const steps = out.flatMap((l) => (l.type === "event" ? [l.event.step] : []));
    expect(steps).toEqual(expect.arrayContaining(["run_started", "page_fetched", "auth_found", "usage_update", "verification_downgrade", "run_completed"]));
    expect(steps.indexOf("page_fetched")).toBeLessThan(steps.indexOf("run_completed"));

    const last = out.at(-1)!;
    expect(last.type).toBe("result");
    if (last.type !== "result") return;
    expect(Object.keys(last.files).sort()).toEqual([
      "analysis.json",
      "analysis.md",
      "postman_collection.json",
      "postman_environment.json",
      "sequence.mmd",
    ]);
    expect(last.postmanErrors).toEqual([]);

    expect(logs.at(-1)).toMatchObject({ event: "run", status: "success", chargedUsd: 0.05 });
    expect(JSON.stringify(logs)).not.toContain("127.0.0.1");
    expect(await (await fetch(`${base}/api/limits`)).json()).toMatchObject({ visitorRemaining: 2 });
  });

  it("answers 429 once the visitor's runs are used up", async () => {
    const { post } = await start({ limits: { perVisitorRuns: 1 } });
    await (await post(ACME_ROOT)).text();
    const res = await post(ACME_ROOT);
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: "visitor_limit" });
  });

  it("rejects private and malformed URLs before using a run slot", async () => {
    const { post, base } = await start({ checkStartUrl: undefined });
    for (const url of ["http://169.254.169.254/latest/meta-data/", "http://localhost:3000/", "file:///etc/passwd"]) {
      const res = await post(url);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "blocked_url" });
    }
    const bad = await fetch(`${base}/api/run`, { method: "POST", body: "not json" });
    expect(bad.status).toBe(400);
    expect(await (await fetch(`${base}/api/limits`)).json()).toMatchObject({ visitorRemaining: 3 });
  });

  it("requires the shared secret when one is configured", async () => {
    const { post } = await start({ secret: "s3cret" });
    expect((await post(ACME_ROOT)).status).toBe(401);
    expect((await post(ACME_ROOT, { headers: { "x-scout-secret": "wrong!" } })).status).toBe(401);
    expect((await post(ACME_ROOT, { headers: { "x-scout-secret": "s3cret" } })).status).toBe(200);
  });

  it("reports a failed run as an error line and refunds a run that cost nothing", async () => {
    const { post, base } = await start({ steps: [{ apiError: "invalid x-api-key", status: 401 }] });
    const out = await lines(await post(ACME_ROOT));
    expect(out.at(-1)).toMatchObject({ type: "error", reason: "api_error" });
    expect(await (await fetch(`${base}/api/limits`)).json()).toMatchObject({ visitorRemaining: 3 });
  });

  it("cancels the run when the client disconnects, and charges the per-run cap", async () => {
    let aborted = false;
    // Uses tokens, then waits until the worker aborts it.
    const runner: AgentRunner = async function* ({ options }) {
      yield { type: "assistant", message: { id: "m1", usage: { input_tokens: 500, output_tokens: 10 }, content: [] } } as unknown as SDKMessage;
      await new Promise<void>((resolve) => options.abortController!.signal.addEventListener("abort", () => resolve()));
      aborted = true;
      throw new Error("aborted");
    };
    const { post, logs } = await start({ runner });
    const client = new AbortController();
    const res = await post(ACME_ROOT, { signal: client.signal });
    const reader = res.body!.getReader();
    await reader.read(); // first event arrived: the run is in progress
    client.abort();

    await expect.poll(() => logs.find((l) => l.event === "run")).toMatchObject({ status: "failed", reason: "aborted", chargedUsd: 0.5 });
    expect(aborted).toBe(true);
  });

  it("serves a health check without the secret", async () => {
    const { base } = await start({ secret: "s3cret" });
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });
});

describe("chargeFor", () => {
  const run = { costUsd: 0, totalTokens: 0 } as Parameters<typeof chargeFor>[0];
  it("uses the SDK cost when there is one", () => expect(chargeFor({ ...run!, costUsd: 0.12, totalTokens: 9 }, 0.5)).toBe(0.12));
  it("assumes the cap for a cut-short run that used tokens", () => expect(chargeFor({ ...run!, totalTokens: 900 }, 0.5)).toBe(0.5));
  it("charges nothing for a run that never reached the model", () => expect(chargeFor(run, 0.5)).toBe(0));
});
