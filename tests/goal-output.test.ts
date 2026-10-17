import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import type { AgentOutput, Analysis } from "../src/core/schema.js";
import { runScout } from "../src/core/scout.js";
import { jsonExampleMatchesPage } from "../src/core/verify.js";
import { buildMarkdown, buildPostmanCollection, buildPostmanEnvironment, buildSequenceDiagram, validatePostmanCollection } from "../src/generators/index.js";
import { WEBHOOK_TEST_FOLDER } from "../src/generators/postman.js";
import { planCollection, type Collection } from "../src/postman/plan.js";
import { buildExampleRequests } from "../src/generators/requests.js";
import { fakeRunner } from "./helpers/fake-runner.js";
import { GH_ROOT, githubFetcher, RAW_SPEC, SPEC } from "./helpers/fixtures.js";

const GOAL = "Subscribe to tracking events for a parcel and receive them by webhook";
const doc = (quote: string) => ({ status: "documented" as const, sources: [{ url: RAW_SPEC, quote }] });
const notFound = { status: "not_found" as const, value: null, sources: [] };

/** What the agent might return after reading the Parcelpost spec (with some claims Scout must reject). */
const OUTPUT: AgentOutput = {
  apiName: "Parcelpost Alerts",
  summary: "Pushes tracking events for subscribed parcels to your webhook.",
  baseUrl: { ...doc("https://api.parcelpost.example/api/alerts/{version}"), value: "https://api.parcelpost.example/api/alerts/{version}" },
  auth: {
    ...doc("tokenUrl: https://api.parcelpost.example/security/v1/oauth/token"),
    value: {
      type: "oauth2",
      location: "header",
      grantType: "client_credentials",
      tokenUrl: "https://api.parcelpost.example/security/v1/oauth/token",
      description: "OAuth 2.0 client credentials",
    },
  },
  authAlternatives: [],
  endpoints: [
    {
      ...doc("Create subscriptions by tracking number."),
      value: {
        method: "POST",
        path: "/subscription/{type}/package",
        purpose: "Create subscriptions by tracking number",
        keyParams: [{ name: "version", in: "path", required: true, description: "API version" }],
        // The spec's YAML example as JSON, keys in another order: every key and value is in the spec,
        // but not as one sequence, so it counts as converted.
        exampleBody: JSON.stringify({
          destination: { credentialType: "Bearer", credential: "secret", url: "https://example.com/hooks/parcel" },
          trackingNumberList: ["1PP0000000000001"],
        }),
        exampleBodyFrom: "verbatim", // claimed by the model; Scout must set this itself
      },
    },
    {
      ...doc("Parcelpost sends this POST to the destination URL for every new tracking event."),
      value: {
        method: "POST",
        path: "/subscriptions/{id}/pause",
        purpose: "Pause a subscription",
        keyParams: [],
        // A value the spec doesn't contain.
        exampleBody: JSON.stringify({ subscriptionId: "sub_123", reason: "holiday" }),
        exampleBodyFrom: "verbatim",
      },
    },
  ],
  pagination: notFound,
  rateLimits: notFound,
  webhooks: {
    ...doc("Parcelpost sends this POST to the destination URL for every new tracking event."),
    value: {
      supported: true,
      events: ["TrackingEvent"],
      description: "One POST per tracking event.",
      examplePayload: JSON.stringify({ trackingNumber: "1PP0000000000001", activityStatus: "Delivered" }),
      payloadFields: [
        { name: "trackingNumber", type: "string", description: "The parcel" },
        { name: "activityStatus", type: "string", description: "Latest status" },
      ],
    },
  },
  errorFormat: notFound,
  versioning: notFound,
  risks: [{ severity: "medium", title: "Subscriptions expire", detail: "Subscriptions last 14 days." }],
  openQuestions: ["How are webhook deliveries retried?"],
  environments: [
    { ...doc("url: https://sandbox.parcelpost.example/api/alerts/{version}"), value: { name: "Sandbox", url: "https://sandbox.parcelpost.example/api/alerts/{version}" } },
    { ...doc("url: https://api.parcelpost.example/api/alerts/{version}"), value: { name: "Production", url: "https://api.parcelpost.example/api/alerts/{version}" } },
    // Quote verifies, but this URL is nowhere on the page.
    { ...doc("description: Sandbox"), value: { name: "Staging", url: "https://staging.parcelpost.example/api" } },
  ],
  flow: [
    { ...doc("tokenUrl: https://api.parcelpost.example/security/v1/oauth/token"), value: { action: "Get an access token", direction: "app_to_api", endpoint: "POST /security/v1/oauth/token" } },
    { ...doc("Create subscriptions by tracking number."), value: { action: "Subscribe the parcel", direction: "app_to_api", endpoint: "post  /subscription/{type}/package" } },
    {
      status: "inferred",
      reasoning: "The webhook needs a quick 2xx.",
      sources: [{ url: RAW_SPEC }],
      value: { action: "Acknowledge each event", direction: "api_to_webhook" },
    },
  ],
  pagesConsidered: [{ url: RAW_SPEC, relevant: true, reason: "The Alerts spec." }],
};

let analysis: Analysis;

beforeAll(async () => {
  analysis = await runScout(GH_ROOT, {
    config: { ...DEFAULT_CONFIG, maxPageChars: 2000 },
    fetcher: githubFetcher(),
    goal: GOAL,
    runner: fakeRunner([
      { fetch: GH_ROOT },
      { fetch: RAW_SPEC },
      { fetch: RAW_SPEC, part: 2 },
      { fetch: RAW_SPEC, part: 3 },
      { result: "success", output: OUTPUT },
    ]),
  });
});

describe("verification of goal-mode findings", () => {
  it("keeps a spec example converted to JSON and records where it came from", () => {
    expect(analysis.endpoints[0]!.value).toMatchObject({ exampleBodyFrom: "converted" });
    expect(analysis.endpoints[0]!.value!.exampleBody).toContain("1PP0000000000001");
  });

  it("drops an example body with values the docs don't contain", () => {
    expect(analysis.endpoints[1]!.value).not.toHaveProperty("exampleBody");
    expect(analysis.endpoints[1]!.value).not.toHaveProperty("exampleBodyFrom");
    expect(analysis.warnings.some((w) => /downgraded/.test(w))).toBe(true);
  });

  it("keeps a webhook payload and a token URL that are on the cited page", () => {
    expect(analysis.webhooks.value?.examplePayload).toContain("Delivered");
    expect(analysis.auth.value?.tokenUrl).toBe("https://api.parcelpost.example/security/v1/oauth/token");
  });

  it("downgrades an environment whose URL isn't on the cited page", () => {
    expect(analysis.environments!.map((e) => [e.value!.name, e.status])).toEqual([
      ["Sandbox", "documented"],
      ["Production", "documented"],
      ["Staging", "inferred"],
    ]);
  });

  it("keeps flow steps, but only links them to endpoints the analysis lists", () => {
    expect(analysis.flow!.map((s) => s.value!.endpoint)).toEqual([undefined, "post  /subscription/{type}/package", undefined]);
    expect(analysis.flow![2]!.status).toBe("inferred");
  });
});

describe("rejecting made-up values", () => {
  it("needs every key and value of a JSON example on the page", () => {
    expect(jsonExampleMatchesPage(JSON.stringify({ trackingNumber: "1PP0000000000001", activityStatus: "Delivered" }), SPEC)).toBe(true);
    expect(jsonExampleMatchesPage(JSON.stringify({ trackingNumber: "1PP0000000000001", activityStatus: "Lost" }), SPEC)).toBe(false);
    expect(jsonExampleMatchesPage(JSON.stringify({ shipmentRef: "1PP0000000000001" }), SPEC)).toBe(false);
    expect(jsonExampleMatchesPage('{"a": 1', SPEC)).toBe(false);
    expect(jsonExampleMatchesPage(JSON.stringify({ trackingNumber: true }), SPEC)).toBe(false);
  });

  it("drops a token URL and an example payload that aren't on the cited page", async () => {
    const bad: AgentOutput = {
      ...OUTPUT,
      auth: { ...OUTPUT.auth, value: { ...OUTPUT.auth.value!, tokenUrl: "https://evil.example/token" } },
      webhooks: { ...OUTPUT.webhooks, value: { ...OUTPUT.webhooks.value!, examplePayload: '{"trackingNumber": "X1", "status": "made up"}' } },
    };
    const result = await runScout(GH_ROOT, {
      config: DEFAULT_CONFIG,
      fetcher: githubFetcher(),
      goal: GOAL,
      runner: fakeRunner([{ fetch: RAW_SPEC }, { result: "success", output: bad }]),
    });
    expect(result.auth.value).not.toHaveProperty("tokenUrl");
    expect(result.webhooks.value).not.toHaveProperty("examplePayload");
  });
});

describe("goal-mode document and diagram", () => {
  it("adds the flow, the environments, the payload and example requests", () => {
    const md = buildMarkdown(analysis);
    expect(md).toContain(`**Goal:** ${GOAL}`);
    expect(md).toContain("## Integration flow\n\n1. **Get an access token** (Your app → API). Documented");
    expect(md).toContain("3. **Acknowledge each event** (API → your webhook). Inferred");
    expect(md).toContain("| Sandbox | `https://sandbox.parcelpost.example/api/alerts/{version}` | Documented |");
    expect(md).toContain("| Staging | `https://staging.parcelpost.example/api` | Inferred |");
    expect(md).toContain("| `activityStatus` | string | Latest status |");
    expect(md).toContain("Example payload (from the docs):");
    expect(md).toContain("## Example requests");
    expect(md).toContain("The body is the docs' example rewritten as JSON");
    // Sections stay in reading order: flow and requests before the risks.
    expect(md.indexOf("## Integration flow")).toBeLessThan(md.indexOf("## Example requests"));
    expect(md.indexOf("## Example requests")).toBeLessThan(md.indexOf("## Risks"));
  });

  it("builds curl commands with variables only, and a body only from the docs", () => {
    const [token, subscribe, pause] = buildExampleRequests(analysis);
    // A documented client-credentials flow: get the token first, then use it.
    expect(token!.curl).toContain("curl -X POST '{{tokenUrl}}'");
    expect(token!.curl).toContain("-u '{{clientId}}:{{clientSecret}}'");
    const body = JSON.stringify(
      {
        destination: { credentialType: "Bearer", credential: "{{credential}}", url: "https://example.com/hooks/parcel" },
        trackingNumberList: ["1PP0000000000001"],
      },
      null,
      2,
    );
    expect(subscribe!.curl).toBe(
      [
        "curl -X POST '{{baseUrl}}/subscription/{type}/package' \\",
        "  -H 'Authorization: Bearer {{accessToken}}' \\",
        "  -H 'Content-Type: application/json' \\",
        `  --data '${body}'`,
      ].join("\n"),
    );
    // The docs' placeholder secret ("secret") never reaches a request.
    expect(subscribe!.curl).not.toContain('"secret"');
    expect(subscribe!.maskedFields).toEqual(["credential"]);
    expect(subscribe!.placeholders).toEqual(["type"]);
    expect(subscribe!.bodyFrom).toBe("converted");
    expect(pause!.curl).not.toContain("--data");
  });

  it("escapes single quotes in bodies for the shell", () => {
    const quoted: Analysis = structuredClone(analysis);
    quoted.endpoints[0]!.value!.exampleBody = `{"note": "it's here"}`;
    expect(buildExampleRequests(quoted)[1]!.curl).toContain(`--data '{"note": "it'\\''s here"}'`);
  });

  it("draws the sequence diagram from the flow, with the webhook endpoint as a participant", () => {
    expect(buildSequenceDiagram(analysis)).toBe(
      [
        "sequenceDiagram",
        "  autonumber",
        "  participant App as Your app",
        "  participant API as Parcelpost Alerts API",
        "  participant Hook as Your webhook endpoint",
        "  App->>API: Get an access token",
        "  App->>API: Subscribe the parcel (post /subscription/{type}/package)",
        "  API->>Hook: Acknowledge each event (inferred)",
        "",
      ].join("\n"),
    );
  });

  it("leaves documents without a goal as they were", () => {
    const { goal: _g, discovery: _d, flow: _f, ...plain } = analysis;
    const md = buildMarkdown(plain as Analysis);
    expect(md).not.toContain("## Example requests");
    expect(md).not.toContain("## Integration flow");
  });
});

describe("goal-mode Postman collection", () => {
  const variable = (c: ReturnType<typeof buildPostmanCollection>, key: string) => c.variable.find((v) => v.key === key);

  it("is valid Postman v2.1 and named after the goal", () => {
    const c = buildPostmanCollection(analysis);
    expect(validatePostmanCollection(c)).toEqual({ valid: true, errors: [] });
    expect(c.info.name).toBe(`Parcelpost Alerts: ${GOAL.slice(0, 59)}… (API Integration Scout)`);
    expect(c.info.description).toContain(`Goal: ${GOAL}`);
  });

  it("leaves baseUrl empty when the docs list several environments, and lists them as options", () => {
    const c = buildPostmanCollection(analysis);
    expect(variable(c, "baseUrl")).toMatchObject({ value: "" });
    expect(variable(c, "baseUrl")!.description).toBe(
      "The docs list 3 environments; choose one and paste its URL here. Options: Sandbox: https://sandbox.parcelpost.example/api/alerts/{{version}} | Production: https://api.parcelpost.example/api/alerts/{{version}} | Staging: https://staging.parcelpost.example/api",
    );
    expect(c.info.description).toContain("Staging: https://staging.parcelpost.example/api (inferred)");
    // {version} in the server URL becomes a variable the user fills in.
    expect(variable(c, "version")).toMatchObject({ value: "" });
  });

  it("sets up Postman's OAuth helper for a documented client-credentials flow", () => {
    const c = buildPostmanCollection(analysis);
    expect(c.auth).toEqual({
      type: "oauth2",
      oauth2: expect.arrayContaining([
        { key: "grant_type", value: "client_credentials", type: "string" },
        { key: "accessTokenUrl", value: "{{tokenUrl}}", type: "string" },
        { key: "clientId", value: "{{clientId}}", type: "string" },
        { key: "clientSecret", value: "{{clientSecret}}", type: "string" },
      ]),
    });
    // Several environments: the token URL may differ per environment, so it isn't prefilled either.
    expect(variable(c, "tokenUrl")).toMatchObject({ value: "" });
    expect(variable(c, "tokenUrl")!.description).toContain("https://api.parcelpost.example/security/v1/oauth/token");
  });

  it("replaces credential fields in bodies and never ships the docs' placeholder secret", () => {
    const c = buildPostmanCollection(analysis);
    const json = JSON.stringify(c);
    expect(json).toContain("{{credential}}");
    expect(json).not.toContain('\\"secret\\"');
    expect(variable(c, "credential")).toMatchObject({ value: "" });
  });

  it("adds a request that sends the docs' example event to the user's own webhook", () => {
    const c = buildPostmanCollection(analysis);
    const folder = c.item.find((f) => f.name === WEBHOOK_TEST_FOLDER)!;
    const request = folder.item[0]!.request as { url: { raw: string }; auth: unknown; body?: { raw: string } };
    expect(request.url.raw).toBe("{{webhookUrl}}");
    expect(request.auth).toEqual({ type: "noauth" });
    expect(request.body!.raw).toContain("Delivered");
    expect(variable(c, "webhookUrl")).toMatchObject({ value: "" });
  });

  it("gives an environment with every variable empty and credentials marked secret", () => {
    const env = buildPostmanEnvironment(analysis);
    expect(env.values.every((v) => v.value === "")).toBe(true);
    const types = Object.fromEntries(env.values.map((v) => [v.key, v.type]));
    expect(types).toMatchObject({ baseUrl: "default", version: "default", tokenUrl: "default", clientId: "secret", clientSecret: "secret", apiKey: "secret", credential: "secret", webhookUrl: "default" });
  });

  it("prefills baseUrl and the token URL when the docs give exactly one environment", () => {
    const one: Analysis = { ...analysis, environments: analysis.environments!.slice(1, 2) };
    const env = Object.fromEntries(buildPostmanEnvironment(one).values.map((v) => [v.key, v.value]));
    expect(env.baseUrl).toBe("https://api.parcelpost.example/api/alerts/{{version}}");
    expect(env.tokenUrl).toBe("https://api.parcelpost.example/security/v1/oauth/token");
    expect(env.clientSecret).toBe("");
  });
});

describe("running a goal-mode collection with postman:run", () => {
  it("never sends the webhook test, even with --allow-writes", () => {
    const { plan } = planCollection(buildPostmanCollection(analysis) as unknown as Collection, { allowWrites: true });
    expect(plan.find((p) => p.folder === WEBHOOK_TEST_FOLDER)).toMatchObject({ run: false, reason: "tests your own webhook endpoint, not the API" });
    // The API requests are judged by the usual rules (here: empty path variables), not this one.
    expect(plan.filter((p) => p.folder !== WEBHOOK_TEST_FOLDER).map((p) => p.reason)).toEqual(["no value for path variable :type", "no value for path variable :id"]);
  });

  it("sends TARGET_API_TOKEN as the bearer token instead of Postman's OAuth helper", () => {
    const { runnable, oauthHelper } = planCollection(buildPostmanCollection(analysis) as unknown as Collection, { allowWrites: false });
    expect(oauthHelper).toBe(true);
    expect(runnable.auth).toEqual({ type: "bearer", bearer: [{ key: "token", value: "{{apiKey}}", type: "string" }] });
  });

  it("leaves other auth untouched", () => {
    const plain: Analysis = { ...analysis, auth: { ...analysis.auth, value: { type: "bearer", location: "header", description: "Bearer token" } } };
    const collection = buildPostmanCollection(plain) as unknown as Collection;
    const { runnable, oauthHelper } = planCollection(collection, { allowWrites: false });
    expect(oauthHelper).toBe(false);
    expect(runnable.auth).toEqual(collection.auth);
  });
});
