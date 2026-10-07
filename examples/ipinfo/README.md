# Example: IPinfo

Output from a real run against <https://ipinfo.io/developers> on 2026-10-06:

```
npm run scout -- https://ipinfo.io/developers --max-pages 5
```

The run used `claude-sonnet-5-5` and read 3 pages, two of which were truncated at 12,000 characters (both flagged in the analysis). It took 10 turns and 27 seconds. Token usage was 8 input, 3,601 output, 29,193 cache write and 47,271 cache read, for an estimated cost of **$0.12**.

| File | Contents |
| --- | --- |
| [`analysis.md`](analysis.md) | Integration summary: every finding labeled Documented, Inferred or Not found in docs, with source quotes |
| [`postman_collection.json`](postman_collection.json) | Postman Collection v2.1, validated against the official schema; credentials are only `{{apiKey}}` |
| [`sequence.mmd`](sequence.mmd) | Mermaid sequence diagram of the main flow |

**How these files were produced.** The model's findings are exactly what the run returned. The output files were later regenerated offline from that run's `analysis.json` with the current code, with no model call. That changed three things:

- `GET /{ip}/json` now points to `https://ipinfo.io`, not the `api.ipinfo.io` base URL. That host comes from a verified quote in the docs (`curl https://ipinfo.io/8.8.8.8/json?token=$TOKEN`), and the correction is listed under Warnings in `analysis.md`.
- The `ip` path variable is prefilled with `8.8.8.8`, the value in the docs' own example URLs, and the `token` query param no longer appears on every endpoint, since auth supplies it.
- `POST /batch` has no body. The docs pages read show no example body, so instead of a made-up `{"body": "<body>"}` the request description lists the documented body field.

The collection was tested end-to-end in Postman: imported with the environment, token set in `apiKey`, and `GET /lite/me` returned 200 with correct data.

These files contain no credentials. All auth values are `{{apiKey}}` placeholders or IPinfo's own `$TOKEN` from its docs.
