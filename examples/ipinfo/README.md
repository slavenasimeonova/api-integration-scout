# Example: IPinfo

Output from a real run against <https://ipinfo.io/developers> on 2026-10-09:

```
npm run scout -- https://ipinfo.io/developers --max-pages 5
```

The run used `claude-sonnet-5-5` and read 3 pages, two of which were truncated at 12,000 characters (both flagged in the analysis). It took 8 turns and 21 seconds. Token usage was 6 input, 3,416 output, 29,341 cache write and 19,390 cache read, for an estimated cost of **$0.11**.

| File | Contents |
| --- | --- |
| [`analysis.json`](analysis.json) | The run's structured result (the source the other files are generated from) |
| [`analysis.md`](analysis.md) | Integration summary: every finding labeled Documented, Inferred or Not found in docs, with source quotes |
| [`postman_collection.json`](postman_collection.json) | Postman Collection v2.1, validated against the official schema; credentials are only `{{apiKey}}`. Every request has tests: status 2xx and response time, plus a JSON check where the docs give evidence |
| [`postman_environment.json`](postman_environment.json) | Environment template: `baseUrl` prefilled, `apiKey` empty |
| [`sequence.mmd`](sequence.mmd) | Mermaid sequence diagram of the main flow |

**How these files were produced.** The findings are exactly what the run returned. The files are regenerated offline from `analysis.json` with `npm run build:examples`, which applies the same code rules as a live run (`src/core/rules.ts`) and makes no model call. A test fails if the committed files drift from that output. Things worth noticing:

- The model picked the token-in-query method as primary; the code rule made the Bearer header primary (listed under Warnings in `analysis.md`).
- `GET /lookup/{ip}` needs a paid plan, per the verified quote "since /lookup is a paid-tier endpoint and will return an error on free tokens." Its Postman request says so, and the Newman runner reports a 401/402/403 there as an expected failure.
- `POST /batch` has the example body from the docs (verified against the page). `POST /batch/lite` has none, because the docs pages read show no example for it.
- Path variables are prefilled from the docs' own example URLs (`ip` = `8.8.8.8`, `field` = `asn`), and the `token` query param is not repeated on every endpoint, since auth supplies it.
- The legacy `GET /{ip}/json` is on `https://ipinfo.io`, as the docs' example URL shows.

The collection was tested end-to-end in Postman (`GET /lite/me` returned 200) and with Newman on a free token: `/lite` passed with all three auth methods and `/lookup` returned 403, as predicted.

To run the GET requests with Newman (see the main README): set `TARGET_API_TOKEN` to your IPinfo token, then `npm run postman:run -- examples\ipinfo\postman_collection.json --env examples\ipinfo\postman_environment.json` (in PowerShell, `npm.cmd`). The two POST requests are skipped unless you pass `--allow-writes`.

These files contain no credentials. All auth values are `{{apiKey}}` placeholders or IPinfo's own `$TOKEN` from its docs.
