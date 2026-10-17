import type { Fetcher } from "./fetcher.js";
import { fetchableUrl, isSameSite, normalizeUrl } from "./html.js";
import { robotsSitemaps, sitemapLocations } from "./relevance.js";

/** At most this many sitemap files are read (robots.txt and pages don't count). */
const MAX_SITEMAP_FILES = 3;
const MAX_URLS = 20_000;

export type SitemapResult = {
  /** Sitemap files that were read. */
  sitemaps: string[];
  /** Same-site page URLs listed in them. */
  urls: string[];
};

/**
 * Goal mode: finds the site's sitemap (robots.txt "Sitemap:" lines, then
 * /sitemap.xml) and returns its same-site URLs, so the goal ranking can point
 * the agent at pages that aren't linked from the start page. Reads a sitemap
 * index one level deep. Never throws: a missing or broken sitemap is normal.
 * Skipped for docs on GitHub, whose sitemap lists all of github.com.
 */
export async function discoverSitemap(rootUrl: string, fetcher: Fetcher): Promise<SitemapResult> {
  const result: SitemapResult = { sitemaps: [], urls: [] };
  const root = new URL(rootUrl);
  if (fetchableUrl(rootUrl) !== rootUrl || /(^|\.)github(usercontent)?\.com$/i.test(root.hostname)) return result;

  const get = async (url: string): Promise<string | null> => {
    try {
      const res = await fetcher(url);
      return res.status < 400 && isSameSite(res.finalUrl, rootUrl) ? res.body : null;
    } catch {
      return null;
    }
  };

  const queue: string[] = [];
  const robots = await get(new URL("/robots.txt", root).toString());
  if (robots) {
    for (const s of robotsSitemaps(robots)) {
      const url = normalizeUrl(s, rootUrl);
      if (url && isSameSite(url, rootUrl)) queue.push(url);
    }
  }
  if (!queue.length) queue.push(new URL("/sitemap.xml", root).toString());

  const pages = new Set<string>();
  const done = new Set<string>();
  while (queue.length && done.size < MAX_SITEMAP_FILES) {
    const url = queue.shift()!;
    if (done.has(url)) continue;
    done.add(url);
    const xml = await get(url);
    if (!xml || !/<(urlset|sitemapindex)\b/i.test(xml)) continue;
    result.sitemaps.push(url);
    const isIndex = /<sitemapindex\b/i.test(xml);
    for (const loc of sitemapLocations(xml)) {
      const u = normalizeUrl(loc, url);
      if (!u || !isSameSite(u, rootUrl)) continue;
      if (isIndex) queue.push(u);
      else if (pages.size < MAX_URLS) pages.add(u);
    }
  }
  result.urls = [...pages];
  return result;
}
