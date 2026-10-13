import type { ScoutRequest } from "./requests.js";

export type Notify = (request: ScoutRequest, usage: { today: number; perDay: number; total: number; maxTotal: number }) => Promise<void>;

/**
 * Sends one Telegram message per new request. Plain text (no parse mode, so
 * nothing needs escaping) and link previews off, so Telegram never fetches the
 * submitted URL. Throws on failure; the caller stores the request anyway.
 */
export function createTelegramNotifier(opts: { token: string; chatId: string; fetch?: typeof fetch }): Notify {
  const doFetch = opts.fetch ?? fetch;
  return async (request, usage) => {
    const text = [
      "New scout request",
      `Code: ${request.codeName}`,
      `URL: ${request.url}`,
      `Time: ${request.createdAt}`,
      `Today: ${usage.today}/${usage.perDay}, total: ${usage.total}/${usage.maxTotal}`,
      "",
      `npm.cmd run request:fulfil -- ${request.id}`,
    ].join("\n");
    const res = await doFetch(`https://api.telegram.org/bot${opts.token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: opts.chatId, text, link_preview_options: { is_disabled: true } }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      // Telegram's error text never contains the token; the URL (which does) is not logged.
      const body = await res.text().catch(() => "");
      throw new Error(`Telegram sendMessage failed: HTTP ${res.status} ${body.slice(0, 200)}`);
    }
  };
}
