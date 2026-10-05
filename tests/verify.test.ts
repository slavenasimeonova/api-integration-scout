import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { createEmitter } from "../src/core/events.js";
import type { AgentOutput } from "../src/core/schema.js";
import { DocsSession } from "../src/core/tools.js";
import { normalizeForMatch, quoteAppearsIn, verifyAnalysis } from "../src/core/verify.js";
import { ACME_ROOT, createFixtureFetcher } from "./helpers/fixtures.js";

const RATE_URL = "https://docs.acmeweather.example/rate-limits";
const HOOKS_URL = "https://docs.acmeweather.example/webhooks";

let session: DocsSession;
beforeAll(async () => {
  session = new DocsSession(ACME_ROOT, createFixtureFetcher(), DEFAULT_CONFIG, createEmitter(undefined));
  for (const path of ["/", "/endpoints", "/rate-limits", "/webhooks"]) await session.fetchPage(path);
});

const notFound = { status: "not_found" as const, value: null, sources: [] };

function output(overrides: Partial<AgentOutput>): AgentOutput {
  return {
    apiName: "Acme Weather",
    summary: "Weather data.",
    baseUrl: notFound,
    auth: notFound,
    endpoints: [],
    pagination: notFound,
    rateLimits: notFound,
    webhooks: notFound,
    errorFormat: notFound,
    versioning: notFound,
    risks: [],
    openQuestions: [],
    ...overrides,
  };
}

describe("normalizeForMatch", () => {
  it("ignores case, whitespace, punctuation and unicode spacing variants", () => {
    expect(normalizeForMatch("  60 Requests   per\nMinute. ")).toBe("60 requests per minute");
    expect(normalizeForMatch("HMAC‑SHA256")).toBe(normalizeForMatch("hmac-sha256"));
    expect(normalizeForMatch("“X-Api-Key” header")).toBe(normalizeForMatch('"X-Api-Key" header'));
  });
});

describe("quoteAppearsIn", () => {
  it("matches a correct quote despite formatting differences in the page", () => {
    // The fixture splits this across lines, wraps part in <strong>, and uses &nbsp;.
    const page = session.pages.get(RATE_URL)!.text;
    expect(quoteAppearsIn("Each API key may make 60 requests per minute.", page)).toBe(true);
    expect(quoteAppearsIn("each api key MAY MAKE 60 requests-per-minute", page)).toBe(true);
    // The fixture uses a non-breaking hyphen (&#8209;) here.
    expect(quoteAppearsIn("an HMAC-SHA256 of the raw body", session.pages.get(HOOKS_URL)!.text)).toBe(true);
  });

  it("rejects altered or trivially short quotes", () => {
    const page = session.pages.get(RATE_URL)!.text;
    expect(quoteAppearsIn("Each API key may make 100 requests per minute", page)).toBe(false);
    expect(quoteAppearsIn("key", page)).toBe(false);
    // Whole words only: "60 req" must not match "60 requests".
    expect(quoteAppearsIn("may make 60 req", page)).toBe(false);
  });
});

describe("verifyAnalysis", () => {
  it("keeps a documented finding whose quote matches after normalization", () => {
    const { output: out, downgrades } = verifyAnalysis(
      output({
        rateLimits: {
          status: "documented",
          value: { limits: "60/min per key", headers: ["X-RateLimit-Remaining"], description: "" },
          sources: [{ url: RATE_URL + "#limits", quote: "60 requests per minute" }],
        },
      }),
      session.pages,
    );
    expect(downgrades).toEqual([]);
    expect(out.rateLimits.status).toBe("documented");
    expect(out.rateLimits.sources[0]).toEqual({ url: RATE_URL, quote: "60 requests per minute" });
  });

  it("downgrades a fabricated quote to inferred and removes the quote", () => {
    const { output: out, downgrades } = verifyAnalysis(
      output({
        rateLimits: {
          status: "documented",
          value: { limits: "1000/day", headers: [], description: "" },
          sources: [{ url: RATE_URL, quote: "Each key is limited to 1000 requests per day" }],
        },
      }),
      session.pages,
    );
    expect(out.rateLimits.status).toBe("inferred");
    expect(out.rateLimits.sources).toEqual([{ url: RATE_URL }]);
    expect(out.rateLimits.reasoning).toMatch(/Downgraded from documented: quote not found/);
    expect(downgrades).toEqual([{ field: "rateLimits", reason: `quote not found on ${RATE_URL}` }]);
  });

  it("downgrades claims citing pages that were never fetched or no source at all", () => {
    const { output: out, downgrades } = verifyAnalysis(
      output({
        baseUrl: { status: "documented", value: "https://api.acmeweather.example/v2", sources: [] },
        versioning: {
          status: "documented",
          value: { scheme: "url_path", description: "" },
          sources: [{ url: "https://docs.acmeweather.example/changelog", quote: "v2 is current" }],
        },
      }),
      session.pages,
    );
    expect(out.baseUrl.status).toBe("inferred");
    expect(out.versioning.status).toBe("inferred");
    expect(downgrades.map((d) => d.field)).toEqual(["baseUrl", "versioning"]);
  });

  it("checks endpoints and keeps one verified source among several", () => {
    const { output: out, downgrades } = verifyAnalysis(
      output({
        endpoints: [
          {
            status: "documented",
            value: { method: "GET", path: "/forecast", purpose: "7-day forecast", keyParams: [] },
            sources: [
              { url: "https://docs.acmeweather.example/endpoints", quote: "Returns a 7-day forecast for a city." },
              { url: ACME_ROOT, quote: "made-up sentence that is not on the page" },
            ],
          },
          {
            status: "documented",
            value: { method: "DELETE", path: "/alerts/{id}", purpose: "Delete alert", keyParams: [] },
            sources: [{ url: "https://docs.acmeweather.example/endpoints", quote: "Deletes an alert subscription" }],
          },
        ],
      }),
      session.pages,
    );
    expect(out.endpoints[0]?.status).toBe("documented");
    expect(out.endpoints[0]?.sources).toHaveLength(2);
    expect(out.endpoints[0]?.sources[1]?.quote).toBeUndefined();
    expect(out.endpoints[1]?.status).toBe("inferred");
    expect(downgrades).toEqual([
      { field: "endpoints[1] DELETE /alerts/{id}", reason: "quote not found on https://docs.acmeweather.example/endpoints" },
    ]);
  });

  it("forces not_found values to null", () => {
    const { output: out } = verifyAnalysis(
      output({ pagination: { status: "not_found", value: { style: "none", parameters: [], description: "" }, sources: [] } }),
      session.pages,
    );
    expect(out.pagination.value).toBeNull();
  });
});
