import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import type { Analysis } from "../src/core/schema.js";
import { runScout } from "../src/core/scout.js";
import { buildOutputs } from "../src/generators/index.js";
import { describePush, pushOutputDir, SYNC_FILE } from "../src/postman/push-dir.js";
import { checkNoCredentials, POSTMAN_API, PostmanPushError, pushToPostman } from "../src/postman/push.js";
import { ACME_OUTPUT, fakeRunner } from "./helpers/fake-runner.js";
import { ACME_ROOT, createFixtureFetcher } from "./helpers/fixtures.js";

// Fake keys are assembled at runtime so no key-shaped literal sits in the repo (secret scanners would flag it).
const KEY = ["PMAK", "0123456789abcdef", "0123456789abcdef0123456789"].join("-");
const FAKE_ANTHROPIC_KEY = ["sk", "ant", "api03", "abcdefghijklmnop"].join("-");

type Call = { method: string; url: string; headers: Record<string, string>; body: Record<string, unknown> };

/** A fake Postman API: records calls, answers like the real one, can be told to fail. */
function fakePostman(responses: Partial<Record<string, { status: number; json: object }>> = {}) {
  const calls: Call[] = [];
  let n = 0;
  const impl = (async (url: string, init: RequestInit) => {
    const call = { method: init.method!, url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) };
    calls.push(call);
    const key = `${call.method} ${url.replace(POSTMAN_API, "").replace(/\?.*$/, "")}`;
    const canned = responses[key];
    if (canned) return new Response(JSON.stringify(canned.json), { status: canned.status });
    const kind = url.includes("/collections") ? "collection" : "environment";
    const uid = url.match(/\/(?:collections|environments)\/([^/?]+)/)?.[1] ?? `12345-${kind}-${++n}`;
    return new Response(JSON.stringify({ [kind]: { id: uid.split("-").slice(1).join("-"), uid } }), { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

let outputs: ReturnType<typeof buildOutputs>;
let collection: Record<string, unknown>;
let environment: Record<string, unknown>;

beforeAll(async () => {
  const analysis: Analysis = await runScout(ACME_ROOT, {
    config: DEFAULT_CONFIG,
    fetcher: createFixtureFetcher(),
    runner: fakeRunner([{ fetch: ACME_ROOT }, { fetch: "/endpoints" }, { result: "success", output: ACME_OUTPUT }]),
  });
  outputs = buildOutputs(analysis);
  collection = JSON.parse(outputs.files["postman_collection.json"]!);
  environment = JSON.parse(outputs.files["postman_environment.json"]!);
});

describe("pushToPostman", () => {
  it("creates the collection and the environment in the workspace, with the key only in the header", async () => {
    const api = fakePostman();
    const result = await pushToPostman(collection, environment, { apiKey: KEY, workspaceId: "ws-1", fetch: api.impl, now: () => new Date("2026-10-17T10:00:00Z") });

    expect(api.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `POST ${POSTMAN_API}/collections?workspace=ws-1`,
      `POST ${POSTMAN_API}/environments?workspace=ws-1`,
    ]);
    expect(api.calls[0]!.headers["X-Api-Key"]).toBe(KEY);
    expect(JSON.stringify(api.calls.map((c) => c.body))).not.toContain(KEY);
    // The local id isn't sent; Postman assigns its own.
    expect((api.calls[0]!.body.collection as { info: object }).info).not.toHaveProperty("_postman_id");
    expect(api.calls[1]!.body).toEqual({ environment: { name: environment.name, values: environment.values } });

    expect(result.state).toEqual({ collectionUid: "12345-collection-1", environmentUid: "12345-environment-2", workspaceId: "ws-1", pushedAt: "2026-10-17T10:00:00.000Z" });
    expect(result.links.collection).toBe("https://go.postman.co/collection/12345-collection-1");
    expect(describePush(result)[0]).toBe("Postman: collection created, environment created.");
  });

  it("updates the same collection and environment on a rerun", async () => {
    const api = fakePostman();
    const previous = { collectionUid: "12345-c-old", environmentUid: "12345-e-old", pushedAt: "x" };
    const result = await pushToPostman(collection, environment, { apiKey: KEY, previous, fetch: api.impl });
    expect(api.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `PUT ${POSTMAN_API}/collections/12345-c-old`,
      `PUT ${POSTMAN_API}/environments/12345-e-old`,
    ]);
    expect(result.collection).toEqual({ uid: "12345-c-old", created: false });
  });

  it("recreates what was deleted in Postman since the last push", async () => {
    const api = fakePostman({ "PUT /collections/12345-c-old": { status: 404, json: { error: { name: "instanceNotFoundError" } } } });
    const previous = { collectionUid: "12345-c-old", environmentUid: "12345-e-old", pushedAt: "x" };
    const result = await pushToPostman(collection, environment, { apiKey: KEY, previous, fetch: api.impl });
    expect(api.calls.map((c) => c.method)).toEqual(["PUT", "POST", "PUT"]);
    expect(result.collection.created).toBe(true);
    expect(result.environment.created).toBe(false);
  });

  it("creates new copies when the workspace changed", async () => {
    const api = fakePostman();
    const previous = { collectionUid: "12345-c-old", environmentUid: "12345-e-old", workspaceId: "ws-old", pushedAt: "x" };
    await pushToPostman(collection, environment, { apiKey: KEY, workspaceId: "ws-new", previous, fetch: api.impl });
    expect(api.calls.map((c) => c.method)).toEqual(["POST", "POST"]);
  });

  it("explains API errors without showing the key", async () => {
    const api = fakePostman({ "POST /collections": { status: 401, json: { error: { name: "AuthenticationError", message: "Invalid API Key." } } } });
    const err = await pushToPostman(collection, environment, { apiKey: KEY, fetch: api.impl }).catch((e) => e);
    expect(err).toBeInstanceOf(PostmanPushError);
    expect(err.message).toBe(
      "Postman API error while creating the collection (HTTP 401, AuthenticationError: Invalid API Key.). Check POSTMAN_API_KEY in .env (Postman > Settings > API keys).",
    );
    expect(err.message).not.toContain(KEY);
    expect(api.calls).toHaveLength(1);
  });

  it("needs a key and sends nothing without one", async () => {
    const api = fakePostman();
    await expect(pushToPostman(collection, environment, { apiKey: " ", fetch: api.impl })).rejects.toThrow("POSTMAN_API_KEY is not set");
    expect(api.calls).toHaveLength(0);
  });
});

describe("checkNoCredentials", () => {
  const clone = <T>(v: T): T => structuredClone(v);

  it("accepts Scout's outputs: only {{variables}} and public URLs", () => {
    expect(() => checkNoCredentials(collection, environment)).not.toThrow();
  });

  it("refuses a filled-in secret in the environment", () => {
    const env = clone(environment) as { values: { key: string; value: string }[] };
    env.values.find((v) => v.key === "apiKey")!.value = "my-real-key-123";
    expect(() => checkNoCredentials(collection, env)).toThrow('environment value "apiKey" is a secret but not empty');
  });

  it("refuses non-URL values in the environment", () => {
    const env = clone(environment) as { values: { key: string; value: string; type: string }[] };
    env.values.push({ key: "region", value: "hunter2", type: "default" });
    expect(() => checkNoCredentials(collection, env)).toThrow('environment value "region" is not empty and not a public URL');
  });

  it("refuses a credential in an auth block instead of a {{variable}}", () => {
    const c = clone(collection) as { auth: { apikey: { key: string; value: string }[] } };
    c.auth.apikey.find((kv) => kv.key === "value")!.value = "abc123secret";
    expect(() => checkNoCredentials(c, environment)).toThrow("collection.auth.apikey.value has a value instead of a {{variable}}");
  });

  it("refuses known credential formats and the user's own .env values anywhere", () => {
    const c = clone(collection) as { info: { description: string } };
    c.info.description += `\n${FAKE_ANTHROPIC_KEY}`;
    expect(() => checkNoCredentials(c, environment)).toThrow("looks like an Anthropic API key");
    const d = clone(collection) as { info: { description: string } };
    d.info.description += "\nTarget token: zz-target-token-42";
    expect(() => checkNoCredentials(d, environment, ["zz-target-token-42"])).toThrow("contains one of your credentials from .env");
  });

  it("doesn't flag the example tokens docs often quote", () => {
    const c = clone(collection) as { info: { description: string } };
    c.info.description += "\nAuthorization: Bearer YOUR_ACCESS_TOKEN_HERE\nAKIAIOSFODNN7EXAMPLE";
    expect(() => checkNoCredentials(c, environment)).not.toThrow();
  });
});

describe("pushOutputDir", () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("pushes an output folder, saves the ids, and updates on the next push", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "scout-push-"));
    for (const name of ["postman_collection.json", "postman_environment.json"]) await writeFile(path.join(dir, name), outputs.files[name]!);
    const api = fakePostman();

    const first = await pushOutputDir(dir, { POSTMAN_API_KEY: KEY }, api.impl);
    const saved = JSON.parse(await readFile(path.join(dir, SYNC_FILE), "utf8"));
    expect(saved).toEqual(first.state);
    expect(JSON.stringify(saved)).not.toContain(KEY);

    await pushOutputDir(dir, { POSTMAN_API_KEY: KEY }, api.impl);
    expect(api.calls.map((c) => c.method)).toEqual(["POST", "POST", "PUT", "PUT"]);
  });

  it("refuses to upload the user's other credentials, and writes nothing", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "scout-push-"));
    const leaked = JSON.parse(outputs.files["postman_collection.json"]!);
    leaked.info.description += "\nkey: sk-test-target-0001";
    await writeFile(path.join(dir, "postman_collection.json"), JSON.stringify(leaked));
    await writeFile(path.join(dir, "postman_environment.json"), outputs.files["postman_environment.json"]!);
    const api = fakePostman();
    await expect(pushOutputDir(dir, { POSTMAN_API_KEY: KEY, TARGET_API_TOKEN: "sk-test-target-0001" }, api.impl)).rejects.toThrow(
      "Nothing was uploaded",
    );
    expect(api.calls).toHaveLength(0);
    await expect(readFile(path.join(dir, SYNC_FILE), "utf8")).rejects.toThrow();
  });

  it("says what is missing", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "scout-push-"));
    await expect(pushOutputDir(dir, { POSTMAN_API_KEY: KEY })).rejects.toThrow("No postman_collection.json in");
  });
});
