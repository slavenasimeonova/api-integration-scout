import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { PostmanPushError, pushToPostman, type PushResult, type SyncState } from "./push.js";

export const SYNC_FILE = "postman-sync.json";

type Env = Record<string, string | undefined>;

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new PostmanPushError(`Could not read ${path.basename(file)}: ${(err as Error).message}`);
  }
}

/**
 * Pushes an output folder's postman_collection.json and postman_environment.json
 * to Postman and records the ids in postman-sync.json (no secrets), so the next
 * push of the same folder updates them. The key comes from POSTMAN_API_KEY.
 */
export async function pushOutputDir(dir: string, env: Env, fetchImpl?: typeof fetch): Promise<PushResult> {
  const collection = await readJson<Record<string, unknown>>(path.join(dir, "postman_collection.json"));
  if (!collection) throw new PostmanPushError(`No postman_collection.json in ${dir}.`);
  const environment = await readJson<Record<string, unknown>>(path.join(dir, "postman_environment.json"));
  if (!environment) throw new PostmanPushError(`No postman_environment.json in ${dir}.`);
  const previous = await readJson<SyncState>(path.join(dir, SYNC_FILE));

  const result = await pushToPostman(collection, environment, {
    apiKey: env.POSTMAN_API_KEY ?? "",
    workspaceId: env.POSTMAN_WORKSPACE_ID?.trim() || undefined,
    previous,
    // Never upload any credential the user keeps in .env.
    knownSecrets: [env.ANTHROPIC_API_KEY, env.TARGET_API_TOKEN, env.NETLIFY_AUTH_TOKEN].filter((s): s is string => !!s),
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
  await writeFile(path.join(dir, SYNC_FILE), JSON.stringify(result.state, null, 2) + "\n", "utf8");
  return result;
}

/** ASCII summary lines for the CLI. */
export function describePush(result: PushResult): string[] {
  const verb = (created: boolean) => (created ? "created" : "updated");
  return [
    `Postman: collection ${verb(result.collection.created)}, environment ${verb(result.environment.created)}.`,
    `  Collection:  ${result.links.collection}`,
    `  Environment: ${result.links.environment}`,
    "  In Postman, select the environment, then fill in the empty values (credentials, and baseUrl if it lists options).",
  ];
}
