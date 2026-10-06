import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import type { Analysis } from "../src/core/schema.js";
import { runScout } from "../src/core/scout.js";
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
    const requests = c.item.flatMap((f) => f.item);
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
    expect(requests[3]!.request.body?.raw).toContain('"callback_url": "<callback_url>"');
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
    expect(md).toContain("| Authentication | api_key: API key in the X-Api-Key header | Documented |");
    expect(md).toContain("| Versioning | url_path (v2) | Inferred |");
    expect(md.indexOf("**HIGH**")).toBeLessThan(md.indexOf("**LOW**"));
    expect(md).toContain("Unverified claim: endpoints[3] POST /alerts");
  });

  it("shows 'Not found in docs' for missing findings", () => {
    const md = buildMarkdown({ ...analysis, rateLimits: { status: "not_found", value: null, sources: [] } });
    expect(md).toContain("| Rate limits | — | Not found in docs | — |");
  });
});
