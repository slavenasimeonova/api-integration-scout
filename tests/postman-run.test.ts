import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Analysis } from "../src/core/schema.js";
import { buildPostmanCollection, buildPostmanEnvironment } from "../src/generators/postman.js";
import { planCollection, type Collection } from "../src/postman/plan.js";
import { runCollection, scrub } from "../src/postman/run.js";

const TOKEN = "tok_TEST_7f3a9c2e5b";
const NOT_FOUND = { status: "not_found" as const, value: null, sources: [] };

/** A small documented API served by the local test server. */
function analysisFor(baseUrl: string): Analysis {
  const doc = (method: "GET" | "POST", p: string, quote: string, keyParams: Analysis["endpoints"][number]["value"] extends infer V ? V extends { keyParams: infer K } ? K : never : never = []) => ({
    status: "documented" as const,
    value: { method, path: p, purpose: `${method} ${p}`, keyParams },
    sources: [{ url: "https://docs.test.example/", quote }],
  });
  return {
    schemaVersion: 1,
    apiName: "Test API",
    summary: "",
    docsUrl: "https://docs.test.example/",
    generatedAt: "2026-10-07T00:00:00.000Z",
    baseUrl: { status: "documented", value: baseUrl, sources: [] },
    auth: {
      status: "documented",
      value: { type: "bearer", location: "header", parameterName: "Authorization", description: "Bearer token" },
      sources: [],
    },
    authAlternatives: [],
    endpoints: [
      doc("GET", "/items/{id}", "Returns the item as JSON, e.g. curl https://api.test.example/items/42", [
        { name: "id", in: "path", required: true, description: "Item id" },
      ]),
      doc("GET", "/text", "Returns a plain-text greeting."),
      doc("GET", "/broken", "Returns the broken thing."),
      doc("GET", "/search", "Searches items.", [{ name: "q", in: "query", required: true, description: "Query" }]),
      doc("POST", "/items", "Creates an item."),
    ],
    pagination: NOT_FOUND,
    rateLimits: NOT_FOUND,
    webhooks: NOT_FOUND,
    errorFormat: NOT_FOUND,
    versioning: NOT_FOUND,
    risks: [],
    openQuestions: [],
    pagesVisited: [],
    warnings: [],
    run: {
      model: "m",
      startedAt: "2026-10-07T00:00:00.000Z",
      durationMs: 0,
      numTurns: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      totalTokens: 0,
      costUsd: 0,
    },
  };
}

describe("planCollection", () => {
  const collection = buildPostmanCollection(analysisFor("https://api.test.example"), "id") as unknown as Collection;

  it("runs only GET requests by default and says why others are skipped", () => {
    const { plan, runnable } = planCollection(collection, { allowWrites: false });
    expect(plan.map((p) => [p.name, p.run, p.reason ?? ""])).toEqual([
      // Collection order: requests are grouped in folders by their first path segment.
      ["GET /items/{id}", true, ""],
      ["POST /items", false, "POST request; pass --allow-writes to send it"],
      ["GET /text", true, ""],
      ["GET /broken", true, ""],
      ["GET /search", false, "no value for required query parameter q"],
    ]);
    const names = JSON.stringify(runnable);
    expect(names).not.toContain("POST /items");
    expect(names).not.toContain("GET /search");
  });

  it("sends writes only with allowWrites", () => {
    const { plan } = planCollection(collection, { allowWrites: true });
    expect(plan.find((p) => p.name === "POST /items")).toMatchObject({ run: true });
  });

  it("skips requests with an empty path variable or an unclear host", () => {
    const c: Collection = {
      item: [
        { name: "GET /users/{id}", request: { method: "GET", url: { raw: "{{baseUrl}}/users/:id", variable: [{ key: "id", value: "" }] } } },
        { name: "[CHECK HOST] GET /x", request: { method: "GET", url: { raw: "{{baseUrl}}/x" } } },
      ],
    };
    expect(planCollection(c, { allowWrites: false }).plan.map((p) => p.reason)).toEqual([
      "no value for path variable :id",
      "host is unclear in the docs; check it first",
    ]);
  });
});

describe("scrub", () => {
  it("removes the token and query strings", () => {
    expect(scrub(`GET https://api.x.example/a?token=${TOKEN}&q=1 failed`, TOKEN)).toBe("GET https://api.x.example/a failed");
    expect(scrub(`Bearer ${TOKEN}`, TOKEN)).toBe("Bearer [redacted]");
  });
});

describe("runCollection (Newman against a local server)", () => {
  let server: http.Server;
  let base: string;
  let dir: string;
  const seenAuth: string[] = [];
  const seenMethods: string[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      seenAuth.push(String(req.headers.authorization ?? ""));
      seenMethods.push(`${req.method} ${req.url}`);
      if (req.url === "/items/42") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"id": 42}');
      } else if (req.url === "/text") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("hello");
      } else if (req.url === "/items" && req.method === "POST") {
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end("{}");
      } else {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end(`server error for token ${TOKEN}`);
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    dir = await mkdtemp(path.join(tmpdir(), "postman-run-"));
    const analysis = analysisFor(base);
    await writeFile(path.join(dir, "collection.json"), JSON.stringify(buildPostmanCollection(analysis, "id")));
    await writeFile(path.join(dir, "environment.json"), JSON.stringify(buildPostmanEnvironment(analysis, "env")));
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  });

  const run = (allowWrites: boolean) =>
    runCollection({
      collectionPath: path.join(dir, "collection.json"),
      environmentPath: path.join(dir, "environment.json"),
      token: TOKEN,
      allowWrites,
      delayMs: 0,
      timeoutMs: 5000,
      outDir: path.join(dir, allowWrites ? "out-writes" : "out"),
    });

  it("sends only GETs, runs the generated tests, and reports pass/fail/skip", async () => {
    seenMethods.length = 0;
    const { report, markdownPath, jsonPath } = await run(false);

    expect(seenMethods.every((m) => m.startsWith("GET "))).toBe(true);
    expect(seenAuth.at(-1)).toBe(`Bearer ${TOKEN}`); // the token reached the API via {{apiKey}}
    expect(report.totals).toEqual({ requests: 5, run: 3, passed: 2, failed: 1, skipped: 2 });

    const byName = Object.fromEntries(report.results.map((r) => [r.name, r]));
    expect(byName["GET /items/{id}"]).toMatchObject({ status: 200, passed: true });
    expect(byName["GET /items/{id}"]!.tests.map((t) => t.name)).toEqual(["Status is 2xx", "Response time is under 5000 ms", "Response is JSON"]);
    // Plain text is fine: the docs didn't say this endpoint returns JSON.
    expect(byName["GET /text"]).toMatchObject({ status: 200, passed: true });
    expect(byName["GET /text"]!.tests.map((t) => t.name)).not.toContain("Response is JSON");
    expect(byName["GET /broken"]).toMatchObject({ status: 500, passed: false });

    // Nothing secret on disk: no token, no headers, no response bodies.
    for (const file of [markdownPath, jsonPath]) {
      const text = await readFile(file, "utf8");
      expect(text).not.toContain(TOKEN);
      expect(text).not.toMatch(/authorization|server error for token/i);
    }
    expect(await readFile(markdownPath, "utf8")).toContain("| POST /items | POST request; pass --allow-writes to send it |");
  }, 30_000);

  it("sends writes when allowed", async () => {
    seenMethods.length = 0;
    const { report } = await run(true);
    expect(seenMethods).toContain("POST /items");
    expect(report.results.find((r) => r.name === "POST /items")).toMatchObject({ status: 201, passed: true });
    expect(await readdir(path.join(dir, "out-writes"))).toHaveLength(2);
  }, 30_000);
});
