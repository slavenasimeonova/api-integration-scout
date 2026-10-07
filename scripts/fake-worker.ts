import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import type { AgentRunner } from "../src/core/scout.js";
import { ACME_ROOT, createFixtureFetcher } from "../tests/helpers/fixtures.js";
import { ACME_OUTPUT } from "../tests/helpers/fake-runner.js";
import { DEFAULT_LIMITS, MemoryStore, RunLimiter } from "../worker/limits.js";
import { BlockedUrlError } from "../worker/safe-fetch.js";
import { createWorkerServer } from "../worker/server.js";

/**
 * Offline worker for UI development: the real worker's HTTP API and limits,
 * but a scripted, slowed-down agent reading the Acme test fixtures. No API key,
 * no network, no cost. In the web UI, paste https://docs.acmeweather.example/
 *
 * Usage: npm run worker:fake (then npm run dev in web/)
 */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let messageId = 0;
const usage = (inputTokens: number) =>
  ({ type: "assistant", message: { id: `m${++messageId}`, usage: { input_tokens: inputTokens, output_tokens: 100 }, content: [] } }) as unknown as SDKMessage;

const runner: AgentRunner = async function* ({ tools }) {
  await tools.fetchPage(ACME_ROOT);
  yield usage(3000);
  await sleep(700);
  tools.reportProgress("auth_found", "API key in X-Api-Key header");
  await sleep(700);
  await tools.fetchPage("/endpoints");
  yield usage(4000);
  await sleep(700);
  tools.reportProgress("endpoint_found", "GET /forecast");
  await sleep(700);
  await tools.fetchPage("/app"); // low-text page: triggers the JS-rendering warning
  await sleep(700);
  tools.reportProgress("not_found", "No versioning policy");
  await sleep(700);
  yield {
    type: "result",
    subtype: "success",
    structured_output: ACME_OUTPUT,
    usage: { input_tokens: 7000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    total_cost_usd: 0.0321,
    num_turns: 4,
    duration_ms: 4200,
  } as unknown as SDKMessage;
};

const server = createWorkerServer({
  config: DEFAULT_CONFIG,
  limiter: new RunLimiter(new MemoryStore(), { ...DEFAULT_LIMITS, perRunUsd: DEFAULT_CONFIG.maxBudgetUsd }, "dev"),
  fetcher: createFixtureFetcher(),
  checkStartUrl: async (url) => {
    if (!url.startsWith(ACME_ROOT)) throw new BlockedUrlError(`The fake worker only knows ${ACME_ROOT}`);
    return [];
  },
  runner,
});
server.listen(8787, () => console.log(`Fake worker on http://127.0.0.1:8787 (paste ${ACME_ROOT} in the UI)`));
