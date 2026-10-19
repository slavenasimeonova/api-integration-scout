import Anthropic from "@anthropic-ai/sdk";
import type { InterviewModel, InterviewReply } from "./interview.js";

/**
 * The interviewer's model call (Netlify Function only; tests use a fake).
 * The cheapest model, low effort, no thinking, no tools, a short reply cap,
 * and a JSON-schema reply that is checked again here. The key must be the
 * scout-demo workspace's interviewer key, passed explicitly so nothing else
 * in the environment is used. A plain JSON schema instead of zod keeps the
 * function bundle about 750 KB smaller.
 */

export const INTERVIEW_MODEL_ID = "claude-haiku-5-5";

const REPLY_SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["question", "goal"] },
    text: { type: "string" },
    goal: { type: "string" },
  },
  required: ["kind", "text", "goal"],
  additionalProperties: false,
};

/** The reply if it has the schema's shape, else null. */
export function parseReply(raw: string): InterviewReply | null {
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    if ((v.kind === "question" || v.kind === "goal") && typeof v.text === "string" && typeof v.goal === "string") {
      return { kind: v.kind, text: v.text, goal: v.goal };
    }
  } catch {
    // Not JSON: treated like any unusable reply.
  }
  return null;
}

export function createClaudeInterviewModel(opts: { apiKey: string; model?: string; fetch?: typeof fetch }): InterviewModel {
  // Netlify's synchronous functions time out after about 10 s; one retry still fits.
  const client = new Anthropic({ apiKey: opts.apiKey, timeout: 4_500, maxRetries: 1, ...(opts.fetch ? { fetch: opts.fetch } : {}) });
  return async ({ system, messages }) => {
    const response = await client.messages.create({
      model: opts.model ?? INTERVIEW_MODEL_ID,
      max_tokens: 400,
      system,
      messages,
      thinking: { type: "disabled" },
      output_config: { effort: "low", format: { type: "json_schema", schema: REPLY_SCHEMA } },
    });
    const usage = {
      inputTokens: response.usage.input_tokens + (response.usage.cache_creation_input_tokens ?? 0),
      outputTokens: response.usage.output_tokens,
    };
    if (response.stop_reason === "refusal") return { reply: null, refused: true, ...usage };
    const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    return { reply: parseReply(text), ...usage };
  };
}
