import { getStore } from "@netlify/blobs";
import { blobsKv, createTelegramNotifier, handleRequestApi, parseAccessCodes, REQUEST_STORE, type AccessCode } from "../../src/access/index.js";
import { BlockedUrlError, checkUrl } from "../../worker/safe-fetch.js";

/**
 * Request mode API (see src/access/requests.ts and docs/requests.md).
 * Environment variables (Netlify > Project configuration > Environment variables):
 *   ACCESS_CODES        name:perDay:total:sha256,...   (npm run code:new)
 *   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID               notifications
 *   ALLOWED_ORIGIN      comma-separated browser origins, default the GitHub Pages site
 *   REQUESTS_ENABLED    "off" pauses new requests (takes effect on the next deploy)
 *   IP_SALT             random string for hashing IPs in throttle keys
 */

export default async (req: Request, context: { ip?: string }): Promise<Response> => {
  const env = process.env;
  let codes: AccessCode[];
  try {
    codes = parseAccessCodes(env.ACCESS_CODES);
  } catch (err) {
    console.error(`[requests] ${err instanceof Error ? err.message : String(err)}`);
    codes = [];
  }
  return handleRequestApi(req, {
    store: blobsKv(getStore({ name: REQUEST_STORE, consistency: "strong" })),
    codes,
    enabled: (env.REQUESTS_ENABLED ?? "on").toLowerCase() !== "off",
    allowedOrigins: (env.ALLOWED_ORIGIN ?? "https://slavenasimeonova.github.io").split(",").map((s) => s.trim()).filter(Boolean),
    notify:
      env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID
        ? createTelegramNotifier({ token: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID })
        : undefined,
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

export const config = { path: ["/api/requests", "/api/requests/*"] };
