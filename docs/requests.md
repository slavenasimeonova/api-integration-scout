# Request mode (access codes)

People you give an access code to can request a run from the public demo. You review each request, run it on your machine, and publish the result to the site. It costs $0 in hosting: GitHub Pages and the Netlify Free plan. You only pay Anthropic for the runs you choose to do.

```
Pages (home): goal assistant at the top, open to everyone -> docs URL -> Start
  -> Netlify Function /api/interview: no code; 3 conversations per IP and 50 in total a day
     -> chat (up to 6 questions) -> the visitor edits the proposed goal (or writes one if the assistant is off)
  -> access code + "Request a run"
  -> Netlify Function /api/requests: kill switch, wrong-code throttle (10 per IP per hour),
     code hash check, per-code limits (per day, total), URL check
  -> stored in Netlify Blobs as "pending" -> Telegram message to you
     (if Telegram fails, the request is stored anyway and the error is logged)
  <- the visitor gets a link to bookmark: /results/?id=<id>
You: npm.cmd run request:list -> npm.cmd run request:fulfil -- <id>
  shows URL, code name, time -> asks -> runs (SSRF-safe fetcher) -> asks -> commits + pushes
  web/public/results/<id>.json -> marks the request "done"
Pages redeploys (~2 min): the visitor's link replays the result.
```

| Piece | Where |
| --- | --- |
| Codes, limits, request API, Telegram | `src/access/` (plain Node; reusable by a worker later) |
| Goal assistant | `src/access/interview.ts` (limits, transcripts), `interview-prompt.ts`, `interview-model.ts` (the only file using the Anthropic SDK) |
| Netlify Functions | `netlify/functions/requests.ts`, `interview.ts`, `prune-interviews.ts` (daily); config in `netlify.toml` |
| Site assistant and results page | `web/components/GoalAssistant.tsx`, `GoalInterview.tsx`, `web/lib/api-errors.ts`, `web/app/results/` |
| Your commands | `code:new`, `request:list`, `request:fulfil` (in `scripts/`) |

## One-time setup

You'll need your Netlify account, your Telegram bot (you already pressed **Start** in it), and about 20 minutes. All commands are for PowerShell, run from the project folder:

```powershell
cd C:\Users\slave\projects\api-integration-scout
```

### 1. Create the Netlify project (API only)

1. In Netlify: **Add new project > Import an existing project > GitHub**, and pick **api-integration-scout**.
2. Netlify reads `netlify.toml`, so you don't need to change any build settings.
3. Set the **Project name** to `api-scout-requests` (or any free name). The API will be at `https://api-scout-requests.netlify.app`.
4. Click **Deploy**. The first deploy installs the repo's packages, which takes 1 to 3 minutes.
5. Check that `https://api-scout-requests.netlify.app/` redirects to the demo on GitHub Pages.

The public site stays on GitHub Pages. Netlify only hosts the API: its root redirects to the demo (`[[redirects]]` in `netlify.toml`), and any other unknown path shows a 404 page that also forwards to the demo. The function paths `/api/requests` and `/api/requests/<id>` aren't redirected.

### 2. Find your Telegram chat ID

1. Send any message (e.g. `hi`) to your bot in Telegram. Telegram keeps a bot's unread updates for only 24 hours, so send a fresh one now.
2. In PowerShell, run the lines below. The token is typed hidden and isn't saved in your history:

   ```powershell
   $secure = Read-Host "Bot token" -AsSecureString
   $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
   (Invoke-RestMethod "https://api.telegram.org/bot$token/getUpdates").result.message.chat | Select-Object id, first_name, username
   Remove-Variable token, secure
   ```

3. The `id` column is your chat ID, a number like `123456789`. If nothing is printed, send the bot another message and run the third line again.

### 3. Create the first access code

```powershell
npm.cmd run code:new -- recruiter-acme --per-day 3 --total 10
```

The command prints two things:

- The **code** (e.g. `scout-k7mq2-...`) to give to that person. It's shown once and saved nowhere, so copy it now.
- The **entry** (`recruiter-acme:3:10:<hash>`) for `ACCESS_CODES` in the next step.

Code names may use lowercase letters, digits and dashes. Limits count requests in UTC days and in total, per code, and are checked before a request is stored.

### 4. Add the environment variables in Netlify

Open your Netlify project, then **Project configuration > Environment variables > Add a variable > Add a single variable**. For each row below, enter the key and value, and keep **Same value for all deploy contexts**. Where the table says so, tick **Contains secret values**: Netlify then hides the value after saving.

| Key | Value | Secret |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | Your bot token from BotFather | Yes |
| `TELEGRAM_CHAT_ID` | The number from step 2 | No |
| `ACCESS_CODES` | The entry from step 3. More codes are added with commas: `a:3:10:<hash>,b:1:3:<hash>` | Yes |
| `IP_SALT` | A random string; generate one below | Yes |
| `ALLOWED_ORIGIN` | `https://slavenasimeonova.github.io` (this is also the default) | No |
| `REQUESTS_ENABLED` | `on` (`off` is the kill switch) | No |

To generate an `IP_SALT` value:

```powershell
-join ((48..57) + (97..122) | Get-Random -Count 32 | ForEach-Object { [char]$_ })
```

Then apply the variables: **Deploys > Trigger deploy > Deploy project**. Netlify passes environment variables to functions only at deploy time, so every change needs a redeploy (about a minute).

Netlify Functions run on AWS Lambda, where all environment variables together are limited to 4 KB. That's room for about 30 codes.

### 5. Turn on request mode on the public site

The site shows the goal assistant (and asks for codes) only when it knows the API's address. Set the address as a GitHub repository variable (a public URL, not a secret), then rebuild Pages:

```powershell
gh variable set REQUEST_API_URL --body "https://api-scout-requests.netlify.app"
gh workflow run pages.yml --ref main
```

You can also set it in the web UI: **GitHub > Settings > Secrets and variables > Actions > Variables > New repository variable**. To remove the assistant and request mode, delete the variable and run the workflow again; the site then shows the disabled run form.

### 6. Let your machine read requests

`request:list` and `request:fulfil` read Netlify Blobs directly, so there's no admin endpoint. They need two values in your local `.env`, which is never committed:

```
NETLIFY_SITE_ID=...
NETLIFY_AUTH_TOKEN=...
```

- **`NETLIFY_SITE_ID`:** Netlify project > **Project configuration > General > Project details > Project ID**.
- **`NETLIFY_AUTH_TOKEN`:** Netlify avatar > **User settings > Applications > Personal access tokens > New access token**. Give it an expiry date. The token can act on your whole Netlify account, so keep it only in `.env`.

### 7. Test it

1. Open the demo, enter `https://ipinfo.io/developers` in the goal assistant, write or accept a goal, then enter your code and click **Request a run**.
2. Check that a Telegram message arrives with the code name, the URL (and the goal, if you gave one) and a ready-to-run command.
3. Run `npm.cmd run request:list`. It should show the request.

## Daily use

```powershell
npm.cmd run request:list                 # pending requests, oldest first (--all for every request)
npm.cmd run request:fulfil -- <id>       # review, run, publish
npm.cmd run request:fulfil -- <id> --decline --note "Docs need a login"   # decline
```

**Goals.** A visitor can add a goal (up to 300 characters). The site tells them that the goal is published with the result and asks them not to include confidential information. The goal is shown in Telegram, by `request:list` and in the `request:fulfil` review, and the run is scoped to it ([goal mode](goal-mode.md)). A goal longer than 300 characters is rejected without using up one of the code's requests.

`request:fulfil` works through these steps:

1. **Shows the request:** the URL, the goal (if any), the code name, the request time and the status.
2. **Checks the URL:** the scheme, the port, and that its DNS points to public addresses. The run itself uses the same SSRF-safe fetcher as the worker, because the URL is fetched from your machine.
3. **Asks before running.** This is a paid run with your `.env` key: 5 pages by default (`--max-pages` changes it), with the usual $0.50 per-run cap. Every run, including failed ones, is logged in `outputs/runs.jsonl` with the request id and code name.
4. **Saves** the result to `web/public/results/<id>.json`. The file has the same shape as a saved example and contains no code name.
5. **Asks before publishing**, then commits only that file and pushes to `origin main`. GitHub Pages redeploys in about 2 minutes. If you say no, run the same command later: it finds the saved result, skips the run, and goes straight to publishing.
6. **Marks the request done** and prints the visitor's link.

**What the visitor sees at `/results/?id=<id>`:**

| Status | Page |
| --- | --- |
| Pending | "Waiting for review" |
| Done, before Pages has redeployed | "Being published" |
| Published | The result replay with downloads |
| Declined | "Declined", with your note |

## Goal assistant

The goal assistant is the first thing on the home page and is open to everyone: no code is needed to chat. The visitor enters a docs URL, and the assistant (`claude-haiku-5-5`) asks up to 6 questions (what they're building, which events, webhooks or not, which systems), then proposes a goal of at most 300 characters. The access code is asked only at the end, with **Request a run**, because the run is the part that costs money. The first question is fixed text, so it costs nothing. A wrong code doesn't use up the conversation; the visitor can fix the code and send again.

**Limits** (in code, `INTERVIEW_LIMITS` in `src/access/interview.ts`; the prompt doesn't enforce anything):

| Limit | Value |
| --- | --- |
| Questions per conversation | 6, the opening question included; then the next reply must be the goal |
| Visitor message | 500 characters |
| Tokens per conversation | 20,000 (input + output); past this, the next reply must be the goal |
| Idle time | 30 minutes, then the visitor writes the goal by hand |
| Conversations per visitor | 3 a day (UTC) per IP; the IP is stored only as a salted hash (`IP_SALT`), and past days' counters are deleted daily |
| Conversations, everyone | 50 a day |
| Each reply | 400 output tokens, low effort, no thinking, no tools |

Without a code, the global cap is what bounds the cost: someone switching IPs still stops at 50 conversations a day, and the scout-demo workspace's spend limit is the last line of defense.

**Untrusted visitor text.** Visitor messages reach the model only inside `<<<VISITOR ... VISITOR>>>`, with any delimiters in them removed first. The system prompt says they are data and that the assistant only helps write the goal. The reply must match a JSON schema (`kind`, `text`, `goal`), which code checks again. The site shows replies as plain text. The model never fetches the URL. The goal still goes through the scout run's own `GOAL_INSTRUCTIONS`, and you see it in `request:fulfil` before any paid run.

**Transcripts** are stored in Blobs (`interviews/<id>`) for 14 days, which the chat tells visitors. A transcript gets the code name only when a request uses it. `request:fulfil` prints the conversation under the request. The `prune-interviews` function deletes expired ones daily, and `request:list` does it too.

**Fallbacks.** If the assistant is off, has no key, is over a limit, or doesn't answer, the visitor gets the plain goal box and can still send the request.

### Setup

1. **Anthropic Console** (<https://platform.claude.com>), in the **scout-demo** workspace:
   - **Settings > Workspaces > scout-demo > Limits:** check the monthly spend limit. $5 covers about 1,500 conversations.
   - **Settings > API keys > Create key:** name it `scout-interviewer` and pick the **scout-demo** workspace. Copy the key. Never use your local `.env` key here.
2. **Netlify > Project configuration > Environment variables**, add:

   | Key | Value | Secret |
   | --- | --- | --- |
   | `INTERVIEW_API_KEY` | The `scout-interviewer` key | Yes |
   | `INTERVIEW_ENABLED` | `on` (`off` turns the assistant off) | No |

   Then **Deploys > Trigger deploy > Deploy project**. The commit that adds the functions triggers a deploy by itself.
3. **Check the functions:** **Logs > Functions** should list `interview` and `prune-interviews` (the latter marked as scheduled).

**Turn it off:** set `INTERVIEW_ENABLED` to `off` and redeploy. Visitors then go straight from the URL to the plain goal box and the code. To stop all spending at once, revoke the `scout-interviewer` key in the Console; visitors get the same fallback.

**Cost:** about $0.003 per conversation ($0.10 per million input tokens, $0.50 per million output tokens; about 15,000 input and 2,000 output tokens over 7 calls). At the 20,000-token cap a conversation stays under $0.01, so 50 a day is at most about $0.50 a day (typically about $0.15); the workspace spend limit caps the month.

## Revoke, pause, limits

- **Revoke one code:** delete its entry from `ACCESS_CODES`, then **Trigger deploy**. The other codes keep working. Its counters stay in Blobs, so adding it back doesn't reset its limits.
- **Kill switch:** set `REQUESTS_ENABLED` to `off`, then **Trigger deploy** (about a minute). New requests get "Requests are paused". Status pages and published results keep working.
- **A typo in `ACCESS_CODES`** (e.g. a missing hash character) makes every code fail; this is deliberate. The reason is in **Logs > Functions > requests**.

## Costs

| Item | Cost |
| --- | --- |
| GitHub Pages, Telegram | $0 |
| Netlify Free (300 credits a month) | Each production deploy costs 15 credits. `netlify.toml` has an `ignore` rule, so Netlify rebuilds only when `netlify/`, `src/access/`, `src/core/goal.ts`, `worker/safe-fetch.ts`, `netlify.toml` or the root package files change (so adding an npm script also costs one deploy). Publishing results doesn't trigger a Netlify deploy. Requests cost about 2 credits per 10,000. At 300 credits the project is paused until next month; it never bills you. |
| Anthropic, goal assistant | About $0.003 per conversation, at most 50 a day; capped by the scout-demo workspace's spend limit (see [Goal assistant](#goal-assistant)) |
| Anthropic, runs | Only the runs you approve: about $0.11 to $0.13 per 5-page run (recordings from 2026-10-07 and 2026-10-09) |

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| No goal assistant on the home page | `REQUEST_API_URL` isn't set, or Pages wasn't rebuilt since (step 5). |
| "Couldn't reach the request service" | The Netlify project is down or paused, or `ALLOWED_ORIGIN` doesn't match the site's origin (scheme + host, no path). |
| "This access code isn't valid" for a new code | Netlify wasn't redeployed after `ACCESS_CODES` changed, or the entry was mistyped (see **Logs > Functions**). |
| "Something went wrong while starting the goal assistant" (or "...sending your request") | The API rejected the request's shape (`invalid_body`) or failed. The site never shows the API's own message; the cause, with each field's type and length but not its content, is in **Logs > Functions > interview** (or **requests**). |
| No Telegram message | The request is still stored; check `npm.cmd run request:list`. The error is in **Logs > Functions > requests**. Check `TELEGRAM_CHAT_ID`, and that you pressed **Start** in the bot. |
| `request:list` says to set `NETLIFY_SITE_ID` | Step 6. |
| The chat never starts; visitors get the plain goal box | `INTERVIEW_ENABLED` is `off` or `INTERVIEW_API_KEY` is missing, or Netlify wasn't redeployed after setting them. |
| "The goal assistant didn't answer" | The Anthropic call failed or took over 4.5 s twice; the reason is in **Logs > Functions > interview**. A spend limit reached in the Console shows up here too. |
| A Netlify deploy shows **Canceled** | Expected: the `ignore` rule skipped a commit that doesn't affect the API. |

## Later: live runs (option A)

`src/access/` doesn't depend on Netlify. A container worker (Railway, see [hosting.md](hosting.md)) can use the same `ACCESS_CODES` entries, limits and Telegram notifier, with a file or Redis `KvStore`. The panel would then start a live run instead of storing a request.
