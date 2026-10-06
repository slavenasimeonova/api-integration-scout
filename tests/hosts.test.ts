import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import type { ProgressEvent } from "../src/core/events.js";
import { checkEndpointHosts } from "../src/core/hosts.js";
import type { Analysis, Endpoint, Finding } from "../src/core/schema.js";
import { runScout } from "../src/core/scout.js";
import { buildMarkdown, buildPostmanCollection, validatePostmanCollection } from "../src/generators/index.js";
import { CHECK_HOST_FLAG } from "../src/generators/postman.js";
import { ACME_ROOT, createFixtureFetcher } from "./helpers/fixtures.js";
import { ACME_OUTPUT, fakeRunner } from "./helpers/fake-runner.js";

const MORE = "https://docs.acmeweather.example/more-endpoints";

function endpoint(path: string, quote: string, url = MORE): Finding<Endpoint> {
  return {
    status: "documented",
    value: { method: "GET", path, purpose: "Test", keyParams: [] },
    sources: [{ url, quote }],
  };
}

describe("checkEndpointHosts", () => {
  it("corrects the IPinfo case: relative path, example URL on another host", () => {
    const [ep] = checkEndpointHosts(
      [endpoint("/{ip}/json", "curl https://ipinfo.io/8.8.8.8/json?token=$TOKEN")],
      "https://api.ipinfo.io",
    );
    expect(ep!.value!.path).toBe("https://ipinfo.io/{ip}/json");
    expect(ep!.hostCheck).toEqual({
      status: "corrected",
      from: "/{ip}/json",
      to: "https://ipinfo.io/{ip}/json",
      evidence: "curl https://ipinfo.io/8.8.8.8/json?token=$TOKEN",
    });
  });

  it("keeps a version prefix found on the other host", () => {
    const [ep] = checkEndpointHosts(
      [endpoint("/stations/{id}/json", "see https://legacy.example.com/v1/stations/42/json.")],
      "https://api.example.com/v2",
    );
    expect(ep!.value!.path).toBe("https://legacy.example.com/v1/stations/{id}/json");
  });

  it("leaves endpoints alone when the quote shows the base host, no URL, or an unrelated URL", () => {
    const base = "https://api.example.com/v2";
    const input = [
      endpoint("/alerts/{id}", "for example https://api.example.com/v2/alerts/7"),
      endpoint("/forecast", "Returns a 7-day forecast for a city."),
      endpoint("/history", "During outages, see https://status.example.com/incidents."),
    ];
    const out = checkEndpointHosts(input, base);
    expect(out).toEqual(input);
  });

  it("marks an endpoint ambiguous when the docs show it on more than one host", () => {
    const [ep] = checkEndpointHosts(
      [endpoint("/radar/{region}", "https://tiles.example.com/radar/eu and https://api.example.com/v2/radar/eu")],
      "https://api.example.com/v2",
    );
    expect(ep!.value!.path).toBe("/radar/{region}");
    expect(ep!.hostCheck).toMatchObject({
      status: "ambiguous",
      candidates: ["https://api.example.com/v2", "https://tiles.example.com"],
    });
  });

  it("marks two different other hosts as ambiguous too", () => {
    const [ep] = checkEndpointHosts(
      [
        {
          ...endpoint("/x/{id}", "https://a.example.com/x/1"),
          sources: [
            { url: MORE, quote: "https://a.example.com/x/1" },
            { url: MORE, quote: "https://b.example.com/x/2" },
          ],
        },
      ],
      null,
    );
    expect(ep!.hostCheck).toMatchObject({ status: "ambiguous", candidates: ["https://a.example.com", "https://b.example.com"] });
  });
});

describe("host safeguard in a full run (offline fixture)", () => {
  let analysis: Analysis;
  const events: ProgressEvent[] = [];

  beforeAll(async () => {
    const output = structuredClone(ACME_OUTPUT);
    output.endpoints.push(
      // The agent returns relative paths for all of these, as in the real IPinfo run.
      endpoint("/stations/{id}/json", "curl https://legacy.acmeweather.example/stations/42/json"),
      {
        ...endpoint("/radar/{region}", ""),
        sources: [
          { url: MORE, quote: "Radar tiles, for example https://tiles.acmeweather.example/radar/eu." },
          { url: MORE, quote: "also available at https://api.acmeweather.example/v2/radar/eu" },
        ],
      },
      endpoint("/alerts/{id}", "for example https://api.acmeweather.example/v2/alerts/7"),
      endpoint("/history", "During outages, see https://status.acmeweather.example/incidents."),
      // Fabricated quote naming another host: removed by verification, so it must not move the endpoint.
      endpoint("/archive/{year}", "curl https://archive.acmeweather.example/archive/2020"),
    );
    analysis = await runScout(ACME_ROOT, {
      config: DEFAULT_CONFIG,
      fetcher: createFixtureFetcher(),
      onEvent: (e) => events.push(e),
      runner: fakeRunner([
        { fetch: ACME_ROOT },
        { fetch: "/endpoints" },
        { fetch: "/rate-limits" },
        { fetch: "/webhooks" },
        { fetch: "/more-endpoints" },
        { result: "success", output },
      ]),
    });
  });

  const byPath = (suffix: string) => analysis.endpoints.find((e) => e.value?.path.endsWith(suffix))!;

  it("uses the host from the verified quote", () => {
    expect(byPath("/stations/{id}/json").value!.path).toBe("https://legacy.acmeweather.example/stations/{id}/json");
    expect(events).toContainEqual(
      expect.objectContaining({
        step: "endpoint_host_corrected",
        from: "/stations/{id}/json",
        to: "https://legacy.acmeweather.example/stations/{id}/json",
      }),
    );
    expect(analysis.warnings).toContainEqual(expect.stringMatching(/^Endpoint GET \/stations\/\{id\}\/json: host corrected/));
  });

  it("warns about and flags an ambiguous host", () => {
    const radar = byPath("/radar/{region}");
    expect(radar.value!.path).toBe("/radar/{region}");
    expect(radar.hostCheck).toMatchObject({
      status: "ambiguous",
      candidates: ["https://api.acmeweather.example/v2", "https://tiles.acmeweather.example"],
    });
    expect(events).toContainEqual(expect.objectContaining({ step: "endpoint_host_ambiguous", endpoint: "GET /radar/{region}" }));
    expect(analysis.warnings).toContainEqual(expect.stringMatching(/host is ambiguous.*flagged \[CHECK HOST\]/));
    expect(analysis.risks).toContainEqual(
      expect.objectContaining({ origin: "verification", title: "Unclear host for GET /radar/{region}" }),
    );
  });

  it("ignores base-host URLs, unrelated URLs and unverified quotes", () => {
    expect(byPath("/alerts/{id}").hostCheck).toBeUndefined();
    expect(byPath("/history").hostCheck).toBeUndefined();
    const archive = byPath("/archive/{year}");
    expect(archive.status).toBe("inferred");
    expect(archive.value!.path).toBe("/archive/{year}");
    expect(archive.hostCheck).toBeUndefined();
  });

  it("puts corrected and flagged endpoints into a valid Postman collection", () => {
    const c = buildPostmanCollection(analysis, "test-id");
    expect(validatePostmanCollection(c).errors).toEqual([]);

    const legacy = c.item.find((f) => f.name === "legacy.acmeweather.example")!.item[0]!;
    expect(legacy.request.url.raw).toBe("https://legacy.acmeweather.example/stations/:id/json");
    expect(legacy.request.description).toContain("Host taken from the docs' example URL");

    const radar = c.item.flatMap((f) => f.item).find((i) => i.name.includes("/radar/"))!;
    expect(radar.name).toBe(`${CHECK_HOST_FLAG} GET /radar/{region}`);
    expect(radar.request.url.raw).toBe("{{baseUrl}}/radar/:region");
    expect(radar.request.description).toMatch(
      /^WARNING: host is ambiguous\. The docs show this endpoint on: https:\/\/api\.acmeweather\.example\/v2, https:\/\/tiles\.acmeweather\.example\./,
    );
  });

  it("notes the host status in analysis.md", () => {
    const md = buildMarkdown(analysis);
    expect(md).toContain(
      "`/radar/{region}` **(host unclear: https://api.acmeweather.example/v2, https://tiles.acmeweather.example)**",
    );
    expect(md).toContain("`https://legacy.acmeweather.example/stations/{id}/json` (host from the docs' example URL)");
  });
});
