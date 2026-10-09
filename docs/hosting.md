# Hosting

There are two stages:

- **A. Public static demo (now):** GitHub Pages. It's free, needs no credit card and no new account, and makes no API calls, so it costs nothing. Visitors can open the three saved examples (IPinfo, Notion, Postmark) and watch their replayed timelines. Live runs are disabled.
- **B. Live runs (later, not built):** Railway, with one service for the worker and the web app. See [part B](#b-later-live-runs-on-railway).

## A. Static demo on GitHub Pages

### What gets deployed

`npm run build:static` (in `web/`) exports every page as plain HTML, JS and JSON into `web/out/`:

- `/`: the home page. The URL input and "Scout it" are disabled, with the note *"Live runs are disabled in this public demo to control API costs. Clone the repo to run it locally."*
- `/examples/ipinfo/`, `/examples/notion/`, `/examples/postmark/`: the saved runs, replayed from their recorded events, with working download buttons (files are built in the browser).

The build uses no API key and no secrets. `.github/workflows/pages.yml` builds and deploys the site on every push to `main` that changes `web/**`.

The site URL: **https://slavenasimeonova.github.io/api-integration-scout/**

### One-time setup

1. Open https://github.com/slavenasimeonova/api-integration-scout/settings/pages
2. Under **Build and deployment**, set **Source** to **GitHub Actions**. You don't need to pick a branch or a theme.
3. That's it. The repo is public, which Pages needs on a free account.

### Deploy

Push to `main` (PowerShell):

```powershell
cd C:\Users\slave\projects\api-integration-scout
git push origin main
```

Then:

1. Open the **Actions** tab on GitHub, and select the run **Deploy static demo to GitHub Pages**.
2. Wait for both jobs, **build** and **deploy**, to show a green check (about 1 to 2 minutes).
3. Click the URL shown under the **deploy** job, or open the site URL above.

To redeploy without changing anything (for example after enabling Pages), open **Actions**, select **Deploy static demo to GitHub Pages**, click **Run workflow**, then **Run workflow** again.

### Check it locally first (optional)

This builds exactly what Pages serves, including the `/api-integration-scout` subfolder:

```powershell
cd C:\Users\slave\projects\api-integration-scout\web
npm.cmd install
$env:PAGES_BASE_PATH = "/api-integration-scout"
npm.cmd run build:static
Remove-Item Env:PAGES_BASE_PATH
npm.cmd run preview:static -- --base /api-integration-scout
```

Open http://127.0.0.1:4173/api-integration-scout/ and check that:

- the input is greyed out and the note is shown
- each example replays and ends with the results and download buttons.

Stop the server with `Ctrl+C`.

For a quick check without the subfolder, run `npm.cmd run build:static`, then `npm.cmd run preview:static`, and open http://127.0.0.1:4173/.

Local development is unchanged: `npm.cmd run dev` still has live runs through the worker.

### Update the demo

| Change | What to do |
| --- | --- |
| UI change in `web/` | Commit and push. The workflow redeploys. |
| New or refreshed example | Run `npm.cmd run build:examples` in the repo root (it writes `web/public/examples/*.json`), then commit and push. |
| Change only outside `web/` | Nothing to deploy. To force a deploy, use **Run workflow**. |

### Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| The workflow fails at **deploy** with "Get Pages site failed" or "Not Found" | Pages isn't enabled, or **Source** isn't **GitHub Actions**. Fix it in Settings > Pages, then use **Run workflow**. |
| **deploy** fails with "branch is not allowed to deploy" | Settings > Environments > **github-pages**: allow the `main` branch. |
| The page has no styling, or examples say "Couldn't load this example" | The build used the wrong base path. In CI, `actions/configure-pages` provides it; locally, set `PAGES_BASE_PATH` as shown above. |
| 404 right after the first deploy | Pages can take a few minutes the first time. Wait, then reload. |
| The site still shows the old version | Hard-reload the page (`Ctrl+F5`). Check that the latest Actions run is green. |

### Alternatives (also free, no card)

Cloudflare Pages and Netlify both host static sites for free without a card, and serve from the domain root, so no base path is needed. Each one needs another account connected to GitHub. To use one, set the build command to `npm run build:static`, the base directory to `web` and the output directory to `out`.

## B. Later: live runs on Railway

> **Not built yet.** This is the plan for when live runs go public.

Live runs need a long-running Node process. The worker spawns the Agent SDK subprocess and streams for 30 seconds or more, which rules out static hosts and short serverless timeouts.

### Recommended: Railway, one service

- **One container:** the worker (`npm run worker`) also serves the exported web app from `web/out`, so `/api/*` and the pages share one origin and need no proxy or CORS.
  - **To build:** a `Dockerfile`, and static file serving in `worker/server.ts`. The web app would be built as a static export, but with live runs enabled (a third build mode).
- **One account:** a GitHub login. Railway has no permanent free tier: after a trial it needs a paid plan with a card. Check current pricing before deploying.
- **Limit counters survive restarts:** `MemoryStore` resets on every deploy or restart. Add a Railway **volume** (a file-backed store) or Railway's Redis add-on, behind the same `RunLimiter` interface.
- **Environment variables:**
  - `ANTHROPIC_API_KEY`: a dedicated key from the **scout-demo** workspace, which has a monthly spend limit. Never use the local key.
  - `VISITOR_SALT`: a long random string.
  - `CLIENT_IP_HEADER`: Railway's proxy header for the client IP (check Railway's docs).
  - Optional: `LIMIT_RUNS_PER_VISITOR`, `LIMIT_RUNS_PER_DAY`, `LIMIT_USD_PER_DAY`, `LIMIT_CONCURRENT_RUNS`.
- **Timeouts:** check Railway's HTTP request limit against the longest run (up to a few minutes with 15 pages).
- **The static demo stays:** GitHub Pages can keep serving the examples-only version.

### Compared with Vercel + Cloud Run + Upstash

| | Railway (one service) | Vercel + Cloud Run + Upstash |
| --- | --- | --- |
| Accounts | 1 | 3 (Google Cloud needs a billing account with a card) |
| Pieces to deploy | 1 container | Web on Vercel; worker container on Cloud Run; Redis on Upstash |
| Long streaming runs | Normal Node process | Must run on Cloud Run (Vercel functions have time limits); Vercel proxies or the browser calls Cloud Run (CORS) |
| Limit counters | Volume or Redis add-on | Upstash Redis (needed: Cloud Run scales to zero) |
| Cost when idle | Small fixed monthly fee | Close to zero (free tiers) |
| DevOps effort | Lowest | Higher: three dashboards, secrets in two places |

The trade-off: Vercel + Cloud Run + Upstash can cost less when idle, but Railway is simpler to set up and run. For a demo with daily run limits, the simpler setup matters more.
