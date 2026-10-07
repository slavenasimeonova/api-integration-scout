import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import type { Analysis } from "../src/core/schema.js";
import { runScout } from "../src/core/scout.js";
import { AUTH_ALTERNATIVES_FOLDER } from "../src/generators/postman.js";
import {
  apiSlug,
  buildMarkdown,
  buildOutputs,
  buildPostmanCollection,
  buildPostmanEnvironment,
  buildSequenceDiagram,
  validatePostmanCollection,
} from "../src/generators/index.js";
import { ACME_ROOT, createFixtureFetcher } from "./helpers/fixtures.js";
import { ACME_OUTPUT, fakeRunner } from "./helpers/fake-runner.js";

let analysis: Analysis;

beforeAll(async () => {
  const result = await runScout(ACME_ROOT, {
    config: DEFAULT_CONFIG,
    fetcher: createFixtureFetcher(),
    runner: fakeRunner([
      { fetch: ACME_ROOT },
      { fetch: "/endpoints" },
      { fetch: "/rate-limits" },
      { fetch: "/webhooks" },
      { result: "success", output: ACME_OUTPUT, usage: { input_tokens: 1200, output_tokens: 800, cache_read_input_tokens: 3000, cache_creation_input_tokens: 4000 }, costUsd: 0.0321 },
    ]),
  });
  // Pin volatile fields so snapshots are stable.
  analysis = { ...result, generatedAt: "2026-10-05T12:00:00.000Z", run: { ...result.run, startedAt: "2026-10-05T11:59:00.000Z" } };
});

describe("Postman collection", () => {
  it("is valid Postman Collection v2.1", () => {
    const result = validatePostmanCollection(buildPostmanCollection(analysis, "test-id"));
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("detects invalid collections", () => {
    const result = validatePostmanCollection({ info: { name: "x" }, item: "nope" });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("uses {{baseUrl}} and {{apiKey}} and the documented auth", () => {
    const c = buildPostmanCollection(analysis, "test-id");
    expect(c.variable).toEqual([
      { key: "baseUrl", value: "https://api.acmeweather.example/v2", type: "string" },
      { key: "apiKey", value: "", type: "string" },
    ]);
    expect(c.auth).toEqual({
      type: "apikey",
      apikey: [
        { key: "key", value: "X-Api-Key", type: "string" },
        { key: "value", value: "{{apiKey}}", type: "string" },
        { key: "in", value: "header", type: "string" },
      ],
    });
    const requests = c.item.filter((f) => f.name !== AUTH_ALTERNATIVES_FOLDER).flatMap((f) => f.item);
    expect(requests.map((r) => r.name)).toEqual([
      "GET /forecast",
      "GET /locations",
      "GET /locations/{id}",
      "POST /alerts (inferred)",
    ]);
    const byId = requests[2]!.request;
    expect(byId.url.raw).toBe("{{baseUrl}}/locations/:id");
    expect(byId.url.variable).toEqual([{ key: "id", value: "", description: "Location id" }]);
    expect(requests[0]!.request.url.raw).toBe("{{baseUrl}}/forecast?city=");
    // No example body in the analysis: no made-up body, and a note listing the documented fields.
    expect(requests[3]!.request.body).toBeUndefined();
    expect(requests[3]!.request.description).toContain("Body: not set.");
    expect(requests[3]!.request.description).toContain("- callback_url (required): Webhook URL");
  });

  it("keeps every documented auth method: primary as collection auth, others as sample requests", () => {
    const c = buildPostmanCollection(analysis, "test-id");
    expect(validatePostmanCollection(c).errors).toEqual([]);
    expect(c.auth).toMatchObject({ type: "apikey" });

    const folder = c.item.find((f) => f.name === AUTH_ALTERNATIVES_FOLDER)!;
    // Ranked by the auth rule: HTTP Basic before a query parameter.
    expect(folder.item.map((i) => i.name)).toEqual([
      "HTTP Basic auth: GET /forecast",
      "Token in query (?api_key=): GET /forecast",
    ]);
    const [basic, query] = folder.item.map((i) => i.request as Record<string, any>);
    expect(query!.url.raw).toBe("{{baseUrl}}/forecast?city=&api_key={{apiKey}}");
    expect(query!.auth).toEqual({ type: "noauth" });
    expect(query!.description).toContain('"may pass the key as the api_key query parameter instead"');
    expect(basic!.auth).toEqual({
      type: "basic",
      basic: [
        { key: "username", value: "{{apiKey}}", type: "string" },
        { key: "password", value: "", type: "string" },
      ],
    });
  });

  it("never adds an undocumented auth method", () => {
    // The fixture agent also claimed Bearer (fabricated quote) and OAuth (a guess).
    expect(analysis.authAlternatives.map((a) => a.value?.type)).toEqual(["basic", "api_key"]);
    expect(analysis.warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/Auth alternative "bearer in header \(Authorization\)" left out/),
        expect.stringMatching(/Auth alternative "oauth2" left out: .*\(inferred\)/),
      ]),
    );
    const json = JSON.stringify(buildPostmanCollection(analysis, "test-id"));
    expect(json).not.toMatch(/"type":"bearer"|"type":"oauth2"/);
  });

  it("supplies credential params through auth instead of empty query params", () => {
    const c = buildPostmanCollection(analysis, "test-id");
    const forecast = c.item.find((f) => f.name === "forecast")!.item[0]!.request;
    expect(forecast.url.query?.map((q) => q.key)).toEqual(["city", "units"]);
  });

  it("does not configure an inferred primary method; a documented alternative takes over", () => {
    const c = buildPostmanCollection(
      { ...analysis, auth: { ...analysis.auth, status: "inferred", reasoning: "guess" } },
      "test-id",
    );
    // The best-ranked documented alternative (Basic, ahead of the query parameter).
    expect(c.auth).toMatchObject({ type: "basic" });
    expect(c.item.find((f) => f.name === AUTH_ALTERNATIVES_FOLDER)!.item.map((i) => i.name)).toEqual([
      "Token in query (?api_key=): GET /forecast",
    ]);
  });

  it("leaves auth unset when no method is documented", () => {
    const c = buildPostmanCollection(
      { ...analysis, auth: { ...analysis.auth, status: "inferred" }, authAlternatives: [] },
      "test-id",
    );
    expect(c.auth).toBeUndefined();
    expect(c.info.description).toContain("not documented, so not configured");
  });

  it("handles endpoints given as full URLs (seen in a real IPinfo run)", () => {
    const ep = (path: string) => ({
      status: "documented" as const,
      value: { method: "GET" as const, path, purpose: "Lookup", keyParams: [{ name: "ip", in: "path" as const, required: true, description: "IP" }] },
      sources: [],
    });
    const c = buildPostmanCollection(
      { ...analysis, endpoints: [ep("https://ipinfo.io/{ip}/json"), ep("https://api.acmeweather.example/v2/stations/{ip}")] },
      "test-id",
    );
    expect(validatePostmanCollection(c).errors).toEqual([]);
    const other = c.item.find((f) => f.name === "ipinfo.io")!.item[0]!.request;
    expect(other.url.raw).toBe("https://ipinfo.io/:ip/json");
    expect(other.url).toMatchObject({ protocol: "https", host: ["ipinfo", "io"], path: [":ip", "json"] });
    expect(other.description).toContain("uses https://ipinfo.io, not {{baseUrl}}");
    // A full URL under the base URL becomes a normal {{baseUrl}} request.
    const same = c.item.find((f) => f.name === "stations")!.item[0]!.request;
    expect(same.url.raw).toBe("{{baseUrl}}/stations/:ip");
  });

  it("never contains real secrets", () => {
    const fakeKey = "sk-ant-test-SHOULD-NEVER-APPEAR";
    const original = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = fakeKey;
    try {
      const { files } = buildOutputs(analysis);
      for (const [name, content] of Object.entries(files)) {
        expect(content, name).not.toContain(fakeKey);
      }
    } finally {
      if (original === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = original;
    }
    const env = buildPostmanEnvironment(analysis, "env-id");
    expect(env.values.find((v) => v.key === "apiKey")).toEqual({ key: "apiKey", value: "", type: "secret", enabled: true });
  });
});

describe("buildOutputs", () => {
  it("renders all five files under a slug", () => {
    const out = buildOutputs(analysis);
    expect(out.slug).toBe("acme-weather");
    expect(Object.keys(out.files).sort()).toEqual([
      "analysis.json",
      "analysis.md",
      "postman_collection.json",
      "postman_environment.json",
      "sequence.mmd",
    ]);
    expect(JSON.parse(out.files["analysis.json"]!).schemaVersion).toBe(1);
  });

  it("falls back to the hostname for the slug", () => {
    expect(apiSlug({ apiName: "!!!", docsUrl: "https://docs.example.com/x" })).toBe("docs-example-com");
  });
});

describe("Mermaid sequence diagram", () => {
  it("covers auth, main call, errors, pagination and webhooks", () => {
    const mmd = buildSequenceDiagram(analysis);
    expect(mmd).toMatchSnapshot();
    expect(mmd.startsWith("sequenceDiagram\n")).toBe(true);
    expect(mmd).toContain("App->>API: GET /forecast");
    expect(mmd).toContain("loop Until no more pages (cursor)");
    expect(mmd).toContain("Verify signature");
    expect(mmd).not.toMatch(/;/);
  });

  it("says so when auth wasn't found", () => {
    const mmd = buildSequenceDiagram({ ...analysis, auth: { status: "not_found", value: null, sources: [] } });
    expect(mmd).toContain("Note over App,API: Auth not found in docs");
  });
});

describe("Markdown summary", () => {
  it("labels every finding and lists risks by severity", () => {
    const md = buildMarkdown(analysis);
    expect(md).toMatchSnapshot();
    expect(md).toContain(
      "| Authentication | api_key: API key in the X-Api-Key header (+2 documented alternatives) | Documented |",
    );
    // Every documented auth method is listed with its source quote.
    expect(md).toContain('> "sending your API key in the X-Api-Key header"');
    expect(md).toContain("#### 2. api_key in query (api_key)");
    expect(md).toContain('> "may pass the key as the api_key query parameter instead"');
    expect(md).toContain("#### 1. basic in header (Authorization)");
    expect(md).toContain('> "HTTP Basic authentication, with the API key as the username and an empty password"');
    // Rejected methods appear only as warnings/risks, never as auth methods.
    const authSections = md.slice(md.indexOf("### Authentication (primary)"), md.indexOf("### Endpoints"));
    expect(authSections).not.toMatch(/bearer|oauth2/i);
    expect(md).toContain('Auth alternative "oauth2" left out');
    expect(md).toContain("| Versioning | url_path (v2) | Inferred |");
    expect(md.indexOf("**HIGH**")).toBeLessThan(md.indexOf("**LOW**"));
    expect(md).toContain("Unverified claim: endpoints[3] POST /alerts");
  });

  it("shows 'Not found in docs' for missing findings", () => {
    const md = buildMarkdown({ ...analysis, rateLimits: { status: "not_found", value: null, sources: [] } });
    expect(md).toContain("| Rate limits | — | Not found in docs | — |");
  });
});
