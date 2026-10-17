# CLAUDE.md

Guidance for Claude Code (and humans) working on this repo. The README covers usage and the architecture overview; this file covers state, decisions, pitfalls and what's next.

## Project in one paragraph

API Integration Scout is a TypeScript agent built on the Claude Agent SDK. It reads public API docs and produces an integration analysis plus a Postman collection. The core value is the **analysis**: every finding is labeled Documented, Inferred or Not found in docs, and *documented* claims are verified in code against the fetched page text. The Postman collection is secondary. Phase 1 (CLI) is done. Phase 2 is a Next.js web UI that must reuse `src/core` and `src/generators` unchanged.

## Commands (Windows, Command Prompt)

```bat
npm test                 :: Vitest, fully offline (fixtures + scripted fake SDK runner)
npm run typecheck        :: tsc --noEmit (TypeScript 7)
npm run scout -- <url> [--max-pages 5] [--model id] [--out dir] [--json]
npm run postman:run -- <collection.json> [--env env.json] [--allow-writes]   :: Newman; GET only by default; token from TARGET_API_TOKEN
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
- **Auth: keep every documented method.** `auth` is the primary method and `authAlternatives` holds the rest, each verified. The primary is chosen in code (`auth.ts`), not by the model: header > Basic > query > cookie among documented methods. Alternatives that are inferred or unverified are dropped and listed in `warnings`; never add an undocumented method. Postman: collection auth = the first *documented* method; an "Auth alternatives" folder has one sample request per other documented method. Credential params like `?token=` are supplied by auth, not left as empty params.
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

- Steps 1 to 4 are built (worker, safe fetcher, limits, Next.js screens, local wiring).
- **Hosting, stage A (2026-10-09): static demo on GitHub Pages** (free, no card, no new account). `STATIC_DEMO=1` (`npm run build:static` in `web/`) switches `next.config.ts` to `output: "export"` with `basePath` from `PAGES_BASE_PATH`, drops the `/api` rewrite, and inlines `NEXT_PUBLIC_STATIC_DEMO`/`NEXT_PUBLIC_BASE_PATH` (`web/lib/site.ts`). In that build, `Scout.tsx` disables the input and never calls `/api`. `fetch()` of `public/` files must use `assetUrl()`, because only `next/link` adds the base path. `.github/workflows/pages.yml` deploys on pushes to `web/**`. Guide: `docs/hosting.md`.
- **Hosting, stage B (later, not built): Railway**, one container (the worker also serving the exported web app), and a volume or Redis for the limit counters. It's compared with Vercel + Cloud Run + Upstash in `docs/hosting.md`.
- **Request mode (2026-10-13), option B of the access-code design; option A (live runs on Railway) comes later.** People with an access code submit a URL; the owner reviews, runs locally and publishes. Guide: `docs/requests.md`.
  - `src/access/` is plain Node behind a `KvStore` interface, so the future worker can reuse it: `codes.ts` (SHA-256 of random codes in the `ACCESS_CODES` secret, `name:perDay:total:hash`), `requests.ts` (web-standard `handleRequestApi`), `telegram.ts`.
  - The Netlify Function (`netlify/functions/requests.ts`) uses Blobs store `scout-requests`. Netlify hosts only the API; the site stays on Pages, and the panel appears when the repo variable `REQUEST_API_URL` is set.
  - A failed Telegram message never loses a request: it's stored and the error is logged. `request:list` reads Blobs directly with `NETLIFY_SITE_ID` and `NETLIFY_AUTH_TOKEN` from `.env`. The user chose no admin endpoint.
  - `request:fulfil` always shows the URL, code name and time and asks before the paid run and again before git push. It uses the SSRF-safe fetcher (the URL is fetched from the owner's machine), and published results never contain the code name.
  - Netlify charges 15 credits per production deploy (Free: 300 a month), so `netlify.toml` has an `ignore` rule limiting builds to the function's inputs. Keep that list in sync if the function imports new files.
  - Kill switch: `REQUESTS_ENABLED=off` plus a redeploy (env vars reach functions only at deploy). Revoke a code by removing its entry and redeploying.
- **Goal-directed scouting (approved 2026-10-13, in progress; plan: commits 1 to 7).**
  - Step 2: `--goal` (`runScout({ goal })`, at most 300 characters, `normalizeGoal`).
    - **Ranking in code** (`relevance.ts`): crude stemming (7-letter prefix, so subscribe/subscription meet), 2 points per keyword in the link text, 1 per keyword only in the URL path, and 1 point for auth links, because goals rarely mention auth.
    - **What the agent sees:** fetched pages list same-site links ranked, with `[score: terms]`, plus the headings that match. The sitemap (robots.txt, then `/sitemap.xml`, an index one level deep, at most 3 files, skipped on GitHub) is ranked before the run, and its best 25 matches go in the user prompt.
    - **Report:** `analysis.discovery` holds the pages read, the top 25 unread candidates, and the agent's `pagesConsidered` reasons. Reasons for URLs that were never read or seen are dropped with a warning.
    - **Output:** goal runs write to `outputs/<api>--<goal words>/`. Without a goal, nothing changes: no `goal`/`discovery` fields and the same prompts.
    - The goal sits inside `<<<GOAL ... GOAL>>>`, and `GOAL_INSTRUCTIONS` say it can't change the rules. In request mode the goal comes from a visitor.
  - Step 3: the output is scoped to the goal. These are all optional fields, so old analyses and the committed examples are unchanged.
    - **`environments`:** a documented environment's URL must itself be on the cited page, or it is downgraded.
    - **`flow`** (goal mode): ordered steps with a direction (app_to_api / api_to_app / api_to_webhook). A step's `endpoint` is dropped unless it matches a listed endpoint.
    - **Webhook payloads:** `webhooks.examplePayload` and `payloadFields`.
    - **OAuth:** `auth.tokenUrl` and `grantType`. The token URL must be on a cited page.
    - **Example checks:** `exampleBody` and `examplePayload` may be the JSON form of a spec's YAML example. `jsonExampleMatchesPage` requires every key and string or number value on the page. `exampleBodyFrom` is set by code, never taken from the model: "verbatim" means the same words in the same order (punctuation ignored, so in-order JSON of a YAML example counts), "converted" means the same keys and values in another order.
    - **Document:** "Integration flow", "Environments" and, in goal mode only, "Example requests" (curl from `generators/requests.ts`, `{{baseUrl}}`/`{{apiKey}}` only, bash quoting). `sequence.mmd` follows `flow` when present.
    - `tests/worker-server.test.ts`'s first test has a 20 s timeout: it timed out at 5 s when every test file started in parallel.
  - Step 4: Postman (`generators/variables.ts` is shared by the collection, the environment and the curl examples).
    - **Base URL and environments:** with 2+ distinct `environments`, `baseUrl` stays empty and its description, like the collection description, lists every option (user decision 2026-10-13: never choose). One documented URL is still prefilled. `{version}`-style server placeholders become `{{version}}` variables.
    - **OAuth:** a documented primary `oauth2` + `client_credentials` + `tokenUrl` becomes Postman's OAuth helper (`{{tokenUrl}}`, `{{clientId}}`, `{{clientSecret}}`). The token URL is prefilled only with a single environment, and the curl examples start with a token request and use `{{accessToken}}`.
    - **Credentials in bodies:** fields such as `credential`, `password`, `token` or `client_secret` become `{{field}}` secret variables (`maskCredentialFields`), so a doc's placeholder secret is never sent.
    - **Webhook test:** with a verified `examplePayload`, a "Webhook (test your receiver)" folder posts it to `{{webhookUrl}}`. `postman:run` never sends it, even with `--allow-writes`.
    - **Runner:** Newman can't run the OAuth helper, so `planCollection` swaps it for bearer `{{apiKey}}` (TARGET_API_TOKEN = an access token) and the report adds a note.
    - **Unchanged without a goal:** goal runs name the collection and environment after the goal. Trivial variables have no description, so old collections are byte-identical.
  - Step 1 is done: long pages are no longer cut off.
  - `fetch_page(url, part)` serves pages in parts of `maxPageChars`, split at line breaks (`splitParts`). Each part takes one slot of the page limit. A page counts as truncated only if some parts were never read; `reportUnreadParts()` emits `page_truncated` once the agent finishes.
  - OpenAPI/Swagger specs (YAML or JSON) start with an outline built in code (`spec-outline.ts`, no YAML parser) that names the part holding each path, webhook, security scheme and schema.
  - Docs on GitHub: blob links are fetched as raw files (`fetchableUrl`), and when the root URL is on GitHub, "same site" means the same owner on github.com or raw.githubusercontent.com.
  - UPS (checked 2026-10-13): developer.ups.com is an Angular app, and every page is a 25 KB shell with no text. Its official OpenAPI specs at github.com/UPS-API/api-documentation are readable. `UPSTrackAlert.yaml` is 32k characters, and its `paths` start at 11.3k, so before parts existed the 12k cap hid the endpoints. That spec also nests `webhooks:`/`TrackingEvent` under `paths` (the outline handles it).
- Git Bash rewrites `/api-integration-scout` into a Windows path. Use `MSYS_NO_PATHCONV=1` when passing the base path from Bash (PowerShell and CI are unaffected).
- Deploy with a dedicated key from the "scout-demo" workspace (monthly spend limit), never the local key.
- `MemoryStore` limit counters reset on restart. Hosts that scale to zero need a persistent store (e.g. Redis or a volume).
- Recording runs (2026-10-07, `--max-pages 5`): IPinfo $0.109, Postmark $0.130, Notion $0.115. A Pushover run ($0.052) was dropped: its main page is 33k characters, so rate limits and errors were cut off by the 12k cap. Pick examples whose key pages fit under the cap.
- Auth rules live in code (`src/core/auth.ts`), not in the prompt. The primary method is the best-ranked documented one: header > Basic > query > cookie. Credential params are removed from endpoints. Added after a real IPinfo run picked the query token as primary while its own risks said to prefer the header.
- Postman requests never get made-up values. Path variables are prefilled only from the docs' example URLs in verified quotes (`pathVariableExamples` in `hosts.ts`). A body is set only from `exampleBody`, which must appear on a cited page (`verify.ts`); otherwise there is no body, and the description lists the documented fields. Added after IPinfo's POST /batch got `{"body": "<body>"}`.
- The IPinfo collection was tested end-to-end in Postman by the user: `GET /lite/me` returned 200 (2026-10-07).
- Generated Postman tests: status 2xx, response time under `{{maxResponseMs}}`, and JSON only with documented evidence (`apiDocumentsJsonResponses` / `endpointDocumentsJson` in `postman.ts`). They never check response fields, and no docs text goes into scripts.
- Newman runner (`src/postman/`, `npm run postman:run`): GET only unless `--allow-writes`; skips requests with empty required values or `[CHECK HOST]`. The token comes from `TARGET_API_TOKEN` (not `POSTMAN_API_KEY`, which means a key for Postman itself), is passed in memory, and is scrubbed from the report. The report is written only if it doesn't contain the token. newman pulls in transitive packages with npm audit findings; it's a local dev tool only, so they were left as is.
- The user works in PowerShell, where npm must be called as `npm.cmd`. Docs show PowerShell and Command Prompt commands.
- **Code rules live in one function**, `applyCodeRules` in `src/core/rules.ts` (host check + auth rules). `runScout` and the offline example pipeline (`scripts/examples-lib.ts`) both call it. An offline script once skipped the host check, which sent IPinfo's `/{ip}/json` to `api.ipinfo.io`, and the user's Newman run got a 404 (2026-10-08). `tests/examples.test.ts` fails if a committed example drifts. Examples use stable Postman ids, so regeneration is idempotent.
- Plan/permission restrictions: optional `access` on endpoints (requirement + quote, verified like any claim). The generator adds a `scoutRequires` item variable. The runner treats 401/402/403 there, or on `--expect-fail` names, as an expected failure; any other status stays a real failure. Never inferred from risk text: "use /lite and /batch/lite" would have marked the wrong endpoints.
- Every `{placeholder}` in a path gets a Postman variable, even if the model didn't list it as a param. The runner skips requests whose path still has an unfilled `:name`. `scrub()` must not re-encode URLs (`{ip}` stayed `%7Bip%7D` once).
- IPinfo recordings were refreshed 2026-10-09 ($0.112) for both the web and the README examples.
- Pages are numbered in the order their fetch finishes, so parallel fetches don't show as 1/5, 3/5, 2/5.
- UI numbers come from one place (`web/lib/figures.ts`). When a run finishes, the meters switch to the analysis figures. The token meter counts budgeted tokens (input + cache write + output, excluding cache reads).
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
