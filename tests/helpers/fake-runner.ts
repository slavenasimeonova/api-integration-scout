import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentRunner } from "../../src/core/scout.js";
import type { AgentOutput } from "../../src/core/schema.js";

export type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };

/** Scripted stand-in for the Agent SDK. Each step either calls a tool or yields a message. */
export type FakeStep =
  | { fetch: string }
  | { progress: [step: Parameters<Parameters<AgentRunner>[0]["tools"]["reportProgress"]>[0], detail: string] }
  | { assistant: Usage; id?: string }
  | { result: "success"; output: unknown; usage?: Usage; costUsd?: number }
  | { result: "error_max_budget_usd" | "error_max_turns" | "error_max_structured_output_retries" }
  /** What the SDK yields when the API rejects the request: subtype success, is_error true. */
  | { apiError: string; status: number }
  | { throw: string };

export function fakeRunner(steps: FakeStep[]): AgentRunner & { calls: Parameters<AgentRunner>[0][] } {
  const calls: Parameters<AgentRunner>[0][] = [];
  let n = 0;
  const runner: AgentRunner = async function* (args) {
    calls.push(args);
    for (const step of steps) {
      if (args.options.abortController?.signal.aborted) throw new Error("aborted");
      if ("fetch" in step) await args.tools.fetchPage(step.fetch);
      else if ("progress" in step) args.tools.reportProgress(...step.progress);
      else if ("assistant" in step) {
        yield { type: "assistant", message: { id: step.id ?? `msg_${++n}`, usage: step.assistant, content: [] } } as unknown as SDKMessage;
      } else if ("throw" in step) throw new Error(step.throw);
      else if ("apiError" in step) {
        yield {
          type: "result",
          subtype: "success",
          is_error: true,
          api_error_status: step.status,
          result: step.apiError,
          usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          total_cost_usd: 0,
          num_turns: 1,
          duration_ms: 500,
        } as unknown as SDKMessage;
      }
      else if (step.result === "success") {
        yield {
          type: "result",
          subtype: "success",
          structured_output: step.output,
          usage: step.usage ?? { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          total_cost_usd: step.costUsd ?? 0,
          num_turns: 3,
          duration_ms: 1234,
        } as unknown as SDKMessage;
      } else {
        yield { type: "result", subtype: step.result, errors: [], usage: { input_tokens: 10, output_tokens: 1 }, total_cost_usd: 0.5, num_turns: 1, duration_ms: 5 } as unknown as SDKMessage;
        throw new Error(`Claude Code returned an error result: ${step.result}`);
      }
    }
  };
  return Object.assign(runner, { calls });
}

const D = "https://docs.acmeweather.example";

/** What a well-behaved agent would return for the Acme fixtures (one quote deliberately wrong). */
export const ACME_OUTPUT: AgentOutput = {
  apiName: "Acme Weather",
  summary: "Current conditions and forecasts for any location.",
  baseUrl: {
    status: "documented",
    value: "https://api.acmeweather.example/v2",
    sources: [{ url: `${D}/`, quote: "All requests are made to https://api.acmeweather.example/v2" }],
  },
  auth: {
    status: "documented",
    value: { type: "api_key", location: "header", parameterName: "X-Api-Key", description: "API key in the X-Api-Key header" },
    sources: [{ url: `${D}/`, quote: "sending your API key in the X-Api-Key header" }],
  },
  endpoints: [
    {
      status: "documented",
      value: {
        method: "GET",
        path: "/forecast",
        purpose: "7-day forecast for a city",
        keyParams: [
          { name: "city", in: "query", required: true, description: "City name" },
          { name: "units", in: "query", required: false, description: "metric or imperial" },
        ],
      },
      sources: [{ url: `${D}/endpoints`, quote: "Returns a 7-day forecast for a city." }],
    },
    {
      status: "documented",
      value: { method: "GET", path: "/locations", purpose: "List saved locations", keyParams: [{ name: "cursor", in: "query", required: false, description: "Pagination cursor" }] },
      sources: [{ url: `${D}/endpoints`, quote: "Lists saved locations." }],
    },
    {
      status: "documented",
      value: { method: "GET", path: "/locations/{id}", purpose: "Saved location details", keyParams: [{ name: "id", in: "path", required: true, description: "Location id" }] },
      sources: [{ url: `${D}/endpoints`, quote: "Returns details for a saved location." }],
    },
    {
      status: "documented",
      value: {
        method: "POST",
        path: "/alerts",
        purpose: "Subscribe to severe-weather alerts",
        keyParams: [
          { name: "location_id", in: "body", required: true, description: "Location to watch" },
          { name: "callback_url", in: "body", required: true, description: "Webhook URL" },
        ],
      },
      // Deliberately wrong quote: must be downgraded by verification.
      sources: [{ url: `${D}/endpoints`, quote: "Creates an alert and emails the account owner." }],
    },
  ],
  pagination: {
    status: "documented",
    value: { style: "cursor", parameters: ["cursor", "limit"], description: "Pass next_cursor as cursor" },
    sources: [{ url: `${D}/endpoints`, quote: "pass the cursor value from the previous response's next_cursor field" }],
  },
  rateLimits: {
    status: "documented",
    value: { limits: "60 requests per minute per key", headers: ["X-RateLimit-Remaining", "X-RateLimit-Reset"], description: "HTTP 429 when exceeded" },
    sources: [{ url: `${D}/rate-limits`, quote: "Each API key may make 60 requests per minute." }],
  },
  webhooks: {
    status: "documented",
    value: {
      supported: true,
      events: ["alert.triggered", "alert.cleared"],
      signatureVerification: "HMAC-SHA256 of the raw body in X-Acme-Signature",
      description: "POST to callback_url",
    },
    sources: [{ url: `${D}/webhooks`, quote: "an HMAC-SHA256 of the raw body, signed with your webhook secret" }],
  },
  errorFormat: {
    status: "documented",
    value: { description: "JSON error object with code and message", example: '{ "error": { "code": "invalid_city", "message": "City not found" } }' },
    sources: [{ url: `${D}/`, quote: "Errors use standard HTTP status codes and a JSON body" }],
  },
  versioning: {
    status: "inferred",
    value: { scheme: "url_path", current: "v2", description: "Major version in the path" },
    sources: [{ url: `${D}/` }],
    reasoning: "The base URL ends in /v2; no deprecation policy was found.",
  },
  risks: [{ severity: "high", title: "Webhook signature verification required", detail: "Verify X-Acme-Signature before trusting payloads." }],
  openQuestions: ["Is there a sandbox environment?"],
};
