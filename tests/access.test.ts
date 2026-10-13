import { describe, expect, it } from "vitest";
import {
  createTelegramNotifier,
  findCode,
  formatEntry,
  generateCode,
  handleRequestApi,
  hashCode,
  listRequests,
  MAX_BAD_CODES_PER_HOUR,
  MemoryKv,
  parseAccessCodes,
  updateRequest,
  type RequestApiDeps,
  type ScoutRequest,
} from "../src/access/index.js";

const ACME = "scout-abcde-fghjk-mnpqr-stuvw";
const BOB = "scout-23456-789ab-cdefg-hjkmn";
const ACCESS_CODES = [
  formatEntry({ name: "recruiter-acme", perDay: 2, total: 3, hash: hashCode(ACME) }),
  formatEntry({ name: "friend-bob", perDay: 1, total: 1, hash: hashCode(BOB) }),
].join(",");
const PAGES = "https://slavenasimeonova.github.io";
const API = "https://scout-requests.netlify.app/api/requests";

function setup(overrides: Partial<RequestApiDeps> = {}) {
  const store = new MemoryKv();
  const sent: { request: ScoutRequest; usage: unknown }[] = [];
  const logs: string[] = [];
  let now = new Date("2026-10-13T10:00:00Z");
  const deps: RequestApiDeps = {
    store,
    codes: parseAccessCodes(ACCESS_CODES),
    enabled: true,
    allowedOrigins: [PAGES],
    notify: async (request, usage) => {
      sent.push({ request, usage });
    },
    checkUrl: async (url) => {
      if (!url.startsWith("https://")) throw new Error("Only http and https URLs are allowed");
    },
    clientIp: "203.0.113.9",
    ipSalt: "test",
    now: () => now,
    log: (m) => logs.push(m),
    ...overrides,
  };
  const post = (body: unknown, origin = PAGES) =>
    handleRequestApi(
      new Request(API, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) }),
      deps,
    );
  const get = (id: string) => handleRequestApi(new Request(`${API}/${id}`, { headers: { origin: PAGES } }), deps);
  return { store, sent, logs, deps, post, get, setNow: (d: string) => (now = new Date(d)) };
}

describe("access codes", () => {
  it("generates readable random codes", () => {
    const a = generateCode();
    expect(a).toMatch(/^scout-[a-hjkmnp-z2-9]{5}(-[a-hjkmnp-z2-9]{5}){3}$/);
    expect(generateCode()).not.toBe(a);
  });

  it("matches a typed code case- and space-insensitively, and only by hash", () => {
    const codes = parseAccessCodes(ACCESS_CODES);
    expect(findCode(codes, ` ${ACME.toUpperCase()} `)?.name).toBe("recruiter-acme");
    expect(findCode(codes, BOB)?.name).toBe("friend-bob");
    expect(findCode(codes, "recruiter-acme")).toBeUndefined();
    expect(ACCESS_CODES).not.toContain(ACME);
  });

  it("revoking = removing the entry; the other codes keep working", () => {
    const codes = parseAccessCodes(ACCESS_CODES.split(",")[1]);
    expect(findCode(codes, ACME)).toBeUndefined();
    expect(findCode(codes, BOB)?.name).toBe("friend-bob");
  });

  it("rejects malformed entries instead of ignoring them", () => {
    expect(() => parseAccessCodes("acme:3:10:nothex")).toThrow(/name:perDay:total:sha256/);
    expect(() => parseAccessCodes(`acme:0:10:${hashCode(ACME)}`)).toThrow(/positive/);
    expect(() => parseAccessCodes(`${ACCESS_CODES},${ACCESS_CODES.split(",")[0]}`)).toThrow(/twice/);
    expect(parseAccessCodes(undefined)).toEqual([]);
  });
});

describe("request API", () => {
  it("stores a valid request, notifies, and hides the code name from the browser", async () => {
    const { post, get, sent, store } = setup();
    const res = await post({ code: ACME, url: "https://docs.example.com/api" });
    expect(res.status).toBe(201);
    expect(res.headers.get("access-control-allow-origin")).toBe(PAGES);
    const body = (await res.json()) as { id: string; status: string };
    expect(body.id).toMatch(/^[a-z0-9]{26}$/);
    expect(body.status).toBe("pending");
    expect(JSON.stringify(body)).not.toContain("recruiter-acme");

    expect(sent).toHaveLength(1);
    expect(sent[0]!.request).toMatchObject({ codeName: "recruiter-acme", url: "https://docs.example.com/api", status: "pending" });
    expect(sent[0]!.usage).toEqual({ today: 1, perDay: 2, total: 1, maxTotal: 3 });

    const status = await get(body.id);
    expect(status.status).toBe(200);
    const visible = await status.json();
    expect(visible).toMatchObject({ id: body.id, status: "pending", url: "https://docs.example.com/api" });
    expect(JSON.stringify(visible)).not.toContain("recruiter-acme");
    expect((await listRequests(store)).map((r) => r.codeName)).toEqual(["recruiter-acme"]);
  });

  it("stores the request and logs when the notification fails", async () => {
    const { post, logs, store } = setup({
      notify: async () => {
        throw new Error("Telegram sendMessage failed: HTTP 401");
      },
    });
    const res = await post({ code: ACME, url: "https://docs.example.com/api" });
    expect(res.status).toBe(201);
    expect(await listRequests(store)).toHaveLength(1);
    expect(logs.join("\n")).toMatch(/notification failed.*HTTP 401/);
  });

  it("stores the request and logs when notifications aren't configured", async () => {
    const { post, logs } = setup({ notify: undefined });
    expect((await post({ code: ACME, url: "https://docs.example.com/api" })).status).toBe(201);
    expect(logs.join("\n")).toMatch(/not configured/);
  });

  it("rejects a wrong code and throttles repeated guesses per IP", async () => {
    const { post, store } = setup();
    for (let i = 0; i < MAX_BAD_CODES_PER_HOUR; i++) {
      expect((await post({ code: `scout-wrong-${i}`, url: "https://docs.example.com/" })).status).toBe(401);
    }
    const blocked = await post({ code: ACME, url: "https://docs.example.com/" });
    expect(blocked.status).toBe(429);
    expect(((await blocked.json()) as { error: string }).error).toBe("too_many_attempts");
    expect(await listRequests(store)).toHaveLength(0);
  });

  it("enforces each code's per-day and total limits separately", async () => {
    const { post, setNow } = setup();
    const url = "https://docs.example.com/";
    expect((await post({ code: ACME, url })).status).toBe(201);
    expect((await post({ code: ACME, url })).status).toBe(201);
    const day = await post({ code: ACME, url });
    expect(day.status).toBe(429);
    expect(((await day.json()) as { error: string }).error).toBe("code_limit_day");

    // Another code is unaffected.
    expect((await post({ code: BOB, url })).status).toBe(201);

    setNow("2026-10-14T09:00:00Z");
    expect((await post({ code: ACME, url })).status).toBe(201);
    const total = await post({ code: ACME, url });
    expect(((await total.json()) as { error: string }).error).toBe("code_limit_total");
  });

  it("kill switch: rejects new requests, status lookups keep working", async () => {
    const live = setup();
    const { id } = (await (await live.post({ code: ACME, url: "https://docs.example.com/" })).json()) as { id: string };
    live.deps.enabled = false;
    const res = await live.post({ code: ACME, url: "https://docs.example.com/" });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe("paused");
    expect((await live.get(id)).status).toBe(200);
  });

  it("rejects URLs the check refuses, without counting them against the code", async () => {
    const { post } = setup();
    const res = await post({ code: BOB, url: "ftp://docs.example.com/" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toMatch(/http and https/);
    expect((await post({ code: BOB, url: "https://docs.example.com/" })).status).toBe(201);
  });

  it("validates the body and unknown ids", async () => {
    const { post, get } = setup();
    expect((await post({ code: ACME })).status).toBe(400);
    expect((await post({ code: ACME, url: "x".repeat(2001) })).status).toBe(400);
    expect((await get("not-an-id")).status).toBe(404);
    expect((await get("a".repeat(26))).status).toBe(404);
  });

  it("CORS: only allowed origins get headers; preflight works", async () => {
    const { post, deps } = setup();
    const other = await post({ code: ACME, url: "https://docs.example.com/" }, "https://evil.example");
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
    const preflight = await handleRequestApi(new Request(API, { method: "OPTIONS", headers: { origin: PAGES } }), deps);
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-methods")).toContain("POST");
  });

  it("status updates: done and declined, with an optional note", async () => {
    const { post, get, store } = setup();
    const { id } = (await (await post({ code: ACME, url: "https://docs.example.com/" })).json()) as { id: string };
    await updateRequest(store, id, { status: "declined", note: "Login-only docs" }, new Date("2026-10-13T12:00:00Z"));
    expect(await get(id).then((r) => r.json())).toMatchObject({ status: "declined", note: "Login-only docs", updatedAt: "2026-10-13T12:00:00.000Z" });
    await updateRequest(store, id, { status: "done" });
    expect(await get(id).then((r) => r.json())).not.toHaveProperty("note");
    expect(await listRequests(store)).toHaveLength(0);
    expect(await listRequests(store, { all: true })).toHaveLength(1);
  });
});

describe("Telegram notifier", () => {
  const request: ScoutRequest = {
    id: "a".repeat(26),
    codeName: "recruiter-acme",
    url: "https://docs.example.com/api",
    createdAt: "2026-10-13T10:00:00.000Z",
    status: "pending",
  };

  it("sends plain text with link previews off (Telegram never fetches the URL)", async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const notify = createTelegramNotifier({
      token: "123:secret",
      chatId: "42",
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, body: JSON.parse(String(init.body)) });
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    });
    await notify(request, { today: 1, perDay: 3, total: 4, maxTotal: 10 });
    expect(calls[0]!.url).toBe("https://api.telegram.org/bot123:secret/sendMessage");
    expect(calls[0]!.body).toMatchObject({ chat_id: "42", link_preview_options: { is_disabled: true } });
    expect(calls[0]!.body).not.toHaveProperty("parse_mode");
    const text = String(calls[0]!.body.text);
    expect(text).toContain("Code: recruiter-acme");
    expect(text).toContain("URL: https://docs.example.com/api");
    expect(text).toContain("Today: 1/3, total: 4/10");
    expect(text).toContain(`npm.cmd run request:fulfil -- ${request.id}`);
  });

  it("throws on an HTTP error without putting the token in the message", async () => {
    const notify = createTelegramNotifier({
      token: "123:secret",
      chatId: "42",
      fetch: (async () => new Response('{"description":"Unauthorized"}', { status: 401 })) as unknown as typeof fetch,
    });
    const err = await notify(request, { today: 1, perDay: 3, total: 1, maxTotal: 10 }).catch((e: Error) => e);
    expect(String(err)).toMatch(/HTTP 401/);
    expect(String(err)).not.toContain("secret");
  });
});
