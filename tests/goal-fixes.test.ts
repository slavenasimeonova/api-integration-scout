// Fixes after the first real goal run (GitHub webhooks, 2026-10-19).
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { createEmitter } from "../src/core/events.js";
import type { Fetcher } from "../src/core/fetcher.js";
import { extractPage } from "../src/core/html.js";
import { GOAL_INSTRUCTIONS } from "../src/core/prompt.js";
import { goalTerms, scoreLink } from "../src/core/relevance.js";
import type { AgentOutput, Analysis } from "../src/core/schema.js";
import { isEndpointPath, runScout } from "../src/core/scout.js";
import { formatSections, sectionOffsets } from "../src/core/spec-outline.js";
import { DocsSession } from "../src/core/tools.js";
import { buildMarkdown, buildPostmanCollection, buildPostmanEnvironment, buildSequenceDiagram } from "../src/generators/index.js";
import { WEBHOOK_TEST_FOLDER } from "../src/generators/postman.js";
import { ACME_OUTPUT, fakeRunner } from "./helpers/fake-runner.js";
import { ACME_ROOT, createFixtureFetcher } from "./helpers/fixtures.js";

const EVENTS = ["check_run", "deployment", "fork", "issue_comment", "issues", "label", "push", "release", "star", "watch"];
const EVENTS_URL = "https://docs.example-git.com/webhooks/events";

/** A long events page like GitHub's: one h2 per event, then "Availability" and "Webhook payload object" h3s. */
function eventsPage(): string {
  const filler = "<p>" + "Payload properties and descriptions for this event. ".repeat(60) + "</p>";
  const sections = EVENTS.map(
    (e) => `<h2>${e}</h2><p>This event occurs when there is activity relating to ${e}.</p><h3>Availability for ${e}</h3>${filler}<h3>Webhook payload object for ${e}</h3>${filler}`,
  ).join("");
  return `<html><head><title>Webhook events and payloads</title></head><body><main><h1>Webhook events and payloads</h1>
    <p>Learn about when each webhook event occurs. Mentions issues in passing.</p>${sections}
    <a href="\${externalDocsUrl}/rest/commits/comments">REST</a><a href="/webhooks/validating-webhook-deliveries">Validating webhook deliveries</a></main></body></html>`;
}

const eventsFetcher: Fetcher = async (url) => ({ finalUrl: url, status: 200, contentType: "text/html", body: eventsPage() });

describe("1. section map for long HTML pages", () => {
  it("keeps heading levels", () => {
    const page = extractPage(eventsPage(), EVENTS_URL);
    expect(page.headings.slice(0, 4)).toEqual([
      { level: 1, text: "Webhook events and payloads" },
      { level: 2, text: "check_run" },
      { level: 3, text: "Availability for check_run" },
      { level: 3, text: "Webhook payload object for check_run" },
    ]);
  });

  it("finds where each heading starts, skipping mentions inside paragraphs", () => {
    const text = "Intro mentions issues here\nissues\nBody about issues\nwatch\nEnd";
    expect(sectionOffsets(text, [{ level: 2, text: "issues" }, { level: 2, text: "watch" }])).toEqual([
      { level: 2, text: "issues", offset: 27 },
      { level: 2, text: "watch", offset: 52 },
    ]);
  });

  it("lists h1/h2 and only the h3s that match, marking matches", () => {
    const sections = [
      { level: 2 as const, text: "issues", offset: 0 },
      { level: 3 as const, text: "Availability for issues", offset: 10 },
      { level: 3 as const, text: "Availability for watch", offset: 20 },
      { level: 2 as const, text: "watch", offset: 30 },
    ];
    expect(formatSections(sections, (o) => (o < 25 ? 1 : 2), (t) => t.includes("issues"))).toBe(
      ["- * issues (part 1)", "- *   Availability for issues (part 1)", "- watch (part 2)"].join("\n"),
    );
  });

  it("gives a long page a section map that points at the goal's section, with distinctive keywords only", async () => {
    const session = new DocsSession(
      "https://docs.example-git.com/webhooks",
      eventsFetcher,
      { ...DEFAULT_CONFIG, maxPageChars: 4000 },
      createEmitter(() => {}),
      goalTerms("Receive a webhook when a new issue is opened"),
    );
    const result = await session.fetchPage(EVENTS_URL);
    const map = result.text.split("PAGE SECTIONS")[1]!.split("<<<PAGE_TEXT")[0]!;
    expect(map).toContain("* = matches the goal");
    expect(map).toMatch(/- \* issues \(part \d+\)/);
    expect(map).toMatch(/- \* issue_comment \(part \d+\)/);
    expect(map).toMatch(/- watch \(part \d+\)/);
    // "webhook" is in a third of the headings here, so it doesn't mark them.
    expect(map).not.toMatch(/\*\s+Webhook payload object for check_run/);
    expect(map).not.toContain("Availability for check_run");
    // The map's part for "issues" really holds that section.
    const part = Number(/- \* issues \(part (\d+)\)/.exec(map)![1]);
    const inPart = await session.fetchPage(EVENTS_URL, part);
    expect(inPart.text).toContain("\nissues\nThis event occurs when there is activity relating to issues.");
  });

  it("leaves short pages without a section map", async () => {
    const session = new DocsSession(ACME_ROOT, createFixtureFetcher(), DEFAULT_CONFIG, createEmitter(() => {}), goalTerms("webhooks"));
    expect((await session.fetchPage(ACME_ROOT)).text).not.toContain("PAGE SECTIONS");
  });
});

describe("2. the user's own webhook receiver is not an API endpoint", () => {
  it("accepts paths and URLs, rejects placeholders and text", () => {
    for (const ok of ["/repos/{owner}/{repo}/hooks", "users/{id}", "https://api.example.com/v1/{id}", "/"]) expect(isEndpointPath(ok)).toBe(true);
    for (const bad of ["{your Payload URL}", "{payload_url}", "/hooks/{bad name}", "your server", "/a}b", ""]) expect(isEndpointPath(bad)).toBe(false);
  });

  it("leaves such an endpoint out with a warning, and unlinks flow steps from it", async () => {
    const receiver = {
      status: "inferred" as const,
      reasoning: "GitHub posts here.",
      sources: [],
      value: { method: "POST" as const, path: "{your Payload URL}", purpose: "Your receiver", keyParams: [] },
    };
    const output: AgentOutput = {
      ...ACME_OUTPUT,
      endpoints: [...ACME_OUTPUT.endpoints, receiver],
      flow: [{ status: "inferred", reasoning: "x", sources: [], value: { action: "GitHub delivers the event", direction: "api_to_webhook", endpoint: "POST {your Payload URL}" } }],
    };
    const analysis = await runScout(ACME_ROOT, {
      config: DEFAULT_CONFIG,
      fetcher: createFixtureFetcher(),
      goal: "receive webhooks",
      runner: fakeRunner([{ fetch: ACME_ROOT }, { result: "success", output }]),
    });
    expect(analysis.endpoints.map((e) => e.value?.path)).not.toContain("{your Payload URL}");
    expect(analysis.endpoints).toHaveLength(ACME_OUTPUT.endpoints.length);
    expect(analysis.warnings).toContain('Endpoint "POST {your Payload URL}" left out: its path isn\'t a URL path (a webhook receiver is described under webhooks)');
    expect(analysis.flow![0]!.value).not.toHaveProperty("endpoint");
    expect(JSON.stringify(buildPostmanCollection(analysis))).not.toContain("your Payload URL");
  });
});

/** A small goal-mode analysis to render. */
async function baseAnalysis(output: AgentOutput): Promise<Analysis> {
  return runScout(ACME_ROOT, {
    config: DEFAULT_CONFIG,
    fetcher: createFixtureFetcher(),
    goal: "receive webhooks and verify signatures",
    runner: fakeRunner([{ fetch: ACME_ROOT }, { fetch: "/webhooks" }, { result: "success", output }]),
  });
}

describe("3. steps on the user's side", () => {
  const step = (action: string, direction: "api_to_webhook" | "on_your_side") => ({
    status: "inferred" as const,
    reasoning: "x",
    sources: [],
    value: { action, direction },
  });

  it("are drawn on the receiver (or the app), not as calls to the API", async () => {
    const withHook = await baseAnalysis({ ...ACME_OUTPUT, flow: [step("API posts the event", "api_to_webhook"), step("Verify the signature", "on_your_side")] });
    const mmd = buildSequenceDiagram(withHook);
    expect(mmd).toContain("  API->>Hook: API posts the event (inferred)");
    expect(mmd).toContain("  Hook->>Hook: Verify the signature (inferred)");
    expect(mmd).not.toContain("App->>API: Verify");
    expect(buildMarkdown(withHook)).toContain("**Verify the signature** (on your side). Inferred");

    const appOnly = await baseAnalysis({ ...ACME_OUTPUT, flow: [step("Verify the signature", "on_your_side")] });
    expect(buildSequenceDiagram(appOnly)).toContain("  App->>App: Verify the signature (inferred)");
  });
});

describe("4. webhook test only with a complete JSON payload", () => {
  const abbreviated = '{\n"action": "opened",\n"issue": {\n"number": 1347,\n...\n}\n}';

  it("skips the test request for an abbreviated example and says why", async () => {
    // The example must be on the cited page to survive verification; patch it into the analysis instead.
    const analysis = await baseAnalysis(ACME_OUTPUT);
    const a: Analysis = { ...analysis, webhooks: { ...analysis.webhooks, status: "documented", value: { ...analysis.webhooks.value!, examplePayload: abbreviated } } };
    const c = buildPostmanCollection(a);
    expect(c.item.some((f) => f.name === WEBHOOK_TEST_FOLDER)).toBe(false);
    expect(c.info.description).toContain("No webhook test request: the docs' example payload isn't complete JSON");
    expect(buildPostmanEnvironment(a).values.map((v) => v.key)).not.toContain("webhookUrl");
    expect(buildMarkdown(a)).toContain("Example payload (from the docs; abbreviated or not valid JSON, so no Postman webhook test):");
  });

  it("keeps it for a complete JSON example", async () => {
    const analysis = await baseAnalysis(ACME_OUTPUT);
    const a: Analysis = { ...analysis, webhooks: { ...analysis.webhooks, status: "documented", value: { ...analysis.webhooks.value!, examplePayload: '{"action": "opened"}' } } };
    expect(buildPostmanCollection(a).item.some((f) => f.name === WEBHOOK_TEST_FOLDER)).toBe(true);
    expect(buildMarkdown(a)).toContain("Example payload (from the docs):");
  });
});

describe("5. ranking: synonyms and template links", () => {
  it("finds 'Validating webhook deliveries' for a goal that says verify, and HMAC pages for signature", () => {
    const terms = goalTerms("verify the webhook signature");
    expect(terms).toEqual(["verify", "webhook", "signatu"]);
    expect(scoreLink({ url: "https://docs.example-git.com/webhooks/validating-webhook-deliveries", text: "Validating webhook deliveries" }, terms)).toEqual({
      score: 4,
      matched: ["verify", "webhook"],
    });
    expect(scoreLink({ url: "https://docs.example.com/hmac", text: "HMAC" }, terms).matched).toEqual(["signatu"]);
    // Kept out on purpose: "Sign in" isn't about signatures.
    expect(scoreLink({ url: "https://docs.example.com/login", text: "Sign in" }, terms).matched).not.toContain("signatu");
  });

  it("drops links that are unrendered template placeholders", () => {
    const links = extractPage(eventsPage(), EVENTS_URL).links.map((l) => l.url);
    expect(links).toEqual(["https://docs.example-git.com/webhooks/validating-webhook-deliveries"]);
  });
});

describe("6. progress reports in goal mode", () => {
  it("asks the agent to keep calling report_progress", () => {
    expect(GOAL_INSTRUCTIONS).toContain("Keep reporting progress: after each page, call report_progress");
  });
});
