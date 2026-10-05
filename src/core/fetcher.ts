export type FetchResponse = {
  /** URL after redirects. */
  finalUrl: string;
  status: number;
  contentType: string;
  body: string;
};

/**
 * Anything that can retrieve a URL. The core only depends on this interface,
 * so tests inject saved fixtures and a web app could inject a cached fetcher.
 */
export type Fetcher = (url: string) => Promise<FetchResponse>;

const MAX_BODY_BYTES = 5 * 1024 * 1024;

export function createHttpFetcher(timeoutMs: number): Fetcher {
  return async (url) => {
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        "User-Agent": "api-integration-scout/1.0 (+docs analysis)",
        Accept: "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.5",
      },
    });
    const length = Number(res.headers.get("content-length") ?? 0);
    if (length > MAX_BODY_BYTES) {
      throw new Error(`Response too large (${length} bytes)`);
    }
    const body = await res.text();
    return {
      finalUrl: res.url || url,
      status: res.status,
      contentType: res.headers.get("content-type") ?? "",
      body: body.length > MAX_BODY_BYTES ? body.slice(0, MAX_BODY_BYTES) : body,
    };
  };
}
