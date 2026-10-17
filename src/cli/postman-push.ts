import path from "node:path";
import { describePush, pushOutputDir } from "../postman/push-dir.js";
import { PostmanPushError } from "../postman/push.js";

const USAGE = `Usage: npm run postman:push -- <output folder>

Pushes the folder's postman_collection.json and postman_environment.json into
your Postman workspace (no paid run). Pushing the same folder again updates them.

Needs POSTMAN_API_KEY in .env (Postman > Settings > API keys).
Optional: POSTMAN_WORKSPACE_ID (default: your default workspace).`;

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0] === "-h" || args[0] === "--help") {
    console.log(USAGE);
    return args.length === 1 ? 0 : 1;
  }
  try {
    const result = await pushOutputDir(path.resolve(args[0]!), process.env);
    for (const line of describePush(result)) console.log(line);
    return 0;
  } catch (err) {
    console.error(err instanceof PostmanPushError ? err.message : `Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

main().then((code) => {
  process.exitCode = code;
});
