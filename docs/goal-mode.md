# Goal mode

Instead of analyzing a whole API, give Scout the docs URL **and what you're building**. It ranks the pages for that goal, reads only the ones it needs, and writes an integration document and a Postman collection scoped to the goal. The evidence rules don't change: documented claims are verified against the fetched pages, and everything else is marked inferred or not found.

```powershell
npm.cmd run scout -- https://github.com/UPS-API/api-documentation --max-pages 6 `
  --goal "Track Alert: subscribe to tracking events for a shipment and receive status updates by webhook"
```

Add `--postman-push` to put the collection and an empty environment straight into your Postman workspace (see [Push to Postman](#push-to-postman)).

The goal is plain text, up to 300 characters. Without `--goal`, Scout works exactly as before.

## How pages are chosen

1. **Keywords.** The goal's words, minus filler, are stemmed in code, so "subscribe"/"subscription" and "track"/"tracking" match. The UPS goal above gives `track, alert, subscri, event, shipmen, statu, updat, webhook`.
2. **Sitemap.** If the site has one (robots.txt `Sitemap:` lines, then `/sitemap.xml`), Scout ranks its pages before the agent starts and lists the best 25 matches in the agent's first message. It reads at most 3 sitemap files, which don't count toward the page limit. Docs on GitHub have no useful sitemap, so this step is skipped there.
3. **Links.** Every page the agent reads lists its same-site links ranked by score:
   - 2 points per keyword in the link text
   - 1 point per keyword only in the URL path (e.g. `UPSTrackAlert.yaml`)
   - 1 point for authentication pages, because goals rarely mention auth but every integration needs it

   Headings on the page that match the goal are listed too.
4. **The agent decides.** Scores are keyword hints. The agent reads what the goal actually needs, within `--max-pages` and the cost cap.
5. **Report.** `analysis.md` gets a **Pages considered for the goal** table: every page read, the best unread candidates, their scores and matched keywords, and the agent's reason for each. Scout drops any reason the agent gives for a URL it never read or saw, and adds a warning.

**Long pages and API specs.** A page longer than 12,000 characters is read in parts instead of being cut off, and each part counts as one page toward `--max-pages`. When the page is an OpenAPI or Swagger spec (YAML or JSON), part 1 starts with an outline built in code. The outline says which part holds each endpoint, webhook, security scheme and schema, so the agent can go straight to the parts it needs.

**Docs on GitHub.** Links to files (`github.com/<owner>/<repo>/blob/...`) are fetched as raw files, because the GitHub page view loses YAML indentation. With a GitHub starting URL, "same site" means the same owner on github.com and raw.githubusercontent.com, never other people's repos.

## What you get

Results go to `outputs/<api>--<first words of the goal>/`, so a goal run never overwrites a full analysis, and reruns of the same goal share a folder.

**`analysis.md`** starts with the goal, then adds:
- **Integration flow:** the steps in order (get a token, subscribe, receive the webhook). Each step is marked documented or inferred, with its source.
- **Environments:** every server the docs list, such as sandbox and production. A documented environment's URL must itself appear on the cited page.
- **Example requests:** one `curl` command per endpoint, built in code. They use `{{baseUrl}}` and credentials as variables, and a body only when the docs show one. With a documented OAuth client-credentials flow, the first command fetches the token.
- **Webhook payload:** the documented fields and an example payload, when the docs have one.

**Examples from API specs.** Specs usually show examples as YAML. The agent may give their JSON form, and Scout keeps it only if every key and value appears on the page. The document says when a body was rewritten this way.

**`sequence.mmd`** follows the integration flow, with your webhook endpoint as its own participant.

**The Postman collection** has only the goal's requests. Secrets and the base URL stay as variables you fill in:

| Situation | What Scout does |
| --- | --- |
| The docs list several environments (e.g. CIE and production) | `{{baseUrl}}` stays empty. Its description and the collection description list every option; Scout never picks one. |
| The docs give one base URL | It is prefilled, as before. |
| A server URL has a placeholder like `{version}` | It becomes a `{{version}}` variable for you to fill in. |
| OAuth 2.0 client credentials with a documented token URL | Postman's OAuth helper is set up with `{{tokenUrl}}`, `{{clientId}}` and `{{clientSecret}}`. Use **Get New Access Token** in the collection's Authorization tab. With several environments, `{{tokenUrl}}` is left empty too. |
| A credential field in an example body (`credential`, `password`, `token`, ...) | It becomes a secret `{{variable}}`; the docs' placeholder value is never used. |
| The docs show an example webhook payload | A **Webhook (test your receiver)** folder sends it to `{{webhookUrl}}`, your own endpoint. `npm run postman:run` never sends it. |

**Newman runs.** `npm run postman:run` can't use Postman's OAuth helper. For such a collection it sends `TARGET_API_TOKEN` as the bearer access token instead, and says so in the report.

## Push to Postman

`--postman-push` uploads the collection and an empty environment with the [Postman API](https://learning.postman.com/docs/developer/postman-api/intro-api/), so you don't import files.

**One-time setup:**

1. In Postman, open your avatar menu, then **Settings > API keys > Generate API key**. Give it a name and an expiry date, and copy it.
2. Open `.env` in the project folder (never committed) and add:

   ```
   POSTMAN_API_KEY=<the key>
   ```

3. Optional: to use a specific workspace, open it in Postman's web app and copy its id from the URL. That's the part after `~` in `.../workspace/<name>~<id>/...`. Add it to `.env`:

   ```
   POSTMAN_WORKSPACE_ID=<the id>
   ```

   Without it, Postman uses your oldest personal workspace.

**Use:**

```powershell
# Analyze and push in one go (the key is checked before the paid run starts):
npm.cmd run scout -- <docs-url> --goal "..." --postman-push

# Push an existing result again, without a paid run (the folder the scout run printed):
npm.cmd run postman:push -- "outputs\<api>--<goal words>"
```

**What happens:**
- **Upload:** the collection and environment appear in the workspace, and the command prints links to them.
- **Reruns:** the ids are saved in `postman-sync.json` in the output folder (ids only, no secrets), so the next push of the same folder **updates** the same collection and environment. If you deleted them in Postman, or changed `POSTMAN_WORKSPACE_ID`, new ones are created.
- **Credential check:** before anything is sent, Scout checks both files and refuses to push if:
  - a secret value in the environment isn't empty
  - any other environment value isn't empty and isn't a public URL
  - an auth field holds anything but a `{{variable}}`
  - a known key format appears (Anthropic, Postman, AWS, GitHub, private keys)
  - any value of `POSTMAN_API_KEY`, `ANTHROPIC_API_KEY`, `TARGET_API_TOKEN` or `NETLIFY_AUTH_TOKEN` appears anywhere
- **The key itself:** it goes only in the `X-Api-Key` header and is never printed or saved.
- **If the push fails** after a run, the files stay saved; retry with `npm.cmd run postman:push`.

Then, in Postman: select the environment, fill in the empty values (your credentials, plus `baseUrl` and `{{version}}` if they list options), and send.

## UPS Track Alert notes (checked 2026-10-13)

- **developer.ups.com** is a JavaScript app: every page Scout fetches is the same shell with no text. Start from UPS's official OpenAPI specs on GitHub instead: <https://github.com/UPS-API/api-documentation>.
- **Spec variants:** the Track Alert spec (`UPSTrackAlert.yaml`, about 32,000 characters) has its endpoint, webhook and schemas after the first 11,000 characters of product text. Scout reads it in 3 parts. There are also "Enhanced" (account-level subscriptions) and "-Ready" variants. "-Ready" only adds marketing text.
- **Two environments:** CIE (`wwwcie.ups.com`, UPS's test environment) and production (`onlinetools.ups.com`). Expect `{{baseUrl}}` to be left for you to choose.
- **Test only with your own free UPS developer account and its CIE (test) credentials,** never with an employer's account.

## Cost

A goal run reads fewer but longer pages, so it costs about the same as a normal run. For UPS Track Alert with `--max-pages 6`, the estimate is $0.11 to $0.16, or around $0.20 if the agent also reads the Enhanced spec. The $0.50 per-run cap still applies. Pushing to Postman, re-pushing and all ranking are free.

## Limits

- The ranking is keyword matching with crude stemming. It can miss a page whose title uses other words; the agent can still read it.
- The spec outline reads YAML by indentation, without a YAML parser. Unusual formatting can leave items out of the outline (the text itself is still read).
- A "rewritten" example keeps the docs' keys and values but may combine them differently than any single example on the page.
- The Postman links printed after a push (`https://go.postman.co/collection/<uid>`) haven't been tested against a real account yet. The items are in the workspace either way.
