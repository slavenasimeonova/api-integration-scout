import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Fetcher } from "../../src/core/fetcher.js";

export const ACME_ROOT = "https://docs.acmeweather.example/";

const dir = fileURLToPath(new URL("../fixtures/acme-weather/", import.meta.url));

/** Maps a URL path on the fake Acme docs site to its saved HTML file. */
const ROUTES: Record<string, string> = {
  "/": "index.html",
  "/endpoints": "endpoints.html",
  "/rate-limits": "rate-limits.html",
  "/webhooks": "webhooks.html",
  "/app": "app.html",
};

export function readFixture(file: string): string {
  return readFileSync(dir + file, "utf8");
}

/** Offline fetcher serving the Acme fixtures. Records every requested URL. */
export function createFixtureFetcher(): Fetcher & { requested: string[] } {
  const requested: string[] = [];
  const fetcher = async (url: string) => {
    requested.push(url);
    const { pathname, hostname } = new URL(url);
    const file = hostname === "docs.acmeweather.example" ? ROUTES[pathname] : undefined;
    if (!file) {
      return { finalUrl: url, status: 404, contentType: "text/html", body: "<h1>Not found</h1>" };
    }
    return { finalUrl: url, status: 200, contentType: "text/html; charset=utf-8", body: readFixture(file) };
  };
  return Object.assign(fetcher, { requested });
}
