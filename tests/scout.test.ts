import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import type { ProgressEvent } from "../src/core/events.js";
import { ScoutError, runScout, type RunScoutOptions } from "../src/core/scout.js";
import { buildMarkdown } from "../src/generators/markdown.js";
import { ACME_ROOT, createFixtureFetcher } from "./helpers/fixtures.js";
import { ACME_OUTPUT, fakeRunner, type FakeStep } from "./helpers/fake-runner.js";

const FETCH_ALL: FakeStep[] = [{ fetch: ACME_ROOT }, { fetch: "/endpoints" }, { fetch: "/rate-limits" }, { fetch: "/webhooks" }];

async function run(steps: FakeStep[], overrides: Partial<RunScoutOptions> = {}) {
  const events: ProgressEvent[] = [];
  const runner = fakeRunner(steps);
  const promise = runScout(ACME_ROOT, {
    config: DEFAULT_CONFIG,
    fetcher: createFixtureFetcher(),
    runner,
    onEvent: (e) => events.push(e),
    ...overrides,
  });
  return { promise, events, runner };
}

describe("runScout", () => {
  it("produces a verified analysis and streams progress events", async () => {
    const { promise, events, runner } = await run([
      ...FETCH_ALL,
      { progress: ["auth_found", "API key in X-Api-Key header"] },
      { assistant: { input_tokens: 1000, output_tokens: 400, cache_creation_input_tokens: 2000 } },
      {
        result: "success",
        output: ACME_OUTPUT,
        usage: { input_tokens: 1000, output_tokens: 400, cache_read_input_tokens: 5000, cache_creation_input_tokens: 2000 },
        costUsd: 0.0123,
      },
    ]);
    const analysis = await promise;

    // SDK options lock the agent down to our two tools and isolated settings.
    const options = runner.calls[0]!.options;
    expect(options).toMatchObject({
      model: "claude-sonnet-5-5",
      tools: [],
      allowedTools: ["mcp__scout__fetch_page", "mcp__scout__report_progress"],
      permissionMode: "dontAsk",
      settingSources: [],
      settings: { autoMemoryEnabled: false },
      maxBudgetUsd: 0.5,
    });
    expect(options.outputFormat?.type).toBe("json_schema");

    expect(analysis.apiName).toBe("Acme Weather");
    expect(analysis.auth.status).toBe("documented");
    expect(analysis.pagesVisited).toHaveLength(4);
    expect(analysis.run).toMatchObject({ inputTokens: 1000, outputTokens: 400, cacheReadInputTokens: 5000, totalTokens: 8400, costUsd: 0.0123 });

    // The wrong POST /alerts quote is downgraded and surfaced as a risk.
    const alerts = analysis.endpoints[3]!;
    expect(alerts.status).toBe("inferred");
    expect(analysis.risks).toContainEqual(expect.objectContaining({ origin: "verification", title: "Unverified claim: endpoints[3] POST /alerts" }));

    const steps = events.map((e) => e.step);
    expect(steps[0]).toBe("run_started");
    expect(steps).toContain("auth_found");
    expect(steps.filter((s) => s === "page_fetched")).toHaveLength(4);
    expect(steps).toContain("verification_downgrade");
    expect(steps.at(-1)).toBe("run_completed");
  });

  it("adds a risk when a docs page looks JavaScript-rendered", async () => {
    const { promise, events } = await run([{ fetch: ACME_ROOT }, { fetch: "/app" }, { result: "success", output: ACME_OUTPUT }]);
    const analysis = await promise;
    expect(analysis.risks).toContainEqual(
      expect.objectContaining({ origin: "fetch", title: "docs page may require JavaScript rendering; content may be incomplete" }),
    );
    expect(analysis.warnings.some((w) => w.includes("/app"))).toBe(true);
    expect(events.some((e) => e.step === "low_text_warning")).toBe(true);
  });

  it("notes truncated pages in the analysis so truncation is never silent", async () => {
    const { promise, events } = await run(
      [{ fetch: ACME_ROOT }, { fetch: "/rate-limits" }, { result: "success", output: ACME_OUTPUT }],
      { config: { ...DEFAULT_CONFIG, maxPageChars: 300 } },
    );
    const analysis = await promise;
    // index.html (580 chars) is over the limit; rate-limits (202 chars) is not.
    const truncationWarnings = analysis.warnings.filter((w) => w.startsWith("Page truncated"));
    expect(truncationWarnings).toEqual([
      expect.stringMatching(/^Page truncated: https:\/\/docs\.acmeweather\.example\/ .*findings from this page may be incomplete$/),
    ]);
    expect(analysis.pagesVisited.map((p) => p.truncated)).toEqual([true, false]);
    expect(events.filter((e) => e.step === "page_truncated")).toHaveLength(1);
    expect(buildMarkdown(analysis)).toContain("(truncated; findings may be incomplete)");
  });

  it("stops when the token budget is exceeded and still reports usage", async () => {
    const { promise, events } = await run(
      [{ fetch: ACME_ROOT }, { assistant: { input_tokens: 600, output_tokens: 100 } }, { assistant: { input_tokens: 600, output_tokens: 100 } }, { fetch: "/endpoints" }],
      { config: { ...DEFAULT_CONFIG, maxTokens: 1000 } },
    );
    const err = await promise.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ScoutError);
    expect((err as ScoutError).reason).toBe("budget_exceeded");
    expect((err as ScoutError).run?.inputTokens).toBe(1200);
    expect(events.map((e) => e.step)).toContain("budget_exceeded");
    expect(events.at(-1)?.step).toBe("run_failed");
  });

  it("maps SDK error results to typed failures", async () => {
    const { promise } = await run([{ result: "error_max_budget_usd" }]);
    await expect(promise).rejects.toMatchObject({ reason: "max_budget_usd" });

    const { promise: p2 } = await run([{ result: "error_max_structured_output_retries" }]);
    await expect(p2).rejects.toMatchObject({ reason: "no_structured_output" });
  });

  it("surfaces the API's error message instead of a generic failure", async () => {
    const message = "API Error: 400 This API key is not scoped to a workspace";
    const { promise } = await run([{ apiError: message, status: 400 }]);
    await expect(promise).rejects.toMatchObject({
      reason: "api_error",
      message: `Claude API error (HTTP 400): ${message}`,
    });
  });

  it("rejects output that doesn't match the schema", async () => {
    const { promise } = await run([{ result: "success", output: { apiName: "x" } }]);
    await expect(promise).rejects.toMatchObject({ reason: "invalid_output" });
  });

  it("reports crashes of the agent process", async () => {
    const { promise } = await run([{ throw: "spawn failed" }]);
    await expect(promise).rejects.toMatchObject({ reason: "execution_error", message: expect.stringContaining("spawn failed") });
  });

  it("rejects non-http URLs before starting the agent", async () => {
    const runner = fakeRunner([]);
    await expect(runScout("ftp://example.com", { config: DEFAULT_CONFIG, runner })).rejects.toMatchObject({ reason: "invalid_url" });
    expect(runner.calls).toHaveLength(0);
  });
});
