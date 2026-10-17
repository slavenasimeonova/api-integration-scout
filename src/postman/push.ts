/**
 * Pushes a generated collection and its environment template into the user's
 * Postman workspace via the Postman API, so they open it in Postman without
 * importing files. Reruns update the same collection and environment (their
 * ids are kept in postman-sync.json next to the outputs).
 *
 * Safety: the Postman API key is sent only in the X-Api-Key header and never
 * printed. Before anything is uploaded, checkNoCredentials() refuses to push if
 * a value looks like a credential: Scout's outputs only ever hold {{variables}}
 * and public URLs, so anything else means something went wrong.
 */

export const POSTMAN_API = "https://api.postman.com";

export type SyncState = {
  collectionUid: string;
  environmentUid: string;
  workspaceId?: string;
  pushedAt: string;
};

export type PushOptions = {
  apiKey: string;
  /** Target workspace; without it, Postman uses the account's default workspace. */
  workspaceId?: string;
  /** From a previous push: update these instead of creating new ones. */
  previous?: SyncState | null;
  /** Values that must never be uploaded (e.g. the Anthropic key, TARGET_API_TOKEN). */
  knownSecrets?: string[];
  fetch?: typeof fetch;
  now?: () => Date;
};

export type PushResult = {
  state: SyncState;
  collection: { uid: string; created: boolean };
  environment: { uid: string; created: boolean };
  links: { collection: string; environment: string };
};

export class PostmanPushError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "PostmanPushError";
  }
}

type Json = Record<string, unknown>;

/**
 * Vendor-prefixed credentials. Generic shapes (any "Bearer xyz", JWTs) are left
 * out on purpose: docs quote placeholder tokens like those all the time, and
 * the structural checks below (auth fields, environment values) and the exact
 * values from .env cover what Scout itself could leak.
 */
const SECRET_PATTERNS: [RegExp, string][] = [
  [/sk-ant-[A-Za-z0-9_-]{10,}/, "an Anthropic API key"],
  [/PMAK-[A-Za-z0-9-]{10,}/, "a Postman API key"],
  [/\bAKIA(?![0-9A-Z]*EXAMPLE)[0-9A-Z]{16}\b/, "an AWS access key"],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/, "a GitHub token"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key"],
];

/** Auth fields that hold credentials: their value must be empty or a {{variable}}. */
const AUTH_SECRET_KEYS = new Set(["token", "accesstoken", "password", "clientsecret", "clientid", "value", "username", "refreshtoken"]);

const isVariableOrEmpty = (v: unknown) => v === undefined || v === "" || (typeof v === "string" && /^\{\{[\w.-]+\}\}$/.test(v.trim()));

/**
 * Throws if the collection or environment holds anything that looks like a
 * credential. Environment values must be empty, except public URLs; secret-type
 * values must always be empty.
 */
export function checkNoCredentials(collection: Json, environment: Json, knownSecrets: string[] = []): void {
  const problems: string[] = [];
  const secrets = knownSecrets.filter((s) => s && s.length >= 8);

  const scan = (value: unknown, where: string): void => {
    if (typeof value === "string") {
      for (const [re, what] of SECRET_PATTERNS) if (re.test(value)) problems.push(`${where} contains what looks like ${what}`);
      if (secrets.some((s) => value.includes(s))) problems.push(`${where} contains one of your credentials from .env`);
    } else if (Array.isArray(value)) value.forEach((v, i) => scan(v, `${where}[${i}]`));
    else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) scan(v, `${where}.${k}`);
  };
  scan(collection, "collection");
  scan(environment, "environment");

  // Every auth block (collection, folders, requests): credential fields only as {{variables}}.
  const checkAuth = (node: unknown, where: string): void => {
    if (Array.isArray(node)) return node.forEach((n, i) => checkAuth(n, `${where}[${i}]`));
    if (!node || typeof node !== "object") return;
    const obj = node as Json;
    if (obj.auth && typeof obj.auth === "object") {
      const auth = obj.auth as Json;
      for (const [type, entries] of Object.entries(auth)) {
        if (!Array.isArray(entries)) continue;
        for (const kv of entries as { key?: string; value?: unknown }[]) {
          if (kv.key && AUTH_SECRET_KEYS.has(kv.key.toLowerCase()) && !isVariableOrEmpty(kv.value)) {
            // apikey's "key" entry is the header name; its "value" entry is the credential.
            problems.push(`${where}.auth.${type}.${kv.key} has a value instead of a {{variable}}`);
          }
        }
      }
    }
    for (const [k, v] of Object.entries(obj)) if (k !== "auth") checkAuth(v, `${where}.${k}`);
  };
  checkAuth(collection, "collection");

  const values = Array.isArray(environment.values) ? (environment.values as { key?: string; value?: unknown; type?: string }[]) : [];
  for (const v of values) {
    if (isVariableOrEmpty(v.value)) continue;
    if (v.type === "secret") problems.push(`environment value "${v.key}" is a secret but not empty`);
    else if (typeof v.value !== "string" || !/^https?:\/\/\S+$/.test(v.value)) problems.push(`environment value "${v.key}" is not empty and not a public URL`);
  }

  if (problems.length) {
    throw new PostmanPushError(`Refusing to push: ${problems.join("; ")}. Nothing was uploaded.`);
  }
}

/** The collection as the Postman API expects it: no local id. */
function collectionBody(collection: Json): Json {
  const info = { ...(collection.info as Json) };
  delete info._postman_id;
  return { collection: { ...collection, info } };
}

function environmentBody(environment: Json): Json {
  const { name, values } = environment;
  return { environment: { name, values } };
}

async function call(opts: PushOptions, method: "POST" | "PUT", path: string, body: Json): Promise<{ status: number; json: Json }> {
  const doFetch = opts.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`${POSTMAN_API}${path}`, {
      method,
      headers: { "X-Api-Key": opts.apiKey, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new PostmanPushError(`Could not reach the Postman API: ${err instanceof Error ? err.message : String(err)}`);
  }
  let json: Json = {};
  try {
    json = (await res.json()) as Json;
  } catch {
    // Some errors have no JSON body.
  }
  return { status: res.status, json };
}

function apiError(what: string, status: number, json: Json): PostmanPushError {
  const error = (json.error ?? {}) as { name?: string; message?: string };
  const hint =
    status === 401
      ? " Check POSTMAN_API_KEY in .env (Postman > Settings > API keys)."
      : status === 403
        ? " The key can't write to that workspace; check POSTMAN_WORKSPACE_ID."
        : status === 429
          ? " Rate limited by Postman; try again in a minute."
          : "";
  const detail = [error.name, error.message].filter(Boolean).join(": ");
  return new PostmanPushError(`Postman API error while ${what} (HTTP ${status}${detail ? `, ${detail}` : ""}).${hint}`, status);
}

/** Creates (or, with a previous uid, updates) one collection or environment. A deleted one is recreated. */
async function upsert(
  opts: PushOptions,
  kind: "collection" | "environment",
  previousUid: string | undefined,
  body: Json,
): Promise<{ uid: string; created: boolean }> {
  const plural = kind === "collection" ? "collections" : "environments";
  const query = opts.workspaceId ? `?workspace=${encodeURIComponent(opts.workspaceId)}` : "";
  if (previousUid) {
    const res = await call(opts, "PUT", `/${plural}/${encodeURIComponent(previousUid)}`, body);
    if (res.status >= 200 && res.status < 300) return { uid: previousUid, created: false };
    // Deleted in Postman since the last push: create a new one below.
    if (res.status !== 404) throw apiError(`updating the ${kind}`, res.status, res.json);
  }
  const res = await call(opts, "POST", `/${plural}${query}`, body);
  if (res.status < 200 || res.status >= 300) throw apiError(`creating the ${kind}`, res.status, res.json);
  const uid = ((res.json[kind] ?? {}) as { uid?: unknown }).uid;
  if (typeof uid !== "string" || !uid) throw new PostmanPushError(`Postman created the ${kind} but returned no id.`);
  return { uid, created: true };
}

/** Pushes the collection and environment. Checks for credentials first; nothing is sent if the check fails. */
export async function pushToPostman(collection: Json, environment: Json, opts: PushOptions): Promise<PushResult> {
  if (!opts.apiKey?.trim()) throw new PostmanPushError("POSTMAN_API_KEY is not set. Add it to .env (Postman > Settings > API keys).");
  checkNoCredentials(collection, environment, [opts.apiKey, ...(opts.knownSecrets ?? [])]);

  // A different workspace than last time means new copies there, not updates of the old ones.
  const previous = opts.previous && (opts.previous.workspaceId ?? "") === (opts.workspaceId ?? "") ? opts.previous : null;
  const c = await upsert(opts, "collection", previous?.collectionUid, collectionBody(collection));
  const e = await upsert(opts, "environment", previous?.environmentUid, environmentBody(environment));
  const state: SyncState = {
    collectionUid: c.uid,
    environmentUid: e.uid,
    ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}),
    pushedAt: (opts.now ?? (() => new Date()))().toISOString(),
  };
  return {
    state,
    collection: c,
    environment: e,
    links: { collection: `https://go.postman.co/collection/${c.uid}`, environment: `https://go.postman.co/environment/${e.uid}` },
  };
}
