import { getStore } from "@netlify/blobs";
import { blobsKv, handleInterviewApi, REQUEST_STORE } from "../../src/access/index.js";
import { createClaudeInterviewModel } from "../../src/access/interview-model.js";
import { BlockedUrlError, checkUrl } from "../../worker/safe-fetch.js";

/**
 * Goal interviewer API (see src/access/interview.ts and docs/requests.md).
 * Open to everyone (requests.ts checks the code when the request is sent).
 * Environment variables, besides ALLOWED_ORIGIN, REQUESTS_ENABLED and IP_SALT,
 * which requests.ts uses too:
 *   INTERVIEW_API_KEY   the scout-demo workspace's interviewer key (never a local key)
 *   INTERVIEW_ENABLED   "off" turns the assistant off; visitors write the goal themselves
 */

export default async (req: Request, context: { ip?: string }): Promise<Response> => {
  const env = process.env;
  const enabled = (env.INTERVIEW_ENABLED ?? "on").toLowerCase() !== "off";
  const apiKey = env.INTERVIEW_API_KEY?.trim();
  return handleInterviewApi(req, {
    store: blobsKv(getStore({ name: REQUEST_STORE, consistency: "strong" })),
    model: enabled && apiKey ? createClaudeInterviewModel({ apiKey }) : undefined,
    requestsEnabled: (env.REQUESTS_ENABLED ?? "on").toLowerCase() !== "off",
    allowedOrigins: (env.ALLOWED_ORIGIN ?? "https://slavenasimeonova.github.io").split(",").map((s) => s.trim()).filter(Boolean),
    checkUrl: async (url) => {
      try {
        await checkUrl(url);
      } catch (err) {
        if (err instanceof BlockedUrlError) throw err;
        throw new Error("This host name could not be found.");
      }
    },
    clientIp: context.ip,
    ipSalt: env.IP_SALT ?? "scout-requests",
  });
};

export const config = { path: ["/api/interview", "/api/interview/*"] };
