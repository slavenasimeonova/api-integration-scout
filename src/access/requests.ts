import { normalizeGoal } from "../core/goal.js";
import { checkAccessCode, type AccessCode } from "./codes.js";
import { jsonResponder } from "./http.js";
import { interviewKey, type InterviewRecord } from "./interview.js";
import { newId, RECORD_ID, type KvStore } from "./store.js";
import type { Notify } from "./telegram.js";

/**
 * Request mode: a visitor with an access code submits a docs URL. The request
 * is stored as pending and the owner is notified; the owner reviews it, runs
 * it locally (npm run request:fulfil) and publishes the result to the static
 * site. Web-standard Request/Response, so it runs in a Netlify Function, a
 * test, or (later) the worker.
 *
 *   POST /api/requests       { code, url, goal?, interviewId? } -> 201 { id, status, createdAt }
 *   GET  /api/requests/<id>  -> { id, status, url, createdAt, updatedAt?, note? }
 *
 * The code name is never sent back to the browser.
 */

export type RequestStatus = "pending" | "done" | "declined";

export type ScoutRequest = {
  id: string;
  codeName: string;
  url: string;
  /** Optional: what the visitor wants to build; the run is scoped to it. Published with the result. */
  goal?: string;
  /** The interview that wrote the goal (src/access/interview.ts); its transcript is kept 14 days. */
  interviewId?: string;
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

const ID = RECORD_ID;

export const requestKey = (id: string) => `requests/${id}`;

export async function handleRequestApi(req: Request, deps: RequestApiDeps): Promise<Response> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((m: string) => console.error(m));
  const { json, fail, preflight } = jsonResponder(req, deps.allowedOrigins);

  const path = new URL(req.url).pathname.replace(/\/+$/, "");
  if (req.method === "OPTIONS") return preflight();

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
  let body: { code?: unknown; url?: unknown; goal?: unknown; interviewId?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return fail(400, "invalid_body", "Send JSON: { code, url, goal? }.");
  }
  if (typeof body.code !== "string" || typeof body.url !== "string" || body.code.length > 100 || body.url.length > 2000) {
    return fail(400, "invalid_body", "Send JSON: { code, url, goal? }.");
  }
  let goal: string | undefined;
  try {
    if (body.goal !== undefined && body.goal !== null && typeof body.goal !== "string") throw new Error("The goal must be text.");
    goal = normalizeGoal((body.goal as string | null | undefined) ?? undefined);
  } catch (err) {
    return fail(400, "invalid_goal", (err as Error).message);
  }

  if (body.interviewId !== undefined && (typeof body.interviewId !== "string" || !ID.test(body.interviewId))) {
    return fail(400, "invalid_body", "Send JSON: { code, url, goal? }.");
  }

  const at = now();
  const checked = await checkAccessCode(deps, body.code, at);
  if (!("code" in checked)) return fail(checked.status, checked.error, checked.message);
  const code = checked.code;

  // A linked interview must belong to the same code; it is marked as used below.
  let interview: InterviewRecord | undefined;
  if (typeof body.interviewId === "string") {
    interview = await deps.store.getJSON<InterviewRecord>(interviewKey(body.interviewId));
    if (!interview || interview.codeName !== code.name) return fail(400, "invalid_interview", "This conversation has expired. Please write the goal yourself.");
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

  const record: ScoutRequest = {
    id: newId(),
    codeName: code.name,
    url,
    ...(goal ? { goal } : {}),
    ...(interview ? { interviewId: interview.id } : {}),
    createdAt: at.toISOString(),
    status: "pending",
  };
  await deps.store.setJSON(requestKey(record.id), record);
  if (interview) await deps.store.setJSON(interviewKey(interview.id), { ...interview, status: "submitted", requestId: record.id });
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
