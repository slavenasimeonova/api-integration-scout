# CLAUDE.md

Guidance for Claude Code (and humans) working on this repo. The README covers usage and the architecture overview; this file covers state, decisions, pitfalls and what's next.

## Project in one paragraph

API Integration Scout is a TypeScript agent built on the Claude Agent SDK. It reads public API docs and produces an integration analysis plus a Postman collection. The core value is the **analysis**: every finding is labeled Documented, Inferred or Not found in docs, and *documented* claims are verified in code against the fetched page text. The Postman collection is secondary. Phase 1 (CLI) is done. Phase 2 is a Next.js web UI that must reuse `src/core` and `src/generators` unchanged.

## Commands (Windows, Command Prompt)

```bat
npm test                 :: Vitest, fully offline (fixtures + scripted fake SDK runner)
npm run typecheck        :: tsc --noEmit (TypeScript 7)
npm run scout -- <url> [--max-pages 5] [--model id] [--out dir] [--json]
```

- `.env` is loaded by Node's `--env-file-if-exists` (no dotenv). It holds `ANTHROPIC_API_KEY`, which must be a **workspace-scoped** key (see Pitfalls).
- Outputs go to `outputs/<api-name>/` (git-ignored). Every run, including failed ones, is appended to `outputs/runs.jsonl` with tokens and cost.

## Layout

```
src/core/        Agent core: no CLI or fs code. Public API in core/index.ts
  scout.ts       runScout(url, { config, onEvent, signal, fetcher, runner }) -> Analysis
  tools.ts       DocsSession: fetch_page / report_progress, same-site rule, page limit,
                 truncation (12k chars to the model), low-text/JS-rendering detection
  verify.ts      Normalized quote verification; downgrades unverifiable "documented" claims
  hosts.ts       Fixes or flags endpoint hosts using full URLs in verified quotes
  budget.ts      Token budget (per message id; cache reads excluded)
  schema.ts      Zod AgentOutput (sent as outputFormat, draft-07) + Analysis type
  events.ts      ProgressEvent union + safe emitter
  prompt.ts      System prompt (evidence rules, auth alternatives, live progress)
src/generators/  Deterministic, no model calls: Analysis -> files in memory (buildOutputs)
src/cli/         Arg parsing, ASCII progress output, writes outputs/
schemas/         Official Postman Collection v2.1 schema (draft-04), vendored
tests/           Offline tests; fixtures/acme-weather is a fake docs site
examples/ipinfo/ Real run output (regenerated offline with the current host check; see its README)
```

## Key decisions (and why)

- **Own fetch tool instead of the SDK's WebFetch.** WebFetch returns a model-written summary, so quotes couldn't be verified and tests couldn't run offline. Built-in tools are disabled (`tools: []`); only `mcp__scout__fetch_page` and `mcp__scout__report_progress` are allowed.
- **Verify in code, don't trust the prompt.** Documented findings need a quote that appears on the cited page. Matching is normalized: NFKC, case, punctuation and whitespace are ignored, and whole words are required. Failures are downgraded to Inferred and become a risk, and the fabricated quote is removed. The same rule applies to endpoint hosts (`hosts.ts`), because a prompt-only fix proved unreliable in a real run.
- **Auth: keep every documented method.** `auth` is the primary method and `authAlternatives` holds the rest, each verified. Alternatives that are inferred or unverified are dropped and listed in `warnings`; never add an undocumented method. Postman: collection auth = the first *documented* method; an "Auth alternatives" folder has one sample request per other documented method. Credential params like `?token=` are supplied by auth, not left as empty params.
- **Generators are plain code.** They are deterministic and testable, and no secret can reach them. Credentials are only ever `{{apiKey}}`. The environment file pre-fills the public `baseUrl`, because an empty environment value would override the collection variable.
- **Budget.** Defaults: 150k tokens, $0.50, 15 pages, effort `medium`, model `claude-sonnet-5-5`. The token budget counts input + cache-write + output and **excludes cache reads**, which every turn re-sends at a fraction of the price; the SDK's `maxBudgetUsd` covers their cost.
- **Never silent.** JS-rendered pages, truncated pages, the page limit, downgrades, dropped auth methods and host corrections all emit an event *and* add a warning or risk to the analysis.
- **Testability seam.** `runScout` takes an `AgentRunner`; tests pass `tests/helpers/fake-runner.ts`, which drives the tools and replays scripted SDK messages.

## Agent SDK pitfalls (verified against SDK 0.3.289 types and real runs)

- `settingSources` omitted = load the user's settings. Always pass `[]`.
- Auto-memory still loads with `settingSources: []`. Pass `settings: { autoMemoryEnabled: false }`.
- `env` **replaces** the subprocess environment. Leave it unset so `ANTHROPIC_API_KEY` is inherited.
- API failures (e.g. HTTP 400) arrive as a result with `subtype: "success"`, `is_error: true` and the message in `result`. `runScout` maps this to `ScoutError("api_error")`.
- A key that isn't scoped to a workspace fails with "must include the anthropic-workspace-id header". Use a workspace-scoped key.
- One API response can arrive as several assistant messages repeating the same usage, so track usage by `message.id`.
- Structured output schemas must be draft-07: `z.toJSONSchema(schema, { target: "draft-7" })`.
- `ajv-draft-04` is CommonJS. Under ESM the class is the namespace's `.default`; see the typed cast in `postman-validate.ts`.

## Working conventions

- Show a plan and wait for approval before larger changes. **Ask before installing any dependency.**
- **Ask before any paid run.** Use small runs (`--max-pages 5`) and report the cost from `outputs/runs.jsonl`. Everything else should be testable offline.
- Never print, log or commit the API key. Scan for secrets before publishing anything.
- Small commits with clear messages; push to `origin main`.
- Windows/Command Prompt commands in docs; CLI output stays ASCII.
- When adding behavior: add a fixture-based test, and confirm it fails without the change.

## Phase 2 progress (2026-10-07)

- Steps 1 to 4 are built (worker, safe fetcher, limits, Next.js screens, local wiring): 130 tests passing. Hosting (step 5) is deliberately undecided.
- Before deploying, propose the simplest hosting for someone with limited DevOps experience (ideally one service, few accounts) and compare it with Vercel + Cloud Run + Upstash. Every web page is static, so one container serving `web/` (exported) plus the worker is an option.
- Deploy with a dedicated key from the "scout-demo" workspace (monthly spend limit), never the local key.
- `MemoryStore` limit counters reset on restart. Hosts that scale to zero need a persistent store (e.g. Redis or a volume).
- Recording runs (2026-10-07, `--max-pages 5`): IPinfo $0.109, Pushover $0.052, Postmark $0.130.
- UI development without cost: `npm run worker:fake` + `npm run dev` in `web/`. Live runs start only on a click, never on page load, so a refresh can't spend money.
- `web/` imports only *types* from `src/` and `worker/`. Next's turbopack root is `web/`.
- Headless Edge screenshots: the layout is at least 518px wide; test phone widths with a 390px iframe.

## Phase 1 state (2026-10-07)

- Phase 1 complete: 74 tests passing, published at github.com/slavenasimeonova/api-integration-scout.
- Real runs: IPinfo twice (about $0.11 and $0.12). The second run confirmed three verified auth methods, live progress events, correct page numbering and truncation warnings.
- Not yet confirmed in a paid run: the prompt asking for full URLs on other-host endpoints. Low priority, since `hosts.ts` now corrects or flags it in code.

## Next steps: phase 2 (Next.js web UI)

1. **App skeleton.** Next.js App Router in a separate `web/` folder (or a workspace) that imports `src/core` and `src/generators` unchanged. Get approval for the new dependencies first.
2. **Streaming route.** A POST route handler calls `runScout(url, { onEvent, signal: request.signal })` and streams `ProgressEvent`s to the browser (SSE or a `ReadableStream` of NDJSON). Then `buildOutputs(analysis)` returns the files for download. The route must use the **Node.js runtime**, not edge, because the Agent SDK spawns a subprocess.
3. **"Watch the agent think" UI.** A live timeline driven by `step`/`detail`: page fetches, findings, warnings (`low_text_warning`, `page_truncated`, `verification_downgrade`, `endpoint_host_*`), and a token or cost meter from `usage_update`. Then a results view with the Documented / Inferred / Not found labels, the risks, the auth methods and their quotes, a rendered Mermaid diagram, and download buttons.
4. **Security before exposing it publicly.**
   - **SSRF:** `fetch_page` fetches user-supplied URLs. Block private and loopback IP ranges, link-local and cloud metadata addresses, and non-standard ports, resolving DNS first. Re-check after redirects.
   - **Abuse and cost:** keep the API key server-side, and add per-IP rate limits, a concurrency cap, and the existing per-run budgets.
5. **Hosting limits.** Runs take about 30 seconds, and up to minutes with more pages. Check the host's request timeout, or move runs to a background job with resumable event streams.
6. **Nice to have.** A `.gitattributes` to stop the CRLF warnings; a cache of fetched pages per URL; a run history page built from `runs.jsonl`-style records.
