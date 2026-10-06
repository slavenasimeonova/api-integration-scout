import { query, type Options, type SDKMessage, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { TokenBudget } from "./budget.js";
import { loadConfig, type ScoutConfig } from "./config.js";
import { createEmitter, type OnEvent } from "./events.js";
import { createHttpFetcher, type Fetcher } from "./fetcher.js";
import { SYSTEM_PROMPT, buildUserPrompt } from "./prompt.js";
import { AgentOutput, agentOutputJsonSchema, type Analysis, type Risk, type RunStats } from "./schema.js";
import { ALLOWED_TOOLS, DocsSession, MCP_SERVER_NAME, createScoutMcpServer } from "./tools.js";
import { authLabel, verifyAnalysis } from "./verify.js";

/**
 * Seam between the core and the Agent SDK. Production calls query(); tests
 * pass a fake that drives `tools` directly and yields scripted SDK messages.
 */
export type AgentRunner = (args: {
  prompt: string;
  options: Options;
  tools: Pick<DocsSession, "fetchPage" | "reportProgress">;
}) => AsyncIterable<SDKMessage>;

const sdkRunner: AgentRunner = ({ prompt, options }) => query({ prompt, options });

export type RunScoutOptions = {
  /** Defaults to loadConfig() (SCOUT_* env vars). */
  config?: ScoutConfig;
  onEvent?: OnEvent;
  fetcher?: Fetcher;
  runner?: AgentRunner;
  /** Lets a caller (e.g. a web request) cancel the run. */
  signal?: AbortSignal;
};

export type ScoutFailureReason =
  | "invalid_url"
  | "budget_exceeded"
  | "max_budget_usd"
  | "max_turns"
  | "api_error"
  | "no_structured_output"
  | "invalid_output"
  | "aborted"
  | "execution_error";

export class ScoutError extends Error {
  constructor(
    message: string,
    readonly reason: ScoutFailureReason,
    /** Token usage up to the failure, so it is logged even when a run fails. */
    readonly run?: RunStats,
  ) {
    super(message);
    this.name = "ScoutError";
  }
}

const JS_RENDERING_RISK = "docs page may require JavaScript rendering; content may be incomplete";

/** Runs the scout agent on a docs URL and returns a verified analysis. Writes no files. */
export async function runScout(docsUrl: string, opts: RunScoutOptions = {}): Promise<Analysis> {
  const config = opts.config ?? loadConfig();
  const emit = createEmitter(opts.onEvent);
  const runner = opts.runner ?? sdkRunner;
  const startedAt = new Date();

  let rootUrl: string;
  try {
    rootUrl = new URL(docsUrl).toString();
    if (!/^https?:$/.test(new URL(rootUrl).protocol)) throw new Error();
  } catch {
    const err = new ScoutError(`Not a valid http(s) URL: ${docsUrl}`, "invalid_url");
    emit({ step: "run_failed", detail: err.message });
    throw err;
  }

  const session = new DocsSession(rootUrl, opts.fetcher ?? createHttpFetcher(config.fetchTimeoutMs), config, emit);
  const budget = new TokenBudget(config.maxTokens);
  const abortController = new AbortController();
  const onExternalAbort = () => abortController.abort();
  opts.signal?.addEventListener("abort", onExternalAbort, { once: true });

  emit({ step: "run_started", detail: `Scouting ${rootUrl} with ${config.model}`, url: rootUrl, model: config.model });

  const options: Options = {
    model: config.model,
    effort: config.effort,
    systemPrompt: SYSTEM_PROMPT,
    tools: [],
    allowedTools: ALLOWED_TOOLS,
    mcpServers: { [MCP_SERVER_NAME]: createScoutMcpServer(session) },
    strictMcpConfig: true,
    permissionMode: "dontAsk",
    // Isolate the agent from the user's Claude Code setup: no settings files,
    // and no auto-memory (which is otherwise read even with settingSources: []).
    settingSources: [],
    settings: { autoMemoryEnabled: false },
    persistSession: false,
    maxTurns: config.maxTurns,
    maxBudgetUsd: config.maxBudgetUsd,
    outputFormat: { type: "json_schema", schema: agentOutputJsonSchema() },
    abortController,
  };

  let result: SDKResultMessage | undefined;
  let budgetExceeded = false;
  let thrown: unknown;

  try {
    for await (const message of runner({ prompt: buildUserPrompt(rootUrl, config), options, tools: session })) {
      if (message.type === "assistant" && message.message?.usage) {
        const crossed = budget.record(message.message.id, message.message.usage);
        const { budgetedTokens } = budget.totals;
        emit({
          step: "usage_update",
          detail: `${budgetedTokens.toLocaleString("en-US")} / ${config.maxTokens.toLocaleString("en-US")} tokens`,
          totalTokens: budgetedTokens,
          maxTokens: config.maxTokens,
        });
        if (crossed) {
          budgetExceeded = true;
          emit({
            step: "budget_exceeded",
            detail: `Token budget of ${config.maxTokens.toLocaleString("en-US")} exceeded; stopping`,
            totalTokens: budgetedTokens,
            maxTokens: config.maxTokens,
          });
          abortController.abort();
          break;
        }
      } else if (message.type === "result") {
        result = message;
      }
    }
  } catch (err) {
    // query() throws after yielding an error result, and on abort.
    thrown = err;
  } finally {
    opts.signal?.removeEventListener("abort", onExternalAbort);
  }

  const run = buildRunStats(config, startedAt, budget, result);
  const fail = (reason: ScoutFailureReason, message: string): never => {
    emit({ step: "run_failed", detail: message });
    throw new ScoutError(message, reason, run);
  };

  if (budgetExceeded) fail("budget_exceeded", `Stopped: token budget of ${config.maxTokens} exceeded (SCOUT_MAX_TOKENS)`);
  if (opts.signal?.aborted) fail("aborted", "Run was cancelled");
  if (!result) {
    const detail = thrown instanceof Error ? thrown.message : String(thrown ?? "no result message");
    fail("execution_error", `Agent run failed: ${detail}`);
  }
  const final = result!;
  if (final.subtype === "error_max_budget_usd") {
    fail("max_budget_usd", `Stopped: cost budget of $${config.maxBudgetUsd} exceeded (SCOUT_MAX_BUDGET_USD)`);
  }
  if (final.subtype === "error_max_turns") fail("max_turns", `Stopped: reached ${config.maxTurns} turns`);
  if (final.subtype !== "success") {
    const errors = "errors" in final ? final.errors.join("; ") : "";
    fail(
      final.subtype === "error_max_structured_output_retries" ? "no_structured_output" : "execution_error",
      `Agent run ended with ${final.subtype}${errors ? `: ${errors}` : ""}`,
    );
  }
  // An API error (bad key, missing workspace, overload) can arrive as subtype
  // "success" with is_error set and the API's message in `result`.
  if (final.subtype === "success" && final.is_error) {
    const status = final.api_error_status ? ` (HTTP ${final.api_error_status})` : "";
    fail("api_error", `Claude API error${status}: ${final.result || "no details"}`);
  }
  if (final.subtype !== "success" || final.structured_output === undefined) {
    return fail("no_structured_output", "Agent finished without producing a structured analysis");
  }

  const parsed = AgentOutput.safeParse(final.structured_output);
  if (!parsed.success) fail("invalid_output", `Agent output did not match the schema: ${parsed.error.message}`);

  const { output, downgrades } = verifyAnalysis(parsed.data!, session.pages);
  for (const d of downgrades) {
    emit({ step: "verification_downgrade", detail: `${d.field} downgraded to inferred: ${d.reason}`, field: d.field });
  }

  const risks: Risk[] = output.risks.map((r) => ({ ...r, origin: "agent" }));
  const warnings: string[] = [];

  for (const visit of session.visits) {
    if (visit.lowText) {
      risks.push({ severity: "medium", title: JS_RENDERING_RISK, detail: `${visit.url} returned only ${visit.textLength} characters of text.`, origin: "fetch" });
      warnings.push(`Low text on ${visit.url} (${visit.textLength} chars); may require JavaScript rendering`);
    }
    if (visit.truncated) {
      warnings.push(
        `Page truncated: ${visit.url} (${visit.textLength} chars, first ${config.maxPageChars} sent to the model); findings from this page may be incomplete`,
      );
    }
    if (visit.status === "failed") warnings.push(`Could not fetch ${visit.url}: ${visit.error}`);
  }
  for (const d of downgrades) {
    risks.push({
      severity: "low",
      title: `Unverified claim: ${d.field}`,
      detail: `The agent marked this as documented, but ${d.reason}. Treat it as inferred and confirm with the provider.`,
      origin: "verification",
    });
  }
  if (downgrades.length) warnings.push(`${downgrades.length} finding(s) downgraded from documented to inferred`);

  // Alternative auth methods are kept only when the docs verifiably state them.
  const authAlternatives = output.authAlternatives.filter((alt) => {
    if (alt.status === "documented" && alt.value) return true;
    const label = alt.value ? authLabel(alt.value) : "unnamed method";
    warnings.push(`Auth alternative "${label}" left out: not verifiably stated in the docs (${alt.status})`);
    return false;
  });
  if (session.pagesFetched >= config.maxPages) warnings.push(`Page limit of ${config.maxPages} reached; some docs may not have been read`);

  const analysis: Analysis = {
    schemaVersion: 1,
    docsUrl: rootUrl,
    generatedAt: new Date().toISOString(),
    ...output,
    authAlternatives,
    risks,
    pagesVisited: session.visits,
    warnings,
    run,
  };

  emit({
    step: "run_completed",
    detail: `Done: ${run.totalTokens.toLocaleString("en-US")} tokens, $${run.costUsd.toFixed(4)}`,
    totalTokens: run.totalTokens,
    costUsd: run.costUsd,
  });
  return analysis;
}

function buildRunStats(config: ScoutConfig, startedAt: Date, budget: TokenBudget, result?: SDKResultMessage): RunStats {
  // The result message's usage is authoritative; fall back to our running tally.
  const tally = budget.totals;
  const u = result?.usage;
  const inputTokens = u?.input_tokens ?? tally.inputTokens;
  const outputTokens = u?.output_tokens ?? tally.outputTokens;
  const cacheReadInputTokens = u?.cache_read_input_tokens ?? tally.cacheReadInputTokens;
  const cacheCreationInputTokens = u?.cache_creation_input_tokens ?? tally.cacheCreationInputTokens;
  return {
    model: config.model,
    startedAt: startedAt.toISOString(),
    durationMs: result?.duration_ms ?? Date.now() - startedAt.getTime(),
    numTurns: result?.num_turns ?? 0,
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    totalTokens: inputTokens + outputTokens + cacheReadInputTokens + cacheCreationInputTokens,
    costUsd: result?.total_cost_usd ?? 0,
  };
}
