import { createHash, randomBytes } from "node:crypto";
import { findCode, type AccessCode } from "./codes.js";
import type { KvStore } from "./store.js";
import type { Notify } from "./telegram.js";

/**
 * Request mode: a visitor with an access code submits a docs URL. The request
 * is stored as pending and the owner is notified; the owner reviews it, runs
 * it locally (npm run request:fulfil) and publishes the result to the static
 * site. Web-standard Request/Response, so it runs in a Netlify Function, a
 * test, or (later) the worker.
 *
 *   POST /api/requests       { code, url } -> 201 { id, status, createdAt }
 *   GET  /api/requests/<id>  -> { id, status, url, createdAt, updatedAt?, note? }
 *
 * The code name is never sent back to the browser.
 */

export type RequestStatus = "pending" | "done" | "declined";

export type ScoutRequest = {
  id: string;
  codeName: string;
  url: string;
  createdAt: string;
  status: RequestStatus;
  updatedAt?: string;
  /** Shown to the visitor, e.g. why a request was declined. */
  note?: string;
};

export type RequestApiDeps = {
  store: KvStore;
  codes: AccessCode[];
  /** Kill switch: false rejects new requests (status lookups keep working). */
  enabled: boolean;
  /** Browser origins allowed to call the API, e.g. https://slavenasimeonova.github.io */
  allowedOrigins: string[];
  /** Missing = not configured; the request is stored and a warning logged. */
  notify?: Notify;
  /** Checks the URL (shape, and DNS on the server). Throws an Error with a message for the visitor. */
  checkUrl: (url: string) => Promise<void>;
  clientIp?: string;
  /** Salt for hashing IPs in throttle keys, so raw IPs are never stored. */
  ipSalt: string;
  now?: () => Date;
  log?: (message: string) => void;
};

/** Wrong codes allowed per IP per hour before the IP is throttled. */
export const MAX_BAD_CODES_PER_HOUR = 10;

const ID = /^[a-z0-9]{26}$/;

export const requestKey = (id: string) => `requests/${id}`;

function newId(): string {
  // 26 base-36 chars from 160 random bits; unguessable, so the id is the visitor's only key.
  return BigInt(`0x${randomBytes(20).toString("hex")}`).toString(36).padStart(31, "0").slice(-26);
}

export async function handleRequestApi(req: Request, deps: RequestApiDeps): Promise<Response> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((m: string) => console.error(m));
  const origin = req.headers.get("origin");
  const cors: Record<string, string> =
    origin && deps.allowedOrigins.includes(origin)
      ? { "access-control-allow-origin": origin, "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type", vary: "origin" }
      : {};
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...cors } });
  const fail = (status: number, error: string, message: string) => json(status, { error, message });

  const path = new URL(req.url).pathname.replace(/\/+$/, "");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...cors, "access-control-max-age": "600" } });

  // Status lookup.
  const match = /^\/api\/requests\/([^/]+)$/.exec(path);
  if (match && req.method === "GET") {
    const id = match[1]!;
    const record = ID.test(id) ? await deps.store.getJSON<ScoutRequest>(requestKey(id)) : undefined;
    if (!record) return fail(404, "not_found", "No request with this id.");
    const { codeName: _hidden, ...visible } = record;
    return json(200, visible);
  }
  if (path !== "/api/requests" || req.method !== "POST") return fail(404, "not_found", "Not found");

  // New request.
  if (!deps.enabled) return fail(503, "paused", "Requests are paused right now. Please try again later.");
  let body: { code?: unknown; url?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return fail(400, "invalid_body", "Send JSON: { code, url }.");
  }
  if (typeof body.code !== "string" || typeof body.url !== "string" || body.code.length > 100 || body.url.length > 2000) {
    return fail(400, "invalid_body", "Send JSON: { code, url }.");
  }

  const at = now();
  const hour = at.toISOString().slice(0, 13);
  const ipHash = createHash("sha256").update(`${deps.ipSalt}:${deps.clientIp ?? "unknown"}`).digest("hex").slice(0, 32);
  const throttleKey = `throttle/${hour}/${ipHash}`;
  const badCodes = (await deps.store.getJSON<{ count: number }>(throttleKey))?.count ?? 0;
  if (badCodes >= MAX_BAD_CODES_PER_HOUR) {
    return fail(429, "too_many_attempts", "Too many wrong codes from this network. Try again in an hour.");
  }

  const code = findCode(deps.codes, body.code);
  if (!code) {
    await deps.store.setJSON(throttleKey, { count: badCodes + 1 });
    return fail(401, "invalid_code", "This access code isn't valid.");
  }

  const url = body.url.trim();
  try {
    await deps.checkUrl(url);
  } catch (err) {
    return fail(400, "invalid_url", err instanceof Error ? err.message : "This URL can't be used.");
  }

  const day = at.toISOString().slice(0, 10);
  const dayKey = `counters/${code.name}/day/${day}`;
  const totalKey = `counters/${code.name}/total`;
  const today = (await deps.store.getJSON<{ count: number }>(dayKey))?.count ?? 0;
  const total = (await deps.store.getJSON<{ count: number }>(totalKey))?.count ?? 0;
  if (total >= code.total) return fail(429, "code_limit_total", `This code has used all ${code.total} requests.`);
  if (today >= code.perDay) return fail(429, "code_limit_day", `This code has used today's ${code.perDay} requests. Try again tomorrow (UTC).`);

  const record: ScoutRequest = { id: newId(), codeName: code.name, url, createdAt: at.toISOString(), status: "pending" };
  await deps.store.setJSON(requestKey(record.id), record);
  await deps.store.setJSON(dayKey, { count: today + 1 });
  await deps.store.setJSON(totalKey, { count: total + 1 });

  const usage = { today: today + 1, perDay: code.perDay, total: total + 1, maxTotal: code.total };
  if (!deps.notify) {
    log(`[requests] notifications not configured; new request ${record.id} from ${code.name}`);
  } else {
    try {
      await deps.notify(record, usage);
    } catch (err) {
      // Stored anyway; npm run request:list shows it.
      log(`[requests] notification failed for request ${record.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return json(201, { id: record.id, status: record.status, createdAt: record.createdAt });
}

/** All requests, oldest first; pending only unless all is set. */
export async function listRequests(store: KvStore, opts: { all?: boolean } = {}): Promise<ScoutRequest[]> {
  const records: ScoutRequest[] = [];
  for (const key of await store.list("requests/")) {
    const record = await store.getJSON<ScoutRequest>(key);
    if (record && (opts.all || record.status === "pending")) records.push(record);
  }
  return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function updateRequest(store: KvStore, id: string, change: { status: RequestStatus; note?: string }, now = new Date()): Promise<ScoutRequest> {
  const record = await store.getJSON<ScoutRequest>(requestKey(id));
  if (!record) throw new Error(`No request with id ${id}`);
  const updated: ScoutRequest = { ...record, ...change, updatedAt: now.toISOString() };
  if (!change.note) delete updated.note;
  await store.setJSON(requestKey(id), updated);
  return updated;
}

export const isRequestId = (id: string) => ID.test(id);
