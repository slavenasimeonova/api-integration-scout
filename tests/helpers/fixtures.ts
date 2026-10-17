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
  "/more-endpoints": "more-endpoints.html",
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

export const GH_ROOT = "https://github.com/parcelpost/api-docs";
export const RAW_SPEC = "https://raw.githubusercontent.com/parcelpost/api-docs/main/parcelpost-alerts.yaml";
export const SPEC = readFileSync(new URL("../fixtures/specs/parcelpost-alerts.yaml", import.meta.url), "utf8");

/** A fake GitHub repo page linking to a spec, plus the spec's raw file. */
export function githubFetcher(): Fetcher & { requested: string[] } {
  const requested: string[] = [];
  const repoPage = `<html><head><title>parcelpost/api-docs</title></head><body><main>
    <h1>api-docs</h1><p>OpenAPI specs for the Parcelpost APIs.</p>
    <a href="/parcelpost/api-docs/blob/main/parcelpost-alerts.yaml">parcelpost-alerts.yaml</a>
    <a href="https://github.com/someone-else/fork">someone-else/fork</a>
    <a href="https://docs.github.com/en">GitHub Docs</a>
  </main></body></html>`;
  const fetcher = async (url: string) => {
    requested.push(url);
    if (url === GH_ROOT) return { finalUrl: url, status: 200, contentType: "text/html", body: repoPage };
    if (url === RAW_SPEC) return { finalUrl: url, status: 200, contentType: "text/plain; charset=utf-8", body: SPEC };
    return { finalUrl: url, status: 404, contentType: "text/plain", body: "404: Not Found" };
  };
  return Object.assign(fetcher, { requested });
}
