import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import type { ProgressEvent } from "../src/core/events.js";
import { pathVariableExamples } from "../src/core/hosts.js";
import type { AgentOutput, Analysis } from "../src/core/schema.js";
import { runScout } from "../src/core/scout.js";
import { buildPostmanCollection } from "../src/generators/postman.js";
import { ACME_ROOT, createFixtureFetcher } from "./helpers/fixtures.js";
import { ACME_OUTPUT, fakeRunner } from "./helpers/fake-runner.js";

const D = "https://docs.acmeweather.example";
const BODY = '{"location_id": "loc_123", "callback_url": "https://example.com/hooks/acme"}';

function withEndpoints(endpoints: AgentOutput["endpoints"]): AgentOutput {
  return { ...ACME_OUTPUT, endpoints };
}

async function scout(output: AgentOutput) {
  const events: ProgressEvent[] = [];
  const analysis = await runScout(ACME_ROOT, {
    config: DEFAULT_CONFIG,
    fetcher: createFixtureFetcher(),
    runner: fakeRunner([{ fetch: ACME_ROOT }, { fetch: "/endpoints" }, { result: "success", output }]),
    onEvent: (e) => events.push(e),
  });
  return { analysis, events };
}

function requests(analysis: Analysis) {
  return buildPostmanCollection(analysis, "test-id").item.flatMap((f) => f.item);
}

const alerts = (exampleBody?: string): AgentOutput["endpoints"][number] => ({
  status: "documented",
  value: {
    method: "POST",
    path: "/alerts",
    purpose: "Subscribe to alerts",
    keyParams: [{ name: "callback_url", in: "body", required: true, description: "Webhook URL" }],
    ...(exampleBody !== undefined ? { exampleBody } : {}),
  },
  sources: [{ url: `${D}/endpoints`, quote: "Creates a severe-weather alert subscription." }],
});

describe("example request bodies", () => {
  it("uses a documented example body verbatim in Postman", async () => {
    const { analysis } = await scout(withEndpoints([alerts(BODY)]));
    expect(analysis.endpoints[0]!.value!.exampleBody).toBe(BODY);
    const req = requests(analysis)[0]!.request;
    expect(req.body).toEqual({ mode: "raw", raw: BODY, options: { raw: { language: "json" } } });
    expect(req.header).toContainEqual({ key: "Content-Type", value: "application/json" });
    expect(req.description).toContain("Body: example copied from the docs");
  });

  it("drops an example body that isn't on the cited page, says so, and sets no body", async () => {
    const made_up = '{"location_id": "abc", "callback_url": "https://my.app/hook", "severity": "high"}';
    const { analysis, events } = await scout(withEndpoints([alerts(made_up)]));
    expect(analysis.endpoints[0]!.value!.exampleBody).toBeUndefined();
    // The endpoint itself stays documented: only the body claim failed.
    expect(analysis.endpoints[0]!.status).toBe("documented");
    expect(events).toContainEqual(expect.objectContaining({ step: "verification_downgrade", field: "endpoints[0] POST /alerts example body" }));
    expect(analysis.risks).toContainEqual(expect.objectContaining({ title: "Unverified claim: endpoints[0] POST /alerts example body" }));

    const req = requests(analysis)[0]!.request;
    expect(req.body).toBeUndefined();
    expect(req.header).not.toContainEqual(expect.objectContaining({ key: "Content-Type" }));
    expect(req.description).toContain("Body: not set.");
  });

  it("never turns a param named 'body' into a fake body (real IPinfo POST /batch case)", async () => {
    const batch: AgentOutput["endpoints"][number] = {
      status: "documented",
      value: {
        method: "POST",
        path: "/batch",
        purpose: "Batch lookups",
        keyParams: [{ name: "body", in: "body", required: true, description: "JSON array of up to 1,000 lookup paths" }],
      },
      sources: [{ url: `${D}/endpoints`, quote: "Creates a severe-weather alert subscription." }],
    };
    const { analysis } = await scout(withEndpoints([batch]));
    const req = requests(analysis)[0]!.request;
    expect(req.body).toBeUndefined();
    expect(JSON.stringify(req)).not.toContain("<body>");
    expect(req.description).toContain("- body (required): JSON array of up to 1,000 lookup paths");
  });
});

describe("path variable examples", () => {
  const ep = (path: string, ...quotes: string[]) => ({
    status: "documented" as const,
    value: { method: "GET" as const, path, purpose: "Lookup", keyParams: [{ name: "ip", in: "path" as const, required: true, description: "IP" }] },
    sources: quotes.map((quote) => ({ url: "https://ipinfo.io/developers", quote })),
  });

  it("reads values from the docs' example URLs (real IPinfo quotes)", () => {
    expect(pathVariableExamples(ep("/lite/{ip}", "curl https://api.ipinfo.io/lite/8.8.8.8?token=$TOKEN"))).toEqual({ ip: "8.8.8.8" });
    expect(pathVariableExamples(ep("https://ipinfo.io/{ip}/json", "curl https://ipinfo.io/8.8.8.8/json?token=$TOKEN"))).toEqual({
      ip: "8.8.8.8",
    });
  });

  it("matches several variables and skips placeholders", () => {
    const e = { ...ep("/users/{user}/repos/{repo}"), sources: [
      { url: "https://x", quote: "GET https://api.x.example/users/{user}/repos/:repo" },
      { url: "https://x", quote: "curl https://api.x.example/users/octocat/repos/hello-world" },
    ] };
    expect(pathVariableExamples(e)).toEqual({ user: "octocat", repo: "hello-world" });
    expect(pathVariableExamples(ep("/lite/{ip}", "https://api.ipinfo.io/lite/YOUR_IP"))).toEqual({});
    expect(pathVariableExamples(ep("/lite/{ip}", "Look up any IP address."))).toEqual({});
  });

  it("prefills the Postman path variable and says where the value came from", () => {
    const analysis = {
      ...({} as Analysis),
      apiName: "IPinfo",
      summary: "",
      docsUrl: "https://ipinfo.io/developers",
      generatedAt: "2026-10-07T00:00:00.000Z",
      baseUrl: { status: "documented" as const, value: "https://api.ipinfo.io", sources: [] },
      auth: { status: "not_found" as const, value: null, sources: [] },
      authAlternatives: [],
      endpoints: [ep("/lite/{ip}", "curl https://api.ipinfo.io/lite/8.8.8.8?token=$TOKEN")],
    };
    const req = requests(analysis)[0]!.request;
    expect(req.url.variable).toEqual([{ key: "ip", value: "8.8.8.8", description: "IP (example value from the docs)" }]);
  });
});
