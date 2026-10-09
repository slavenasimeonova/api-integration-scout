import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import type { ProgressEvent } from "../src/core/events.js";
import type { AgentOutput, Analysis, Endpoint } from "../src/core/schema.js";
import { runScout } from "../src/core/scout.js";
import { ACCESS_VARIABLE, buildPostmanCollection } from "../src/generators/postman.js";
import { validatePostmanCollection } from "../src/generators/postman-validate.js";
import { runCollection } from "../src/postman/run.js";
import { ACME_ROOT, createFixtureFetcher } from "./helpers/fixtures.js";
import { ACME_OUTPUT, fakeRunner } from "./helpers/fake-runner.js";

const D = "https://docs.acmeweather.example";
const NOT_FOUND = { status: "not_found" as const, value: null, sources: [] };

const alerts = (access: Endpoint["access"]): AgentOutput["endpoints"][number] => ({
  status: "documented",
  value: { method: "POST", path: "/alerts", purpose: "Subscribe to alerts", keyParams: [], access },
  sources: [{ url: `${D}/endpoints`, quote: "Creates a severe-weather alert subscription." }],
});

async function scout(endpoints: AgentOutput["endpoints"]) {
  const events: ProgressEvent[] = [];
  const analysis = await runScout(ACME_ROOT, {
    config: DEFAULT_CONFIG,
    fetcher: createFixtureFetcher(),
    runner: fakeRunner([{ fetch: ACME_ROOT }, { fetch: "/endpoints" }, { result: "success", output: { ...ACME_OUTPUT, endpoints } }]),
    onEvent: (e) => events.push(e),
  });
  return { analysis, events };
}

describe("endpoint access restrictions", () => {
  it("keeps a restriction whose quote is on the page, and marks the Postman request", async () => {
    const { analysis } = await scout([
      alerts({ requirement: "Pro plan", source: { url: `${D}/endpoints`, quote: "Alerts are available on the Pro plan and above." } }),
    ]);
    expect(analysis.endpoints[0]!.value!.access?.requirement).toBe("Pro plan");

    const c = buildPostmanCollection(analysis, "id");
    expect(validatePostmanCollection(c).errors).toEqual([]);
    const item = c.item.flatMap((f) => f.item).find((i) => i.name === "POST /alerts") as Record<string, any>;
    expect(item.variable).toEqual([expect.objectContaining({ key: ACCESS_VARIABLE, value: "Pro plan" })]);
    expect(item.request.description).toContain('Requires: Pro plan (per docs: "Alerts are available on the Pro plan and above.")');
  });

  it("drops a restriction the docs don't state, and says so", async () => {
    const { analysis, events } = await scout([
      alerts({ requirement: "Enterprise plan", source: { url: `${D}/endpoints`, quote: "Alerts require an Enterprise contract." } }),
    ]);
    expect(analysis.endpoints[0]!.value!.access).toBeUndefined();
    expect(analysis.endpoints[0]!.status).toBe("documented");
    expect(events).toContainEqual(expect.objectContaining({ step: "verification_downgrade", field: "endpoints[0] POST /alerts access" }));
    const item = buildPostmanCollection(analysis, "id").item.flatMap((f) => f.item).find((i) => i.name === "POST /alerts") as Record<string, any>;
    expect(item.variable).toBeUndefined();
  });
});

describe("Newman runner: expected failures", () => {
  const TOKEN = "tok_EXPECT_91ab";
  let server: http.Server;
  let dir: string;

  const ep = (p: string, requirement?: string) => ({
    status: "documented" as const,
    value: {
      method: "GET" as const,
      path: p,
      purpose: p,
      keyParams: [],
      ...(requirement ? { access: { requirement, source: { url: `${D}/plans`, quote: `${p} needs ${requirement}` } } } : {}),
    },
    sources: [{ url: `${D}/`, quote: `GET ${p}` }],
  });

  beforeAll(async () => {
    const statuses: Record<string, number> = { "/gated": 403, "/gated-missing": 404, "/gated-ok": 200, "/manual": 403, "/plain": 403, "/abs/7": 200 };
    server = http.createServer((req, res) => {
      res.writeHead(statuses[req.url ?? ""] ?? 500, { "Content-Type": "application/json" });
      res.end("{}");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const analysis = {
      apiName: "Gated API",
      summary: "",
      docsUrl: `${D}/`,
      generatedAt: "2026-10-09T00:00:00.000Z",
      baseUrl: { status: "documented", value: base, sources: [] },
      auth: { status: "documented", value: { type: "bearer", location: "header", parameterName: "Authorization", description: "Bearer" }, sources: [] },
      authAlternatives: [],
      endpoints: [
        ep("/gated", "Pro plan"),
        ep("/gated-missing", "Pro plan"),
        ep("/gated-ok", "Pro plan"),
        ep("/manual"),
        ep("/plain"),
        // A full URL with a placeholder in the request name, like IPinfo's legacy endpoint.
        (() => {
          const abs = ep(`${base}/abs/{id}`);
          return {
            ...abs,
            value: { ...abs.value, keyParams: [{ name: "id", in: "path" as const, required: true, description: "Id" }] },
            sources: [{ url: `${D}/`, quote: `curl ${base}/abs/7` }],
          };
        })(),
      ],
      pagination: NOT_FOUND,
      rateLimits: NOT_FOUND,
      webhooks: NOT_FOUND,
      errorFormat: NOT_FOUND,
      versioning: NOT_FOUND,
    } as unknown as Analysis;
    dir = await mkdtemp(path.join(tmpdir(), "expect-fail-"));
    await writeFile(path.join(dir, "c.json"), JSON.stringify(buildPostmanCollection(analysis, "id")));
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  });

  it("reports 401/402/403 on plan-gated or --expect-fail requests as expected, and everything else as usual", async () => {
    const { report, markdownPath } = await runCollection({
      collectionPath: path.join(dir, "c.json"),
      token: TOKEN,
      allowWrites: false,
      expectFail: ["GET /manual", "GET /does-not-exist"],
      delayMs: 0,
      timeoutMs: 5000,
      outDir: path.join(dir, "out"),
    });
    const by = Object.fromEntries(report.results.map((r) => [r.name, r]));
    expect(by["GET /gated"]).toMatchObject({ status: 403, outcome: "expected_failure", expected: "tier-gated per analysis: requires Pro plan" });
    // A gated request failing for another reason is still a real failure.
    expect(by["GET /gated-missing"]).toMatchObject({ status: 404, outcome: "fail" });
    expect(by["GET /gated-ok"]).toMatchObject({ status: 200, outcome: "pass" });
    expect(by["GET /manual"]).toMatchObject({ status: 403, outcome: "expected_failure", expected: "marked with --expect-fail" });
    expect(by["GET /plain"]).toMatchObject({ status: 403, outcome: "fail" });
    expect(report.totals).toMatchObject({ passed: 2, failed: 2, expectedFailures: 2 });
    expect(report.unmatchedExpectFail).toEqual(["GET /does-not-exist"]);

    const md = await readFile(markdownPath, "utf8");
    expect(md).toContain("| EXPECTED FAIL | GET /gated | 403 |");
    expect(md).toContain("Expected failure: tier-gated per analysis: requires Pro plan.");
    expect(md).toContain('--expect-fail matched no request: "GET /does-not-exist"');
    expect(md).not.toContain(TOKEN);

    // Placeholders stay readable in request names: {id}, not %7Bid%7D.
    const absolute = report.results.find((r) => r.name.endsWith("/abs/{id}"));
    expect(absolute).toMatchObject({ status: 200, outcome: "pass" });
    expect(md).toContain("/abs/{id} |");
    expect(md).not.toContain("%7B");
  }, 30_000);
});
