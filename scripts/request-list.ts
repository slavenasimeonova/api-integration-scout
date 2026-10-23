import { parseArgs } from "node:util";
import { LAST_MODEL_ERROR_KEY, listRequests, pruneInterviews, type ModelErrorSummary } from "../src/access/index.js";
import { describeRequest, openRequestStore, utc } from "./requests-lib.js";

/**
 * Lists requests from the Netlify store, oldest first. Pending only by default,
 * so a request whose Telegram message failed is never missed. Also deletes
 * interview transcripts past their 14 days (a daily function does it too), and
 * shows the goal assistant's last failed model call, if any.
 * Usage: npm run request:list [-- --all]
 */

try {
  const { values } = parseArgs({ options: { all: { type: "boolean", default: false } } });
  const store = openRequestStore();
  const pruned = await pruneInterviews(store);
  if (pruned) console.log(`Deleted ${pruned} interview transcript(s) older than 14 days.\n`);
  const lastError = await store.getJSON<ModelErrorSummary>(LAST_MODEL_ERROR_KEY);
  if (lastError) {
    const status = lastError.status ? ` ${lastError.status}` : "";
    const request = lastError.requestId ? ` (${lastError.requestId})` : "";
    console.log(`Goal assistant, last failed model call: ${utc(lastError.at)}, ${lastError.name}${status}${request}\n  ${lastError.message}\n`);
  }
  const requests = await listRequests(store, { all: values.all });
  if (!requests.length) {
    console.log(values.all ? "No requests yet." : "No pending requests.");
  } else {
    console.log(`${requests.length} ${values.all ? "" : "pending "}request${requests.length === 1 ? "" : "s"}:\n`);
    for (const r of requests) console.log(`${describeRequest(r)}\n`);
    console.log("Review one: npm.cmd run request:fulfil -- <id>");
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
