import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, loadConfig } from "../src/core/config.js";
import { AgentOutput, agentOutputJsonSchema } from "../src/core/schema.js";
import { createEmitter, type ProgressEvent } from "../src/core/events.js";

describe("loadConfig", () => {
  it("uses the low-cost defaults when no env vars are set", () => {
    const config = loadConfig({});
    expect(config).toEqual(DEFAULT_CONFIG);
    expect(config.model).toBe("claude-sonnet-5-5");
    expect(config.maxTokens).toBe(150_000);
    expect(config.maxBudgetUsd).toBe(0.5);
  });

  it("reads env vars and lets overrides win", () => {
    const config = loadConfig(
      { SCOUT_MODEL: "claude-opus-5-5", SCOUT_MAX_PAGES: "5", SCOUT_MAX_TOKENS: "1000" },
      { maxPages: 3 },
    );
    expect(config.model).toBe("claude-opus-5-5");
    expect(config.maxPages).toBe(3);
    expect(config.maxTokens).toBe(1000);
  });

  it("rejects invalid numbers", () => {
    expect(() => loadConfig({ SCOUT_MAX_BUDGET_USD: "-1" })).toThrow(/SCOUT_MAX_BUDGET_USD/);
    expect(() => loadConfig({ SCOUT_MAX_PAGES: "abc" })).toThrow(/SCOUT_MAX_PAGES/);
  });
});

describe("AgentOutput schema", () => {
  it("converts to a draft-07 JSON Schema for the SDK", () => {
    const schema = agentOutputJsonSchema();
    expect(schema.$schema).toBe("http://json-schema.org/draft-07/schema#");
    expect(schema.type).toBe("object");
  });

  it("accepts a not_found finding with a null value", () => {
    const notFound = { status: "not_found", value: null, sources: [] };
    const result = AgentOutput.safeParse({
      apiName: "X",
      summary: "Y",
      baseUrl: notFound,
      auth: notFound,
      authAlternatives: [],
      endpoints: [],
      pagination: notFound,
      rateLimits: notFound,
      webhooks: notFound,
      errorFormat: notFound,
      versioning: notFound,
      risks: [],
      openQuestions: [],
    });
    expect(result.success).toBe(true);
  });
});

describe("createEmitter", () => {
  it("timestamps events and swallows listener errors", () => {
    const seen: ProgressEvent[] = [];
    createEmitter((e) => seen.push(e))({ step: "auth_found", detail: "OAuth 2.0" });
    expect(seen[0]).toMatchObject({ step: "auth_found", detail: "OAuth 2.0" });
    expect(typeof seen[0]?.at).toBe("string");

    const throwing = createEmitter(() => {
      throw new Error("listener broke");
    });
    expect(() => throwing({ step: "note", detail: "x" })).not.toThrow();
  });
});
