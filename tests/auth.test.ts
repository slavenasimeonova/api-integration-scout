import { describe, expect, it } from "vitest";
import { authRank, normalizeAuth } from "../src/core/auth.js";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import type { ProgressEvent } from "../src/core/events.js";
import type { AnalysisEndpoint } from "../src/core/hosts.js";
import type { Auth, Finding } from "../src/core/schema.js";
import { runScout } from "../src/core/scout.js";
import { ACME_ROOT, createFixtureFetcher } from "./helpers/fixtures.js";
import { ACME_OUTPUT, fakeRunner } from "./helpers/fake-runner.js";

const documented = (value: Auth): Finding<Auth> => ({ status: "documented", value, sources: [{ url: "https://docs.x/", quote: "q" }] });
const QUERY = documented({ type: "api_key", location: "query", parameterName: "token", description: "Token in query" });
const BEARER = documented({ type: "bearer", location: "header", parameterName: "Authorization", description: "Bearer token" });
const BASIC = documented({ type: "basic", location: "header", parameterName: "Authorization", description: "HTTP Basic" });
const HEADER_KEY = documented({ type: "api_key", location: "header", parameterName: "X-Api-Key", description: "Header key" });

const endpoint = (params: [name: string, where: "query" | "header" | "path" | "body"][]): AnalysisEndpoint => ({
  status: "documented",
  value: {
    method: "GET",
    path: "/lookup/{ip}",
    purpose: "Lookup",
    keyParams: params.map(([name, where]) => ({ name, in: where, required: true, description: name })),
  },
  sources: [],
});

describe("authRank", () => {
  it("prefers header methods, then Basic, then query, then cookie", () => {
    const ranks = [QUERY, BASIC, BEARER, HEADER_KEY].map((f) => authRank(f.value!));
    expect(ranks).toEqual([2, 1, 0, 0]);
    expect(authRank({ type: "api_key", location: "cookie", description: "" })).toBe(3);
    expect(authRank({ type: "bearer", description: "no location given" })).toBe(0);
  });
});

describe("normalizeAuth", () => {
  it("makes the header method primary when the model picked the query token (real IPinfo case)", () => {
    const r = normalizeAuth({ auth: QUERY, authAlternatives: [BASIC, BEARER], endpoints: [] });
    expect(r.auth).toBe(BEARER);
    expect(r.authAlternatives).toEqual([BASIC, QUERY]);
    expect(r.primaryChange).toEqual({ from: "api_key in query (token)", to: "bearer in header (Authorization)" });
  });

  it("keeps the docs' order between methods of equal rank", () => {
    const r = normalizeAuth({ auth: HEADER_KEY, authAlternatives: [BEARER], endpoints: [] });
    expect(r.auth).toBe(HEADER_KEY);
    expect(r.primaryChange).toBeUndefined();
  });

  it("leaves an inferred primary in place and ranks the documented alternatives", () => {
    const inferred: Finding<Auth> = { ...BEARER, status: "inferred", reasoning: "guess" };
    const r = normalizeAuth({ auth: inferred, authAlternatives: [QUERY, BASIC], endpoints: [] });
    expect(r.auth).toBe(inferred);
    expect(r.authAlternatives).toEqual([BASIC, QUERY]);
    expect(r.primaryChange).toBeUndefined();
  });

  it("removes params that carry a documented credential, and keeps the others", () => {
    const r = normalizeAuth({
      auth: QUERY,
      authAlternatives: [BEARER],
      endpoints: [endpoint([["ip", "path"], ["token", "query"], ["Authorization", "header"], ["fields", "query"]])],
    });
    expect(r.endpoints[0]!.value!.keyParams.map((p) => p.name)).toEqual(["ip", "fields"]);
    expect(r.removedCredentialParams).toEqual(["header:authorization", "query:token"]);
  });

  it("keeps a param whose auth method isn't documented", () => {
    const unverified: Finding<Auth> = { ...QUERY, status: "inferred" };
    const r = normalizeAuth({ auth: HEADER_KEY, authAlternatives: [unverified], endpoints: [endpoint([["token", "query"]])] });
    expect(r.endpoints[0]!.value!.keyParams.map((p) => p.name)).toEqual(["token"]);
  });
});

describe("runScout applies the auth rules", () => {
  it("reorders a query-token primary, says so, and hides credential params", async () => {
    const events: ProgressEvent[] = [];
    const output = {
      ...ACME_OUTPUT,
      // The model's pick: the query parameter as primary, the header as an alternative.
      auth: ACME_OUTPUT.authAlternatives[0]!,
      authAlternatives: [ACME_OUTPUT.auth],
    };
    const analysis = await runScout(ACME_ROOT, {
      config: DEFAULT_CONFIG,
      fetcher: createFixtureFetcher(),
      runner: fakeRunner([{ fetch: ACME_ROOT }, { fetch: "/endpoints" }, { result: "success", output }]),
      onEvent: (e) => events.push(e),
    });
    expect(analysis.auth.value).toMatchObject({ location: "header", parameterName: "X-Api-Key" });
    expect(analysis.authAlternatives.map((a) => a.value?.parameterName)).toEqual(["api_key"]);
    expect(events).toContainEqual(expect.objectContaining({ step: "auth_primary_changed", to: "api_key in header (X-Api-Key)" }));
    expect(analysis.warnings).toContainEqual(expect.stringMatching(/^Primary auth set to api_key in header \(X-Api-Key\)/));
    const forecast = analysis.endpoints.find((e) => e.value?.path === "/forecast")!;
    expect(forecast.value!.keyParams.map((p) => p.name)).toEqual(["city", "units"]);
  });
});
