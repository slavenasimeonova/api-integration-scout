import { parseArgs } from "node:util";
import { formatEntry, generateCode, hashCode, validateName } from "../src/access/index.js";

/**
 * Creates an access code for one person.
 * Usage: npm run code:new -- <name> [--per-day 3] [--total 10]
 * Prints the code once (give it to the person) and the ACCESS_CODES entry
 * (add it in Netlify). Neither is saved anywhere by this script.
 */

const USAGE = "Usage: npm run code:new -- <name> [--per-day 3] [--total 10]   (name: e.g. recruiter-acme)";

function positive(flag: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--${flag} must be a positive whole number`);
  return n;
}

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { "per-day": { type: "string", default: "3" }, total: { type: "string", default: "10" } },
  });
  if (positionals.length !== 1) throw new Error(USAGE);
  const name = validateName(positionals[0]!);
  const perDay = positive("per-day", values["per-day"]);
  const total = positive("total", values.total);
  const code = generateCode();
  const entry = formatEntry({ name, perDay, total, hash: hashCode(code) });

  console.log(`Access code for ${name} (${perDay} per day, ${total} in total):

  ${code}

Give this code to ${name}. It is shown only once and is not saved anywhere.

Add this entry to ACCESS_CODES in Netlify (entries are separated by commas):

  ${entry}

Then redeploy the Netlify project (Deploys > Trigger deploy > Deploy project). See docs/requests.md.`);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
