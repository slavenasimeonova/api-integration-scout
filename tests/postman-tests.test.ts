import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import type { Analysis } from "../src/core/schema.js";
import { runScout } from "../src/core/scout.js";
import { AUTH_ALTERNATIVES_FOLDER, buildPostmanCollection } from "../src/generators/postman.js";
import { validatePostmanCollection } from "../src/generators/postman-validate.js";
import { ACME_ROOT, createFixtureFetcher } from "./helpers/fixtures.js";
import { ACME_OUTPUT, fakeRunner } from "./helpers/fake-runner.js";

let acme: Analysis;

beforeAll(async () => {
  acme = await runScout(ACME_ROOT, {
    config: DEFAULT_CONFIG,
    fetcher: createFixtureFetcher(),
    runner: fakeRunner([{ fetch: ACME_ROOT }, { fetch: "/endpoints" }, { result: "success", output: ACME_OUTPUT }]),
  });
});

type Item = { name: string; event?: { listen: string; script: { exec: string[] } }[] };

function items(analysis: Analysis): Item[] {
  return buildPostmanCollection(analysis, "test-id").item.flatMap((f) => f.item as Item[]);
}

const script = (item: Item) => item.event?.find((e) => e.listen === "test")?.script.exec.join("\n") ?? "";

describe("Postman test scripts", () => {
  it("adds status and response-time tests to every request, including auth alternatives", () => {
    const c = buildPostmanCollection(acme, "test-id");
    expect(validatePostmanCollection(c).errors).toEqual([]);
    const all = c.item.flatMap((f) => f.item as Item[]);
    expect(c.item.some((f) => f.name === AUTH_ALTERNATIVES_FOLDER)).toBe(true);
    for (const item of all) {
      expect(script(item), item.name).toContain('pm.test("Status is 2xx"');
      expect(script(item), item.name).toContain("to.be.within(200, 299)");
      expect(script(item), item.name).toContain('pm.variables.get("maxResponseMs")');
    }
    expect(c.variable).toContainEqual({ key: "maxResponseMs", value: "5000", type: "string" });
  });

  it("never asserts response fields", () => {
    for (const item of items(acme)) {
      expect(script(item)).not.toMatch(/json\(\)\s*\.|\.property\(|jsonData|\.have\.(keys|property)/);
    }
  });

  it("adds no JSON test without documented evidence (error-format quotes don't count)", () => {
    // Acme's only JSON quote is its error format.
    for (const item of items(acme)) expect(script(item)).not.toContain("Response is JSON");
  });

  it("adds the JSON test for an endpoint whose verified quote mentions JSON, or whose path ends in /json or .json", () => {
    const [forecast, ...rest] = acme.endpoints;
    const analysis: Analysis = {
      ...acme,
      endpoints: [
        { ...forecast!, sources: [{ url: `${ACME_ROOT}endpoints`, quote: "Returns the forecast as JSON." }] },
        { status: "documented", value: { method: "GET", path: "/{ip}/json", purpose: "Lookup", keyParams: [] }, sources: [] },
        ...rest,
      ],
    };
    const byName = new Map(items(analysis).map((i) => [i.name, script(i)]));
    expect(byName.get("GET /forecast")).toContain('pm.test("Response is JSON"');
    expect(byName.get("GET /{ip}/json")).toContain('pm.test("Response is JSON"');
    expect(byName.get("GET /locations")).not.toContain("Response is JSON");
  });

  it("adds the JSON test to every request when a documented finding says responses are JSON", () => {
    const analysis: Analysis = {
      ...acme,
      baseUrl: { ...acme.baseUrl, sources: [{ url: ACME_ROOT, quote: "All responses are returned as JSON objects" }] },
    };
    for (const item of items(analysis)) expect(script(item), item.name).toContain("Response is JSON");
  });

  it("ignores 'json' inside URLs in quotes", () => {
    const [forecast, ...rest] = acme.endpoints;
    const analysis: Analysis = {
      ...acme,
      endpoints: [{ ...forecast!, sources: [{ url: `${ACME_ROOT}endpoints`, quote: "curl https://api.acmeweather.example/v2/json-export/forecast" }] }, ...rest],
    };
    expect(script(items(analysis)[0]!)).not.toContain("Response is JSON");
  });

  it("never puts text from the docs into a script", () => {
    const hostile = 'x"); pm.environment.set("apiKey", "stolen"); //';
    const analysis: Analysis = {
      ...acme,
      endpoints: acme.endpoints.map((e) => (e.value ? { ...e, value: { ...e.value, purpose: hostile } } : e)),
    };
    for (const item of items(analysis)) expect(script(item)).not.toContain("stolen");
  });
});
