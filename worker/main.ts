import { randomBytes } from "node:crypto";
import { loadConfig } from "../src/core/index.js";
import { DEFAULT_LIMITS, MemoryStore, RunLimiter } from "./limits.js";
import { createSafeFetcher } from "./safe-fetch.js";
import { createWorkerServer } from "./server.js";

// Entry point: npm run worker (reads .env locally; on a host, set env vars there).

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is not set. Use a key from the dedicated demo workspace.");
  process.exit(1);
}

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number, got "${raw}"`);
  return n;
}

const config = loadConfig();
const limiter = new RunLimiter(
  new MemoryStore(),
  {
    perVisitorRuns: positiveInt("LIMIT_RUNS_PER_VISITOR", DEFAULT_LIMITS.perVisitorRuns),
    globalRuns: positiveInt("LIMIT_RUNS_PER_DAY", DEFAULT_LIMITS.globalRuns),
    globalUsd: positiveInt("LIMIT_USD_PER_DAY", DEFAULT_LIMITS.globalUsd),
    maxConcurrent: positiveInt("LIMIT_CONCURRENT_RUNS", DEFAULT_LIMITS.maxConcurrent),
    perRunUsd: config.maxBudgetUsd,
  },
  process.env.VISITOR_SALT || randomBytes(16).toString("hex"),
);

const server = createWorkerServer({
  config,
  limiter,
  fetcher: createSafeFetcher({ timeoutMs: config.fetchTimeoutMs }),
  secret: process.env.WORKER_SECRET || undefined,
  clientIpHeader: process.env.CLIENT_IP_HEADER || undefined,
});

const port = positiveInt("PORT", 8787);
server.listen(port, () => {
  console.log(JSON.stringify({ at: new Date().toISOString(), event: "listening", port, model: config.model, maxPages: config.maxPages }));
});
