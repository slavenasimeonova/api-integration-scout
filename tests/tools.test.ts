import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { createEmitter, type ProgressEvent } from "../src/core/events.js";
import type { Fetcher } from "../src/core/fetcher.js";
import { goalTerms } from "../src/core/relevance.js";
import { DocsSession, createScoutMcpServer, splitParts } from "../src/core/tools.js";
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

  it("sends long pages in parts, keeps the full text, and reports unread parts at the end", async () => {
    const events: ProgressEvent[] = [];
    const session = new DocsSession(
      ACME_ROOT,
      createFixtureFetcher(),
      { ...DEFAULT_CONFIG, maxPageChars: 100 },
      createEmitter((e) => events.push(e)),
    );
    const result = await session.fetchPage("/");
    expect(result.text).toMatch(/in \d+ parts; this is part 1 \(characters 0-\d+\)\. Unread parts: 2, 3/);
    expect(session.pages.get(ACME_ROOT)!.text.length).toBeGreaterThan(100);
    expect(session.visits[0]).toMatchObject({ truncated: true, partsRead: 1 });
    expect(events.some((e) => e.step === "page_truncated")).toBe(false);

    session.reportUnreadParts();
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

const GH_ROOT = "https://github.com/parcelpost/api-docs";
const RAW_SPEC = "https://raw.githubusercontent.com/parcelpost/api-docs/main/parcelpost-alerts.yaml";
const SPEC = readFileSync(new URL("./fixtures/specs/parcelpost-alerts.yaml", import.meta.url), "utf8");

/** A fake GitHub repo page linking to a spec, plus the spec's raw file. */
function githubFetcher(): Fetcher & { requested: string[] } {
  const requested: string[] = [];
  const repoPage = `<html><head><title>parcelpost/api-docs</title></head><body><main>
    <h1>api-docs</h1><p>OpenAPI specs for the Parcelpost APIs.</p>
    <a href="/parcelpost/api-docs/blob/main/parcelpost-alerts.yaml">parcelpost-alerts.yaml</a>
    <a href="https://github.com/someone-else/fork">someone-else/fork</a>
    <a href="https://docs.github.com/en">GitHub Docs</a>
  </main></body></html>`;
  const fetcher = async (url: string) => {
    requested.push(url);
    if (url === GH_ROOT) return { finalUrl: url, status: 200, contentType: "text/html", body: repoPage };
    if (url === RAW_SPEC) return { finalUrl: url, status: 200, contentType: "text/plain; charset=utf-8", body: SPEC };
    return { finalUrl: url, status: 404, contentType: "text/plain", body: "404: Not Found" };
  };
  return Object.assign(fetcher, { requested });
}

describe("long pages and API specs", () => {
  function ghSetup(maxPages = 10) {
    const events: ProgressEvent[] = [];
    const fetcher = githubFetcher();
    const config = { ...DEFAULT_CONFIG, maxPages, maxPageChars: 2000 };
    const session = new DocsSession(GH_ROOT, fetcher, config, createEmitter((e) => events.push(e)));
    return { session, fetcher, events };
  }

  it("lists GitHub file links as raw files, and only the same owner's", async () => {
    const { session } = ghSetup();
    const result = await session.fetchPage(GH_ROOT);
    expect(result.text).toContain(`- parcelpost-alerts.yaml: ${RAW_SPEC}`);
    expect(result.text).not.toContain("https://github.com/someone-else/fork");
    expect(result.text).not.toContain("https://docs.github.com/en");
  });

  it("fetches a GitHub blob link as its raw file and starts long specs with an outline", async () => {
    const { session, fetcher, events } = ghSetup();
    const blob = "https://github.com/parcelpost/api-docs/blob/main/parcelpost-alerts.yaml";
    const result = await session.fetchPage(blob);

    expect(fetcher.requested).toEqual([RAW_SPEC]);
    expect(result.text).toContain("in 3 parts; this is part 1");
    expect(result.text).toContain("Unread parts: 2, 3");
    expect(result.text).toContain("SPEC OUTLINE");
    expect(result.text).toMatch(/- POST \/subscription\/\{type\}\/package: Create subscriptions by tracking number\. \(part [23]\)/);
    expect(result.text).toMatch(/- POST TrackingEvent: Tracking Event \(part 3\)/);
    // Quotes are verified against the full text, under the URL the agent gave and the one fetched.
    expect(session.pages.get(blob)?.text).toBe(SPEC.trim());
    expect(session.pages.get(RAW_SPEC)?.text).toBe(SPEC.trim());
    expect(session.visits[0]).toMatchObject({ url: RAW_SPEC, parts: 3, partsRead: 1, truncated: true });
    expect(events.find((e) => e.step === "page_fetched")?.detail).toMatch(/, part 1 of 3 \(1\/10\)$/);
  });

  it("serves later parts from the first fetch, each taking a page slot", async () => {
    const { session, fetcher, events } = ghSetup();
    await session.fetchPage(RAW_SPEC);
    const part3 = await session.fetchPage(RAW_SPEC, 3);

    expect(fetcher.requested).toEqual([RAW_SPEC]);
    expect(part3.text).toContain("this is part 3");
    expect(part3.text).toContain("Unread parts: 2.");
    expect(part3.text).toContain("TrackingEventPayload");
    expect(part3.text).not.toContain("SPEC OUTLINE");
    expect(part3.text).not.toContain("Same-site links");
    expect(part3.text).toContain("Pages fetched: 2/10");
    expect(events.filter((e) => e.step === "page_fetched").map((e) => e.detail)).toEqual([
      `Fetched ${RAW_SPEC}, part 1 of 3 (1/10)`,
      `Fetched ${RAW_SPEC}, part 3 of 3 (2/10)`,
    ]);

    await session.fetchPage(RAW_SPEC, 2);
    expect(session.visits[0]).toMatchObject({ partsRead: 3, truncated: false });
    session.reportUnreadParts();
    expect(events.some((e) => e.step === "page_truncated")).toBe(false);
  });

  it("does not resend a part or invent one", async () => {
    const { session } = ghSetup();
    await session.fetchPage(RAW_SPEC, 2);
    const again = await session.fetchPage(RAW_SPEC, 2);
    expect(again).toMatchObject({ isError: false, text: expect.stringContaining("Already fetched part 2 of") });
    expect(await session.fetchPage(RAW_SPEC, 9)).toMatchObject({ isError: true, text: expect.stringContaining("has 3 part(s)") });
    expect(await session.fetchPage(RAW_SPEC, 0)).toMatchObject({ isError: true });
    expect(session.pagesFetched).toBe(1);
  });

  it("fetches a page once when parts are requested in parallel", async () => {
    const { session, fetcher } = ghSetup();
    const results = await Promise.all([1, 2, 3].map((part) => session.fetchPage(RAW_SPEC, part)));
    expect(fetcher.requested).toEqual([RAW_SPEC]);
    expect(results.map((r) => /this is part (\d)/.exec(r.text)?.[1])).toEqual(["1", "2", "3"]);
    expect(session.pagesFetched).toBe(3);
  });

  it("counts parts toward the page limit", async () => {
    const { session } = ghSetup(2);
    await session.fetchPage(RAW_SPEC);
    await session.fetchPage(RAW_SPEC, 2);
    const third = await session.fetchPage(RAW_SPEC, 3);
    expect(third).toMatchObject({ isError: true, text: expect.stringContaining("Page limit of 2 reached") });
    expect(session.visits[0]).toMatchObject({ partsRead: 2, truncated: true });
  });
});

describe("goal mode", () => {
  it("ranks same-site links by the goal's keywords and lists matching sections", async () => {
    const session = new DocsSession(ACME_ROOT, createFixtureFetcher(), DEFAULT_CONFIG, createEmitter(() => {}), goalTerms("authenticate and receive webhooks"));
    const result = await session.fetchPage(ACME_ROOT);
    const links = result.text.split("ranked by goal keywords")[1]!.split("\n").filter((l) => l.startsWith("- "));

    expect(links[0]).toBe(`- [2: webhook] Webhooks: ${ACME_ROOT}webhooks`);
    // Unmatched links follow in page order, without a score; the page's own link is left out.
    expect(links.slice(1).map((l) => l.replace(/:.*/, ""))).toEqual(["- Endpoints", "- Rate limits", "- Dashboard", "- Status"]);
    expect(result.text).toContain("Sections on this page that match the goal: Authentication");
    expect(session.candidates[0]).toMatchObject({ url: `${ACME_ROOT}webhooks`, score: 2, foundOn: ACME_ROOT });
  });

  it("lists links in page order without a goal", async () => {
    const { session } = setup();
    const result = await session.fetchPage(ACME_ROOT);
    expect(result.text).toContain("Same-site links:\n- Endpoints:");
    expect(result.text).not.toContain("ranked");
    expect(session.candidates).toEqual([]);
  });
});

describe("splitParts", () => {
  it("splits at line breaks into parts no longer than the maximum, losing nothing", () => {
    const text = Array.from({ length: 40 }, (_, i) => `line ${i} ${"x".repeat(i % 7)}`).join("\n");
    const parts = splitParts(text, 50);
    expect(parts.map(([a, b]) => text.slice(a, b)).join("")).toBe(text);
    for (const [a, b] of parts) {
      expect(b - a).toBeLessThanOrEqual(50);
      if (b < text.length) expect(text[b - 1]).toBe("\n");
    }
  });

  it("cuts a line longer than the maximum, and keeps short text whole", () => {
    expect(splitParts("a".repeat(25), 10)).toEqual([[0, 10], [10, 20], [20, 25]]);
    expect(splitParts("short", 10)).toEqual([[0, 5]]);
  });
});

describe("createScoutMcpServer", () => {
  it("builds an in-process SDK MCP server", () => {
    const server = createScoutMcpServer(setup().session);
    expect(server.type).toBe("sdk");
    expect(server.name).toBe("scout");
  });
});
