import { parseArgs } from "node:util";
import { listRequests } from "../src/access/index.js";
import { describeRequest, openRequestStore } from "./requests-lib.js";

/**
 * Lists requests from the Netlify store, oldest first. Pending only by default,
 * so a request whose Telegram message failed is never missed.
 * Usage: npm run request:list [-- --all]
 */

try {
  const { values } = parseArgs({ options: { all: { type: "boolean", default: false } } });
  const requests = await listRequests(openRequestStore(), { all: values.all });
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
