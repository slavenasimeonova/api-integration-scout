import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { createEmitter, type ProgressEvent } from "../src/core/events.js";
import { DocsSession, createScoutMcpServer } from "../src/core/tools.js";
import { ACME_ROOT, createFixtureFetcher } from "./helpers/fixtures.js";

function setup(maxPages = 5) {
  const events: ProgressEvent[] = [];
  const fetcher = createFixtureFetcher();
  const session = new DocsSession(ACME_ROOT, fetcher, { ...DEFAULT_CONFIG, maxPages }, createEmitter((e) => events.push(e)));
  return { session, fetcher, events };
}

describe("DocsSession.fetchPage", () => {
  it("returns page text and same-site links, and emits page_fetched", async () => {
    const { session, events } = setup();
    const result = await session.fetchPage(ACME_ROOT);

    expect(result.isError).toBe(false);
    expect(result.text).toContain("X-Api-Key");
    expect(result.text).toContain("https://docs.acmeweather.example/endpoints");
    expect(result.text).not.toContain("twitter.com");
    expect(events.find((e) => e.step === "page_fetched")).toMatchObject({ pageCount: 1, maxPages: 5 });
    expect(session.pages.get(ACME_ROOT)?.title).toBe("Acme Weather API — Overview");
  });

  it("numbers pages in the order they finish when fetched in parallel", async () => {
    const events: ProgressEvent[] = [];
    const fixtures = createFixtureFetcher();
    // The first request is the slowest, as with a large page fetched alongside small ones.
    const delays: Record<string, number> = { "/": 60, "/endpoints": 30, "/rate-limits": 0 };
    const slow = async (url: string) => {
      await new Promise((r) => setTimeout(r, delays[new URL(url).pathname] ?? 0));
      return fixtures(url);
    };
    const session = new DocsSession(ACME_ROOT, slow, { ...DEFAULT_CONFIG, maxPages: 5 }, createEmitter((e) => events.push(e)));
    await Promise.all([session.fetchPage(ACME_ROOT), session.fetchPage("/endpoints"), session.fetchPage("/rate-limits")]);

    const fetched = events.flatMap((e) => (e.step === "page_fetched" ? [e] : []));
    expect(fetched.map((e) => e.pageCount)).toEqual([1, 2, 3]);
    expect(fetched.map((e) => new URL(e.url).pathname)).toEqual(["/rate-limits", "/endpoints", "/"]);
    expect(fetched[0]!.detail).toMatch(/\(1\/5\)$/);
  });

  it("accepts relative paths", async () => {
    const { session, fetcher } = setup();
    await session.fetchPage("/endpoints");
    expect(fetcher.requested).toEqual(["https://docs.acmeweather.example/endpoints"]);
  });

  it("refuses off-site URLs without fetching them", async () => {
    const { session, fetcher, events } = setup();
    const result = await session.fetchPage("https://twitter.com/acmeweather");
    expect(result.isError).toBe(true);
    expect(fetcher.requested).toHaveLength(0);
    expect(events[0]).toMatchObject({ step: "page_skipped", reason: "off_domain" });
  });

  it("enforces the page limit, even for parallel calls", async () => {
    const { session, fetcher } = setup(2);
    const results = await Promise.all(
      ["/", "/endpoints", "/webhooks", "/rate-limits"].map((p) => session.fetchPage(p)),
    );
    expect(fetcher.requested).toHaveLength(2);
    expect(results.filter((r) => r.text.includes("Page limit of 2 reached"))).toHaveLength(2);
  });

  it("numbers parallel fetches by their reserved slot", async () => {
    const { session, events } = setup();
    await Promise.all(["/", "/endpoints", "/webhooks"].map((p) => session.fetchPage(p)));
    const counts = events.flatMap((e) => (e.step === "page_fetched" ? [e.pageCount] : []));
    expect(counts.sort()).toEqual([1, 2, 3]);
  });

  it("does not refetch a page", async () => {
    const { session, fetcher } = setup();
    await session.fetchPage("/webhooks");
    const again = await session.fetchPage("/webhooks#signatures");
    expect(fetcher.requested).toHaveLength(1);
    expect(again.text).toContain("Already fetched");
  });

  it("warns about JavaScript-rendered pages instead of failing silently", async () => {
    const { session, events } = setup();
    const result = await session.fetchPage("/app");
    expect(result.isError).toBe(false);
    expect(result.text).toContain("may require JavaScript rendering");
    expect(events.find((e) => e.step === "low_text_warning")).toMatchObject({ url: ACME_ROOT + "app" });
    expect(session.visits[0]).toMatchObject({ status: "fetched", lowText: true });
  });

  it("does not flag short but normal server-rendered pages", async () => {
    const { session, events } = setup();
    await session.fetchPage("/rate-limits");
    expect(session.visits[0]?.textLength).toBeLessThan(DEFAULT_CONFIG.minPageTextChars);
    expect(session.visits[0]?.lowText).toBe(false);
    expect(events.some((e) => e.step === "low_text_warning")).toBe(false);
  });

  it("records failed fetches", async () => {
    const { session, events } = setup();
    const result = await session.fetchPage("/missing");
    expect(result).toMatchObject({ isError: true });
    expect(session.visits[0]).toMatchObject({ status: "failed", error: "HTTP 404" });
    expect(events[0]).toMatchObject({ step: "page_skipped", reason: "fetch_error" });
  });

  it("truncates long pages sent to the model but keeps full text for verification", async () => {
    const events: ProgressEvent[] = [];
    const session = new DocsSession(
      ACME_ROOT,
      createFixtureFetcher(),
      { ...DEFAULT_CONFIG, maxPageChars: 100 },
      createEmitter((e) => events.push(e)),
    );
    const result = await session.fetchPage("/");
    expect(result.text).toContain("truncated to 100");
    expect(session.pages.get(ACME_ROOT)!.text.length).toBeGreaterThan(100);
    expect(session.visits[0]).toMatchObject({ truncated: true });
    expect(events.find((e) => e.step === "page_truncated")).toMatchObject({ url: ACME_ROOT, maxChars: 100 });
  });

  it("does not report truncation for pages under the limit", async () => {
    const { session, events } = setup();
    await session.fetchPage("/");
    expect(session.visits[0]).toMatchObject({ truncated: false });
    expect(events.some((e) => e.step === "page_truncated")).toBe(false);
  });
});

describe("reportProgress", () => {
  it("emits the agent's step as a progress event", () => {
    const { session, events } = setup();
    session.reportProgress("auth_found", "API key in X-Api-Key header");
    expect(events[0]).toMatchObject({ step: "auth_found", detail: "API key in X-Api-Key header" });
  });
});

describe("createScoutMcpServer", () => {
  it("builds an in-process SDK MCP server", () => {
    const server = createScoutMcpServer(setup().session);
    expect(server.type).toBe("sdk");
    expect(server.name).toBe("scout");
  });
});
