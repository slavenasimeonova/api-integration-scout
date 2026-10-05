import { describe, expect, it } from "vitest";
import { extractPage, isSameSite, normalizeUrl } from "../src/core/html.js";
import { ACME_ROOT, readFixture } from "./helpers/fixtures.js";

describe("extractPage", () => {
  const page = extractPage(readFixture("index.html"), ACME_ROOT);

  it("extracts the title and readable main text", () => {
    expect(page.title).toBe("Acme Weather API — Overview");
    expect(page.text).toContain("All requests are made to https://api.acmeweather.example/v2.");
    expect(page.text).toContain('{ "error": { "code": "invalid_city", "message": "City not found" } }');
  });

  it("drops scripts and styles and keeps headings on their own lines", () => {
    expect(page.text).not.toContain("window.analytics");
    expect(page.text.split("\n")).toContain("Authentication");
  });

  it("resolves, de-duplicates and filters links", () => {
    const urls = page.links.map((l) => l.url);
    expect(urls).toContain("https://docs.acmeweather.example/endpoints");
    // #fragment stripped
    expect(urls).toContain("https://docs.acmeweather.example/rate-limits");
    // mailto and image links dropped
    expect(urls.some((u) => u.startsWith("mailto:"))).toBe(false);
    expect(urls.some((u) => u.endsWith(".png"))).toBe(false);
    expect(new Set(urls).size).toBe(urls.length);
  });

  it("flags JavaScript-only pages", () => {
    const spa = extractPage(readFixture("app.html"), ACME_ROOT + "app");
    expect(spa.text.length).toBeLessThan(50);
    expect(spa.looksClientRendered).toBe(true);
    expect(page.looksClientRendered).toBe(false);
  });

  it("detects empty SPA mount points but not filled ones", () => {
    const empty = extractPage('<body><div id="__next"></div><p>Loading</p></body>', ACME_ROOT);
    const filled = extractPage('<body><div id="root"><h1>Docs</h1><p>Real content</p></div></body>', ACME_ROOT);
    expect(empty.looksClientRendered).toBe(true);
    expect(filled.looksClientRendered).toBe(false);
  });
});

describe("isSameSite", () => {
  it("allows the same host and parent/child subdomains", () => {
    expect(isSameSite("https://docs.acmeweather.example/x", ACME_ROOT)).toBe(true);
    expect(isSameSite("https://status.docs.acmeweather.example/", ACME_ROOT)).toBe(true);
    expect(isSameSite("https://stripe.com/docs/api", "https://docs.stripe.com/")).toBe(true);
    expect(isSameSite("https://www.stripe.com/", "https://stripe.com/")).toBe(true);
  });

  it("rejects other sites and sibling subdomains on shared hosts", () => {
    expect(isSameSite("https://twitter.com/acmeweather", ACME_ROOT)).toBe(false);
    expect(isSameSite("https://evil.github.io/", "https://good.github.io/")).toBe(false);
    expect(isSameSite("not a url", ACME_ROOT)).toBe(false);
  });
});

describe("normalizeUrl", () => {
  it("resolves relative links and rejects non-http schemes", () => {
    expect(normalizeUrl("../a?b=1#c", "https://x.example/docs/page")).toBe("https://x.example/a?b=1");
    expect(normalizeUrl("javascript:void(0)", "https://x.example/")).toBeNull();
  });
});
