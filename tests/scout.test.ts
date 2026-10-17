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
    // index.html (795 chars of text, 3 parts) is over the limit; rate-limits (202 chars) is not.
    const truncationWarnings = analysis.warnings.filter((w) => w.startsWith("Page truncated"));
    expect(truncationWarnings).toEqual([
      expect.stringMatching(/^Page truncated: https:\/\/docs\.acmeweather\.example\/ .*findings from this page may be incomplete$/),
    ]);
    expect(analysis.pagesVisited.map((p) => p.truncated)).toEqual([true, false]);
    expect(events.filter((e) => e.step === "page_truncated")).toHaveLength(1);
    expect(buildMarkdown(analysis)).toContain("(read 1 of 3 parts; findings may be incomplete)");
  });

  it("doesn't flag a long page once every part was read", async () => {
    const { promise, events } = await run(
      [{ fetch: ACME_ROOT }, { fetch: ACME_ROOT, part: 2 }, { fetch: ACME_ROOT, part: 3 }, { result: "success", output: ACME_OUTPUT }],
      { config: { ...DEFAULT_CONFIG, maxPageChars: 300 } },
    );
    const analysis = await promise;
    expect(analysis.warnings.filter((w) => w.startsWith("Page truncated"))).toEqual([]);
    expect(analysis.pagesVisited).toEqual([expect.objectContaining({ parts: 3, partsRead: 3, truncated: false })]);
    expect(events.filter((e) => e.step === "page_truncated")).toHaveLength(0);
    expect(buildMarkdown(analysis)).toContain("(read in 3 parts)");
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

describe("runScout with a goal", () => {
  const GOAL = "Receive webhook events and verify their signatures";

  /** The Acme fixtures plus a sitemap listing one page that isn't linked from the start page. */
  function fetcherWithSitemap() {
    const fixtures = createFixtureFetcher();
    const sitemap = `<urlset><url><loc>${ACME_ROOT}webhooks</loc></url><url><loc>${ACME_ROOT}guides/webhook-signatures</loc></url><url><loc>${ACME_ROOT}pricing</loc></url></urlset>`;
    return async (url: string) =>
      url === `${ACME_ROOT}sitemap.xml` ? { finalUrl: url, status: 200, contentType: "application/xml", body: sitemap } : fixtures(url);
  }

  const output = {
    ...ACME_OUTPUT,
    pagesConsidered: [
      { url: `${ACME_ROOT}webhooks`, relevant: true, reason: "Webhook events and signatures." },
      { url: `${ACME_ROOT}rate-limits`, relevant: false, reason: "Not needed for webhooks." },
      { url: "https://elsewhere.example/blog", relevant: true, reason: "Invented." },
    ],
  };

  it("tells the agent the goal, ranks the sitemap, and reports the pages considered", async () => {
    const { promise, events, runner } = await run(
      [{ fetch: ACME_ROOT }, { fetch: "/webhooks" }, { result: "success", output }],
      { goal: `  ${GOAL}\n`, fetcher: fetcherWithSitemap() },
    );
    const analysis = await promise;
    const { prompt, options } = runner.calls[0]!;

    expect(prompt).toContain(`<<<GOAL\n${GOAL}\nGOAL>>>`);
    expect(prompt).toContain(`- [1: webhook] ${ACME_ROOT}webhooks`);
    expect(prompt).toContain(`- [2: webhook, signatu] ${ACME_ROOT}guides/webhook-signatures`);
    expect(prompt).not.toContain("pricing");
    expect(options.systemPrompt).toContain("## Goal mode");
    expect(events.find((e) => e.step === "sitemap_checked")?.detail).toBe("Sitemap: 3 pages, 2 match the goal");

    expect(analysis.goal).toBe(GOAL);
    expect(analysis).not.toHaveProperty("pagesConsidered");
    const pages = analysis.discovery!.pages;
    expect(pages.slice(0, 2)).toEqual([
      expect.objectContaining({ url: ACME_ROOT, read: "read" }),
      expect.objectContaining({ url: `${ACME_ROOT}webhooks`, read: "read", relevant: true, reason: "Webhook events and signatures." }),
    ]);
    expect(pages).toContainEqual(expect.objectContaining({ url: `${ACME_ROOT}guides/webhook-signatures`, read: "not_read", score: 2 }));
    expect(pages).toContainEqual(expect.objectContaining({ url: `${ACME_ROOT}rate-limits`, read: "not_read", relevant: false }));
    expect(analysis.discovery!.sitemap).toEqual({ files: [`${ACME_ROOT}sitemap.xml`], urls: 3, matches: 2 });
    expect(analysis.warnings).toContain("1 relevance note(s) left out: the agent neither read nor saw https://elsewhere.example/blog");

    const md = buildMarkdown(analysis);
    expect(md).toContain(`**Goal:** ${GOAL}`);
    expect(md).toContain("## Pages considered for the goal");
    expect(md).toContain(`| ${ACME_ROOT}webhooks | 2 | webhook | read | yes | Webhook events and signatures. |`);
  });

  it("leaves a run without a goal unchanged", async () => {
    const { promise, runner, events } = await run([{ fetch: ACME_ROOT }, { result: "success", output }]);
    const analysis = await promise;
    expect(runner.calls[0]!.prompt).not.toContain("GOAL");
    expect(runner.calls[0]!.options.systemPrompt).not.toContain("Goal mode");
    expect(events.some((e) => e.step === "sitemap_checked")).toBe(false);
    expect(analysis).not.toHaveProperty("goal");
    expect(analysis).not.toHaveProperty("discovery");
    expect(analysis).not.toHaveProperty("pagesConsidered");
  });

  it("rejects a goal that is too long before starting the agent", async () => {
    const runner = fakeRunner([]);
    await expect(runScout(ACME_ROOT, { config: DEFAULT_CONFIG, runner, goal: "x".repeat(301) })).rejects.toMatchObject({ reason: "invalid_goal" });
    expect(runner.calls).toHaveLength(0);
  });
});
