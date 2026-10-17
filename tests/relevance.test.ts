import { describe, expect, it } from "vitest";
import type { Fetcher } from "../src/core/fetcher.js";
import {
  buildDiscovery,
  goalTerms,
  matchingHeadings,
  normalizeGoal,
  robotsSitemaps,
  scoreLink,
  sitemapLocations,
  stem,
} from "../src/core/relevance.js";
import type { PageVisit } from "../src/core/schema.js";
import { discoverSitemap } from "../src/core/sitemap.js";

const UPS_GOAL = "Track Alert: subscribe to tracking events for a shipment and receive status updates by webhook";
const SPECS = "https://github.com/UPS-API/api-documentation/blob/main/";

describe("normalizeGoal", () => {
  it("collapses whitespace and control characters", () => {
    expect(normalizeGoal("  Track\n\tAlert \u0007 webhook  ")).toBe("Track Alert webhook");
  });

  it("treats an empty goal as no goal and rejects long ones", () => {
    expect(normalizeGoal(undefined)).toBeUndefined();
    expect(normalizeGoal("   \n ")).toBeUndefined();
    expect(() => normalizeGoal("x".repeat(301))).toThrow("the limit is 300");
  });
});

describe("goalTerms and stem", () => {
  it("keeps the goal's keywords, stemmed, without stopwords or duplicates", () => {
    expect(goalTerms(UPS_GOAL)).toEqual(["track", "alert", "subscri", "event", "shipmen", "statu", "updat", "webhook"]);
  });

  it("brings word forms together", () => {
    expect(new Set(["subscribe", "subscription", "subscriptions"].map(stem)).size).toBe(1);
    expect(stem("tracking")).toBe(stem("track"));
    expect(stem("updates")).toBe(stem("update"));
    expect(stem("webhooks")).toBe("webhook");
  });
});

describe("scoreLink", () => {
  const terms = goalTerms(UPS_GOAL);

  it("ranks the goal's spec above unrelated ones, splitting camelCase file names", () => {
    const score = (name: string) => scoreLink({ url: SPECS + name, text: name }, terms).score;
    expect(score("UPSTrackAlert.yaml")).toBe(4);
    expect(score("Tracking.yaml")).toBe(2);
    expect(score("Shipping.yaml")).toBe(0);
    expect(score("Pickup.yaml")).toBe(0);
  });

  it("weighs link text above the URL path and ignores the host and query", () => {
    expect(scoreLink({ url: "https://docs.example/webhooks", text: "Webhooks" }, terms)).toEqual({ score: 2, matched: ["webhook"] });
    expect(scoreLink({ url: "https://docs.example/webhooks", text: "Next" }, terms)).toEqual({ score: 1, matched: ["webhook"] });
    expect(scoreLink({ url: "https://webhook.example/x?topic=webhook", text: "" }, terms).score).toBe(0);
  });

  it("always gives authentication pages a point", () => {
    expect(scoreLink({ url: SPECS + "OAuthClientCredentials.yaml", text: "OAuthClientCredentials.yaml" }, terms)).toEqual({
      score: 1,
      matched: ["auth"],
    });
    expect(scoreLink({ url: "https://docs.example/authentication", text: "Authentication" }, terms).matched).toEqual(["auth"]);
  });
});

describe("matchingHeadings", () => {
  it("returns the headings that mention a goal keyword", () => {
    const terms = goalTerms("verify webhook signatures");
    expect(matchingHeadings(["Overview", "Webhook events", "Signature verification", "Errors"], terms)).toEqual([
      "Webhook events",
      "Signature verification",
    ]);
  });
});

describe("sitemap parsing", () => {
  it("reads <loc> entries and robots.txt Sitemap lines", () => {
    const xml = `<?xml version="1.0"?><urlset><url><loc> https://docs.example/a?x=1&amp;y=2 </loc></url><url><loc>https://docs.example/b</loc></url></urlset>`;
    expect(sitemapLocations(xml)).toEqual(["https://docs.example/a?x=1&y=2", "https://docs.example/b"]);
    expect(robotsSitemaps("User-agent: *\nDisallow: /x\nSitemap: https://docs.example/s1.xml\nsitemap:https://docs.example/s2.xml")).toEqual([
      "https://docs.example/s1.xml",
      "https://docs.example/s2.xml",
    ]);
  });
});

/** A fake site: robots.txt -> a sitemap index -> two sitemaps (one off-site). */
function siteFetcher(files: Record<string, string>): Fetcher & { requested: string[] } {
  const requested: string[] = [];
  const fetcher: Fetcher = async (url) => {
    requested.push(url);
    const body = files[url];
    return body === undefined
      ? { finalUrl: url, status: 404, contentType: "text/plain", body: "" }
      : { finalUrl: url, status: 200, contentType: "application/xml", body };
  };
  return Object.assign(fetcher, { requested });
}

describe("discoverSitemap", () => {
  it("follows robots.txt to a sitemap index and keeps only same-site pages", async () => {
    const fetcher = siteFetcher({
      "https://docs.example/robots.txt": "Sitemap: https://docs.example/sitemap-index.xml\nSitemap: https://evil.example/s.xml",
      "https://docs.example/sitemap-index.xml":
        "<sitemapindex><sitemap><loc>https://docs.example/s1.xml</loc></sitemap><sitemap><loc>https://other.example/s.xml</loc></sitemap></sitemapindex>",
      "https://docs.example/s1.xml":
        "<urlset><url><loc>https://docs.example/webhooks</loc></url><url><loc>https://elsewhere.example/x</loc></url></urlset>",
    });
    const result = await discoverSitemap("https://docs.example/start", fetcher);
    expect(result).toEqual({
      sitemaps: ["https://docs.example/sitemap-index.xml", "https://docs.example/s1.xml"],
      urls: ["https://docs.example/webhooks"],
    });
    expect(fetcher.requested).not.toContain("https://evil.example/s.xml");
    expect(fetcher.requested).not.toContain("https://other.example/s.xml");
  });

  it("falls back to /sitemap.xml and ignores pages that aren't sitemaps", async () => {
    const fetcher = siteFetcher({ "https://docs.example/sitemap.xml": "<html>Not found</html>" });
    expect(await discoverSitemap("https://docs.example/", fetcher)).toEqual({ sitemaps: [], urls: [] });
    expect(fetcher.requested).toEqual(["https://docs.example/robots.txt", "https://docs.example/sitemap.xml"]);
  });

  it("reads at most three sitemap files", async () => {
    const files: Record<string, string> = {
      "https://docs.example/sitemap.xml": `<sitemapindex>${[1, 2, 3, 4, 5].map((i) => `<sitemap><loc>https://docs.example/s${i}.xml</loc></sitemap>`).join("")}</sitemapindex>`,
    };
    for (const i of [1, 2, 3, 4, 5]) files[`https://docs.example/s${i}.xml`] = `<urlset><url><loc>https://docs.example/p${i}</loc></url></urlset>`;
    const result = await discoverSitemap("https://docs.example/", siteFetcher(files));
    expect(result.sitemaps).toHaveLength(3);
    expect(result.urls).toEqual(["https://docs.example/p1", "https://docs.example/p2"]);
  });

  it("is skipped for docs on GitHub", async () => {
    const fetcher = siteFetcher({});
    expect(await discoverSitemap("https://github.com/UPS-API/api-documentation", fetcher)).toEqual({ sitemaps: [], urls: [] });
    expect(fetcher.requested).toEqual([]);
  });

  it("never throws when the fetcher fails", async () => {
    const failing: Fetcher = async () => {
      throw new Error("blocked");
    };
    expect(await discoverSitemap("https://docs.example/", failing)).toEqual({ sitemaps: [], urls: [] });
  });
});

describe("buildDiscovery", () => {
  const terms = goalTerms(UPS_GOAL);
  const RAW = "https://raw.githubusercontent.com/UPS-API/api-documentation/main/";
  const visit = (url: string, extra: Partial<PageVisit> = {}): PageVisit => ({ url, status: "fetched", textLength: 1000, lowText: false, truncated: false, ...extra });
  const candidate = (name: string, score: number, matched: string[]) => ({ url: RAW + name, text: name, score, matched, foundOn: "x" });

  it("lists pages read, then the best unread candidates, with the agent's reasons", () => {
    const { discovery, dropped } = buildDiscovery({
      terms,
      visits: [visit("https://github.com/UPS-API/api-documentation"), visit(RAW + "UPSTrackAlert.yaml", { truncated: true, parts: 3, partsRead: 2 })],
      candidates: [candidate("UPSTrackAlert.yaml", 4, ["track", "alert"]), candidate("Tracking.yaml", 2, ["track"]), candidate("Pickup.yaml", 0, [])],
      notes: [
        { url: SPECS + "UPSTrackAlert.yaml", relevant: true, reason: "Subscription endpoint and webhook." },
        { url: RAW + "Tracking.yaml", relevant: false, reason: "Polling API; the goal uses webhooks." },
        { url: RAW + "Pickup.yaml", relevant: false, reason: "Pickups, not tracking." },
        { url: "https://made-up.example/page", relevant: true, reason: "Never seen." },
      ],
      sitemap: null,
    });
    expect(discovery.pages).toEqual([
      { url: "https://github.com/UPS-API/api-documentation", score: 0, matched: [], read: "read" },
      { url: RAW + "UPSTrackAlert.yaml", score: 4, matched: ["track", "alert"], read: "partly", relevant: true, reason: "Subscription endpoint and webhook." },
      { url: RAW + "Tracking.yaml", score: 2, matched: ["track"], read: "not_read", relevant: false, reason: "Polling API; the goal uses webhooks." },
      // Seen with score 0 and skipped on purpose: kept because the agent explained it.
      { url: RAW + "Pickup.yaml", score: 0, matched: [], read: "not_read", relevant: false, reason: "Pickups, not tracking." },
    ]);
    expect(dropped).toEqual(["https://made-up.example/page"]);
  });

  it("keeps the report short", () => {
    const many = Array.from({ length: 40 }, (_, i) => candidate(`Spec${i}.yaml`, 1, ["auth"]));
    const { discovery } = buildDiscovery({ terms, visits: [], candidates: many, notes: undefined, sitemap: null });
    expect(discovery.pages).toHaveLength(25);
  });
});
