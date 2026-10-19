import { normalizeGoal, MAX_GOAL_CHARS } from "../core/goal.js";
import { checkAccessCode, type AccessCode } from "./codes.js";
import { jsonResponder } from "./http.js";
import { FINISH_NOTE, INTERVIEW_SYSTEM, OPENING_QUESTION, REDIRECT_REPLY, wrapDocsUrl, wrapVisitor } from "./interview-prompt.js";
import { newId, RECORD_ID, type KvStore } from "./store.js";

/**
 * The goal interviewer: after a valid access code, a short chat in which a
 * cheap model asks up to 6 questions and writes the goal; the visitor edits it
 * and sends it with the request (POST /api/requests { ..., interviewId }).
 * Web-standard Request/Response, like requests.ts.
 *
 *   POST /api/interview        { code, url }            -> 201 { id, message, questionsLeft } | 200 { interview: false }
 *   GET  /api/interview/<id>                            -> { status, turns, questionsLeft, goal? }
 *   POST /api/interview/<id>   { message?, finish? }    -> { status, message, questionsLeft, goal? }
 *
 * Limits are enforced here, never by the prompt. Transcripts are kept for
 * KEEP_DAYS and then deleted by pruneInterviews (a daily scheduled function).
 */

export const INTERVIEW_LIMITS = {
  /** Questions per conversation, the fixed opening question included. */
  maxQuestions: 6,
  maxMessageChars: 500,
  /** Input + output tokens per conversation; past this, the next reply must be the goal. */
  maxTokens: 20_000,
  idleMinutes: 30,
  perCodePerDay: 5,
  perCodeTotal: 20,
  globalPerDay: 50,
  keepDays: 14,
};

export type InterviewTurn = { role: "assistant" | "visitor"; text: string; at: string };

export type InterviewRecord = {
  id: string;
  codeName: string;
  docsUrl: string;
  createdAt: string;
  updatedAt: string;
  /** When pruneInterviews deletes it. */
  expiresAt: string;
  /** open: chatting; goal: the goal is written; submitted: a request uses it. */
  status: "open" | "goal" | "submitted";
  turns: InterviewTurn[];
  questions: number;
  tokens: number;
  goal?: string;
  requestId?: string;
};

export type InterviewReply = { kind: "question" | "goal"; text: string; goal: string };

/** One model call. A null reply means the output didn't parse; refused means the model declined. */
export type InterviewModel = (input: {
  system: string;
  messages: { role: "user" | "assistant"; content: string }[];
}) => Promise<{ reply: InterviewReply | null; refused?: boolean; inputTokens: number; outputTokens: number }>;

export type InterviewApiDeps = {
  store: KvStore;
  codes: AccessCode[];
  /** Missing (kill switch off, or no API key): a valid code gets { interview: false } and the plain goal field. */
  model?: InterviewModel;
  /** The request kill switch; when off, no interview starts either. */
  requestsEnabled: boolean;
  allowedOrigins: string[];
  checkUrl: (url: string) => Promise<void>;
  clientIp?: string;
  ipSalt: string;
  limits?: typeof INTERVIEW_LIMITS;
  now?: () => Date;
  log?: (message: string) => void;
};

export const interviewKey = (id: string) => `interviews/${id}`;

const counterKeys = (codeName: string, day: string) => ({
  day: `counters/${codeName}/interviews/day/${day}`,
  total: `counters/${codeName}/interviews/total`,
  // Code names start with a letter or digit, so "_global" can't collide.
  global: `counters/_global/interviews/day/${day}`,
});

const questionsLeft = (r: InterviewRecord, limits: typeof INTERVIEW_LIMITS) =>
  r.status === "open" ? Math.max(0, limits.maxQuestions - r.questions) : 0;

export async function handleInterviewApi(req: Request, deps: InterviewApiDeps): Promise<Response> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((m: string) => console.error(m));
  const limits = deps.limits ?? INTERVIEW_LIMITS;
  const { json, fail, preflight } = jsonResponder(req, deps.allowedOrigins);

  const path = new URL(req.url).pathname.replace(/\/+$/, "");
  if (req.method === "OPTIONS") return preflight();

  const body = async <T>(): Promise<T | undefined> => {
    try {
      return (await req.json()) as T;
    } catch {
      return undefined;
    }
  };

  // Start a conversation.
  if (path === "/api/interview" && req.method === "POST") {
    if (!deps.requestsEnabled) return fail(503, "paused", "Requests are paused right now. Please try again later.");
    const input = await body<{ code?: unknown; url?: unknown }>();
    if (!input || typeof input.code !== "string" || typeof input.url !== "string" || input.code.length > 100 || input.url.length > 2000) {
      return fail(400, "invalid_body", "Send JSON: { code, url }.");
    }
    const at = now();
    const checked = await checkAccessCode(deps, input.code, at);
    if (!("code" in checked)) return fail(checked.status, checked.error, checked.message);
    const url = input.url.trim();
    try {
      await deps.checkUrl(url);
    } catch (err) {
      return fail(400, "invalid_url", err instanceof Error ? err.message : "This URL can't be used.");
    }
    if (!deps.model) return json(200, { interview: false });

    const keys = counterKeys(checked.code.name, at.toISOString().slice(0, 10));
    const count = async (key: string) => (await deps.store.getJSON<{ count: number }>(key))?.count ?? 0;
    const [today, total, global] = await Promise.all([count(keys.day), count(keys.total), count(keys.global)]);
    // Over a limit, the visitor can still write the goal by hand and send the request.
    if (global >= limits.globalPerDay) return fail(429, "interview_limit_global", "The goal assistant is busy today. Please write the goal yourself.");
    if (total >= limits.perCodeTotal) return fail(429, "interview_limit_total", "This code has used all its conversations. Please write the goal yourself.");
    if (today >= limits.perCodePerDay) return fail(429, "interview_limit_day", "This code has used today's conversations. Please write the goal yourself.");

    const iso = at.toISOString();
    const record: InterviewRecord = {
      id: newId(),
      codeName: checked.code.name,
      docsUrl: url,
      createdAt: iso,
      updatedAt: iso,
      expiresAt: new Date(at.getTime() + limits.keepDays * 86_400_000).toISOString(),
      status: "open",
      turns: [{ role: "assistant", text: OPENING_QUESTION, at: iso }],
      questions: 1,
      tokens: 0,
    };
    await deps.store.setJSON(interviewKey(record.id), record);
    await deps.store.setJSON(keys.day, { count: today + 1 });
    await deps.store.setJSON(keys.total, { count: total + 1 });
    await deps.store.setJSON(keys.global, { count: global + 1 });
    return json(201, { id: record.id, message: OPENING_QUESTION, questionsLeft: questionsLeft(record, limits) });
  }

  const match = /^\/api\/interview\/([^/]+)$/.exec(path);
  if (!match || (req.method !== "GET" && req.method !== "POST")) return fail(404, "not_found", "Not found");
  const id = match[1]!;
  const record = RECORD_ID.test(id) ? await deps.store.getJSON<InterviewRecord>(interviewKey(id)) : undefined;
  if (!record) return fail(404, "not_found", "This conversation has expired. Please write the goal yourself.");

  if (req.method === "GET") {
    // The code name stays on the server.
    return json(200, {
      status: record.status,
      turns: record.turns.map(({ role, text }) => ({ role, text })),
      questionsLeft: questionsLeft(record, limits),
      ...(record.goal !== undefined ? { goal: record.goal } : {}),
    });
  }

  // One visitor turn.
  if (record.status !== "open") return fail(409, "interview_finished", "This conversation is finished. Edit the goal below.");
  const at = now();
  if (at.getTime() - Date.parse(record.updatedAt) > limits.idleMinutes * 60_000) {
    return fail(410, "interview_idle", "This conversation timed out. Please write the goal yourself.");
  }
  if (!deps.model) return fail(503, "interview_unavailable", "The goal assistant is unavailable. Please write the goal yourself.");
  const input = await body<{ message?: unknown; finish?: unknown }>();
  const message = typeof input?.message === "string" ? input.message.trim() : "";
  const finish = input?.finish === true;
  if (!input || (input.message !== undefined && typeof input.message !== "string")) return fail(400, "invalid_body", "Send JSON: { message, finish? }.");
  if (message.length > limits.maxMessageChars) return fail(400, "message_too_long", `Please keep each answer under ${limits.maxMessageChars} characters.`);
  if (!message && !finish) return fail(400, "empty_message", "Please type an answer.");

  const turns: InterviewTurn[] = message ? [...record.turns, { role: "visitor", text: message, at: at.toISOString() }] : record.turns;
  const iso = at.toISOString();
  const finished = (goal: string, text: string, tokens: number): InterviewRecord => ({
    ...record,
    turns: [...turns, { role: "assistant", text, at: iso }],
    updatedAt: iso,
    status: "goal",
    goal,
    tokens,
  });

  // Nothing to summarize yet: the visitor writes the goal.
  if (!turns.some((t) => t.role === "visitor")) {
    const updated = finished("", "Please write the goal in your own words below.", record.tokens);
    await deps.store.setJSON(interviewKey(id), updated);
    return json(200, { status: updated.status, message: updated.turns.at(-1)!.text, goal: "", questionsLeft: 0 });
  }

  const mustFinish = finish || record.questions >= limits.maxQuestions || record.tokens >= limits.maxTokens;
  let result: Awaited<ReturnType<InterviewModel>>;
  try {
    result = await deps.model({
      system: mustFinish ? INTERVIEW_SYSTEM + FINISH_NOTE : INTERVIEW_SYSTEM,
      messages: [
        { role: "user", content: `${wrapDocsUrl(record.docsUrl)}\nThe visitor is ready.` },
        ...turns.map((t) =>
          t.role === "visitor"
            ? { role: "user" as const, content: wrapVisitor(t.text) }
            : { role: "assistant" as const, content: JSON.stringify({ kind: "question", text: t.text, goal: "" }) },
        ),
      ],
    });
  } catch (err) {
    // Nothing is saved, so the visitor can retry the same answer.
    log(`[interview] model call failed for ${id}: ${err instanceof Error ? err.message : String(err)}`);
    return fail(502, "assistant_unavailable", "The goal assistant didn't answer. Try again, or write the goal yourself.");
  }
  const tokens = record.tokens + result.inputTokens + result.outputTokens;
  const reply = result.refused ? { kind: "question" as const, text: REDIRECT_REPLY, goal: "" } : result.reply;

  let updated: InterviewRecord;
  if (reply?.kind === "goal") {
    updated = finished(cleanGoal(reply.goal), clip(reply.text, 300) || "Here is your goal. Edit it if needed.", tokens);
  } else if (reply && !mustFinish) {
    const text = clip(reply.text, 300);
    updated = { ...record, turns: [...turns, { role: "assistant", text, at: iso }], updatedAt: iso, questions: record.questions + 1, tokens };
  } else {
    // A question when the goal was due, or output that didn't parse: the visitor writes the goal.
    updated = finished("", "Please write the goal in your own words below.", tokens);
  }
  await deps.store.setJSON(interviewKey(id), updated);
  return json(200, {
    status: updated.status,
    message: updated.turns.at(-1)!.text,
    questionsLeft: questionsLeft(updated, limits),
    ...(updated.status === "goal" ? { goal: updated.goal ?? "" } : {}),
  });
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/** The goal as normalizeGoal accepts it; over the limit, cut at the last word that fits. */
export function cleanGoal(goal: string): string {
  let text = goal.replace(/\s+/g, " ").trim();
  if (text.length > MAX_GOAL_CHARS) text = text.slice(0, MAX_GOAL_CHARS + 1).replace(/\s+\S*$/, "");
  return normalizeGoal(text) ?? "";
}

/** Deletes transcripts past expiresAt. Returns how many were deleted. */
export async function pruneInterviews(store: KvStore, now = new Date()): Promise<number> {
  let deleted = 0;
  for (const key of await store.list("interviews/")) {
    const record = await store.getJSON<InterviewRecord>(key);
    if (!record || Date.parse(record.expiresAt) <= now.getTime()) {
      await store.delete(key);
      deleted++;
    }
  }
  return deleted;
}
