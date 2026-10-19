import { z } from "zod";
import type { AnalysisEndpoint } from "./hosts.js";

/**
 * Every extracted fact is wrapped in a Finding so the reader always knows
 * where it came from:
 * - documented: stated in the docs; must cite a source URL and a verbatim quote
 * - inferred:   the agent's reasoning; must explain why
 * - not_found:  the docs don't cover it; value is null
 */
export const FindingStatus = z.enum(["documented", "inferred", "not_found"]);
export type FindingStatus = z.infer<typeof FindingStatus>;

export const Source = z.object({
  url: z.string().describe("URL of the fetched page this finding comes from"),
  quote: z
    .string()
    .optional()
    .describe("Short verbatim excerpt from that page. Required for documented findings."),
});
export type Source = z.infer<typeof Source>;

function finding<T extends z.ZodType>(value: T) {
  return z.object({
    status: FindingStatus,
    value: value.nullable(),
    sources: z.array(Source),
    reasoning: z
      .string()
      .optional()
      .describe("Why the agent believes this. Required for inferred findings."),
  });
}

export const AuthValue = z.object({
  type: z.enum(["api_key", "bearer", "basic", "oauth2", "none", "other"]),
  location: z.enum(["header", "query", "cookie", "none"]).optional(),
  parameterName: z
    .string()
    .optional()
    .describe("Header or query parameter carrying the credential, e.g. Authorization or appid"),
  tokenUrl: z
    .string()
    .optional()
    .describe("OAuth 2.0 only: the token endpoint's full URL as the docs state it (it must appear in this finding's quote)"),
  grantType: z
    .enum(["client_credentials", "authorization_code", "other"])
    .optional()
    .describe("OAuth 2.0 only: the grant (flow) the docs describe"),
  description: z.string(),
});

export const PaginationValue = z.object({
  style: z.enum(["cursor", "offset", "page", "link_header", "none", "other"]),
  parameters: z.array(z.string()),
  description: z.string(),
});

export const RateLimitValue = z.object({
  limits: z.string().describe("e.g. '60 requests per minute per key'"),
  headers: z.array(z.string()),
  description: z.string(),
});

export const WebhookValue = z.object({
  supported: z.boolean(),
  events: z.array(z.string()),
  signatureVerification: z
    .string()
    .optional()
    .describe("How payloads are signed and verified, if documented"),
  examplePayload: z
    .string()
    .optional()
    .describe(
      "An example webhook payload from the docs: verbatim, or the JSON form of an API spec's YAML example with keys and values exactly as in the spec. Omit if the docs show none; never write one yourself.",
    ),
  payloadFields: z
    .array(z.object({ name: z.string(), type: z.string().optional(), description: z.string() }))
    .optional()
    .describe("The payload fields the docs describe (e.g. from the spec's schema), at most 25"),
  description: z.string(),
});

/** A server or environment the docs list, e.g. sandbox and production. */
export const EnvironmentValue = z.object({
  name: z.string().describe("The docs' name for it, e.g. 'Sandbox', 'Production', 'CIE (test)'"),
  url: z.string().describe("Its base URL exactly as the docs state it (it must appear in this finding's quote)"),
});

/** One step of the integration flow, in order. */
export const FlowStepValue = z.object({
  action: z.string().describe("Short description, e.g. 'Get an OAuth access token' or 'GitHub posts the issues event'"),
  direction: z
    .enum(["app_to_api", "api_to_app", "api_to_webhook", "on_your_side"])
    .describe(
      "Who calls whom: your app calls the API, the API answers, the API calls your webhook endpoint, or a step that happens on your side only (e.g. verifying a signature)",
    ),
  endpoint: z
    .string()
    .optional()
    .describe("'METHOD path' of the endpoint used, exactly as in endpoints, if any"),
});

export const ErrorFormatValue = z.object({
  description: z.string(),
  example: z.string().optional().describe("Example error body, verbatim if documented"),
});

export const VersioningValue = z.object({
  scheme: z.enum(["url_path", "header", "query", "date", "none", "other"]),
  current: z.string().optional(),
  description: z.string(),
});

export const HttpMethod = z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

export const EndpointParam = z.object({
  name: z.string(),
  in: z.enum(["path", "query", "header", "body"]),
  required: z.boolean(),
  description: z.string(),
});

export const EndpointValue = z.object({
  method: HttpMethod,
  path: z
    .string()
    .describe("Path relative to the base URL, e.g. /v1/customers/{id}. If the endpoint is on a different host, the full URL instead."),
  purpose: z.string(),
  keyParams: z.array(EndpointParam),
  exampleBody: z
    .string()
    .optional()
    .describe(
      "Example request body from the docs: verbatim (e.g. the JSON in a curl -d example), or the JSON form of an API spec's YAML example with keys and values exactly as in the spec. Omit unless the docs show one for this endpoint; never write one yourself.",
    ),
  exampleBodyFrom: z
    .enum(["verbatim", "converted"])
    .optional()
    .describe("Leave out: set by Scout when it verifies the example body (verbatim = same words in order, converted = rewritten)."),
  access: z
    .object({
      requirement: z.string().describe("Short statement of what is needed, e.g. 'Core, Plus or Max plan' or 'admin scope'"),
      source: Source.describe("Fetched page and verbatim quote that states the restriction"),
    })
    .optional()
    .describe(
      "Only if the docs explicitly state that this endpoint needs a specific plan, tier, scope or permission. Omit otherwise; never infer it.",
    ),
});

export const Severity = z.enum(["low", "medium", "high"]);

export const AgentRisk = z.object({
  severity: Severity,
  title: z.string(),
  detail: z.string(),
});

const FlowSteps = z.array(finding(FlowStepValue));
const PagesConsidered = z.array(
  z.object({
    url: z.string().describe("A page you read, or a link you saw and chose not to read"),
    relevant: z.boolean().describe("Whether the page matters for the goal"),
    reason: z.string().describe("One short sentence: why it is or isn't relevant to the goal"),
  }),
);

/** What the model must return (passed to the SDK as the outputFormat schema). */
export const AgentOutput = z.object({
  apiName: z.string().describe("Short human name of the API, e.g. 'Stripe' or 'OpenWeather'"),
  summary: z.string().describe("Two or three sentences on what the API does"),
  baseUrl: finding(z.string()),
  auth: finding(AuthValue).describe("The primary (recommended or first-described) authentication method"),
  authAlternatives: z
    .array(finding(AuthValue))
    .describe(
      "Every OTHER authentication method the docs explicitly state (e.g. token as a query parameter, HTTP Basic), each with its own source quote. Empty if the docs state only one. Never include a method the docs don't state.",
    ),
  endpoints: z.array(finding(EndpointValue)),
  pagination: finding(PaginationValue),
  rateLimits: finding(RateLimitValue),
  webhooks: finding(WebhookValue),
  errorFormat: finding(ErrorFormatValue),
  versioning: finding(VersioningValue),
  risks: z.array(AgentRisk),
  openQuestions: z.array(z.string()),
  environments: z
    .array(finding(EnvironmentValue))
    .optional()
    .describe("Every server or environment the docs list (e.g. sandbox/test and production), each with its own quote. Omit if the docs list only one base URL."),
  flow: FlowSteps.optional()
    .describe("Goal mode: the integration's steps in order (token, requests, webhook delivery). Omit without a goal."),
  pagesConsidered: PagesConsidered.optional()
    .describe("Goal mode only: every page you read and every promising link you skipped, with your reason. Omit without a goal."),
});
export type AgentOutput = z.infer<typeof AgentOutput>;

/**
 * Goal mode: flow and pagesConsidered are required, because a real run
 * (2026-10-19) left both out while they were optional. Only the schema sent to
 * the SDK changes; runScout still parses with AgentOutput and warns if they're missing.
 */
export const GoalAgentOutput = AgentOutput.extend({
  flow: FlowSteps.min(1).describe("The integration's steps in order (setup, token, requests, webhook delivery, work on your side)."),
  pagesConsidered: PagesConsidered.min(1).describe("Every page you read and every promising link you skipped, with your reason."),
});

export type Finding<T> = {
  status: FindingStatus;
  value: T | null;
  sources: Source[];
  reasoning?: string;
};
export type Auth = z.infer<typeof AuthValue>;
export type Pagination = z.infer<typeof PaginationValue>;
export type RateLimit = z.infer<typeof RateLimitValue>;
export type Webhook = z.infer<typeof WebhookValue>;
export type ErrorFormat = z.infer<typeof ErrorFormatValue>;
export type Versioning = z.infer<typeof VersioningValue>;
export type Endpoint = z.infer<typeof EndpointValue>;
export type Environment = z.infer<typeof EnvironmentValue>;
export type FlowStep = z.infer<typeof FlowStepValue>;

export type RiskOrigin = "agent" | "verification" | "fetch";

export type Risk = z.infer<typeof AgentRisk> & { origin: RiskOrigin };

export type PageVisit = {
  url: string;
  status: "fetched" | "failed";
  textLength: number;
  lowText: boolean;
  /** Part of the page never reached the model: it was longer than maxPageChars and not every part was read. */
  truncated: boolean;
  /** Long pages only: how many parts of maxPageChars the page has, and how many the agent read. */
  parts?: number;
  partsRead?: number;
  error?: string;
};

export type RunStats = {
  model: string;
  startedAt: string;
  durationMs: number;
  numTurns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  totalTokens: number;
  costUsd: number;
};

/** Goal mode: a page the ranking or the agent considered, and what happened to it. */
export type ConsideredPage = {
  url: string;
  /** Keyword score for the goal (relevance.ts scoreLink): 2 per term in the link text, 1 per term in the path, 1 for auth. */
  score: number;
  matched: string[];
  /** read = every part; partly = some parts of a long page; not_read = seen as a link or sitemap entry only. */
  read: "read" | "partly" | "failed" | "not_read";
  /** The agent's judgment and reason, when it gave one for this URL. */
  relevant?: boolean;
  reason?: string;
};

/** Goal mode: how pages were found and chosen. */
export type Discovery = {
  /** The goal's keywords after stemming. */
  terms: string[];
  /** Sitemap files read, how many same-site URLs they listed, and how many matched the goal. Null when none was found. */
  sitemap: { files: string[]; urls: number; matches: number } | null;
  pages: ConsideredPage[];
};

/** The final, verified result saved as analysis.json. */
export type Analysis = Omit<AgentOutput, "risks" | "endpoints" | "pagesConsidered"> & {
  /** Goal mode: the user's goal; the analysis covers only what it needs. */
  goal?: string;
  discovery?: Discovery;
  /** Endpoints after verification and the host check (see hosts.ts). */
  endpoints: AnalysisEndpoint[];
  schemaVersion: 1;
  docsUrl: string;
  generatedAt: string;
  risks: Risk[];
  pagesVisited: PageVisit[];
  warnings: string[];
  run: RunStats;
};

/** JSON Schema (draft-07, as the Agent SDK requires) for AgentOutput. */
export function agentOutputJsonSchema(goal = false): Record<string, unknown> {
  return z.toJSONSchema(goal ? GoalAgentOutput : AgentOutput, { target: "draft-7" }) as Record<string, unknown>;
}
