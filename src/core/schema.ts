import { z } from "zod";

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
  description: z.string(),
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
  path: z.string().describe("Path relative to the base URL, e.g. /v1/customers/{id}"),
  purpose: z.string(),
  keyParams: z.array(EndpointParam),
});

export const Severity = z.enum(["low", "medium", "high"]);

export const AgentRisk = z.object({
  severity: Severity,
  title: z.string(),
  detail: z.string(),
});

/** What the model must return (passed to the SDK as the outputFormat schema). */
export const AgentOutput = z.object({
  apiName: z.string().describe("Short human name of the API, e.g. 'Stripe' or 'OpenWeather'"),
  summary: z.string().describe("Two or three sentences on what the API does"),
  baseUrl: finding(z.string()),
  auth: finding(AuthValue),
  endpoints: z.array(finding(EndpointValue)),
  pagination: finding(PaginationValue),
  rateLimits: finding(RateLimitValue),
  webhooks: finding(WebhookValue),
  errorFormat: finding(ErrorFormatValue),
  versioning: finding(VersioningValue),
  risks: z.array(AgentRisk),
  openQuestions: z.array(z.string()),
});
export type AgentOutput = z.infer<typeof AgentOutput>;

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

export type RiskOrigin = "agent" | "verification" | "fetch";

export type Risk = z.infer<typeof AgentRisk> & { origin: RiskOrigin };

export type PageVisit = {
  url: string;
  status: "fetched" | "failed";
  textLength: number;
  lowText: boolean;
  /** Text was longer than maxPageChars, so only the first part reached the model. */
  truncated: boolean;
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

/** The final, verified result saved as analysis.json. */
export type Analysis = Omit<AgentOutput, "risks"> & {
  schemaVersion: 1;
  docsUrl: string;
  generatedAt: string;
  risks: Risk[];
  pagesVisited: PageVisit[];
  warnings: string[];
  run: RunStats;
};

/** JSON Schema (draft-07, as the Agent SDK requires) for AgentOutput. */
export function agentOutputJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(AgentOutput, { target: "draft-7" }) as Record<string, unknown>;
}
