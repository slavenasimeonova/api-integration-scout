import * as cheerio from "cheerio";

export type PageLink = { url: string; text: string };

export type ExtractedPage = {
  title: string;
  text: string;
  links: PageLink[];
  /** True when a <noscript> block asks the reader to enable JavaScript. */
  mentionsJavaScriptRequired: boolean;
};

const BLOCK_SELECTOR =
  "p,div,li,ul,ol,h1,h2,h3,h4,h5,h6,tr,table,pre,section,article,header,footer,nav,aside,main,dt,dd,dl,blockquote,figure";

const SKIP_LINK_EXTENSIONS = /\.(png|jpe?g|gif|svg|webp|ico|css|js|zip|gz|tar|mp4|woff2?)$/i;

/** Turns an HTML page into readable plain text plus its outgoing http(s) links. */
export function extractPage(html: string, pageUrl: string): ExtractedPage {
  const $ = cheerio.load(html);

  const title = $("title").first().text().trim() || $("h1").first().text().trim();
  const mentionsJavaScriptRequired = /javascript/i.test($("noscript").text());

  const links: PageLink[] = [];
  const seen = new Set<string>();
  $("a[href]").each((_, el) => {
    const url = normalizeUrl($(el).attr("href") ?? "", pageUrl);
    if (!url || seen.has(url) || SKIP_LINK_EXTENSIONS.test(new URL(url).pathname)) return;
    seen.add(url);
    links.push({ url, text: collapse($(el).text()).slice(0, 100) });
  });

  $("script,style,noscript,svg,iframe,template,link,meta").remove();
  $("br").replaceWith("\n");
  $(BLOCK_SELECTOR).each((_, el) => {
    $(el).prepend("\n").append("\n");
  });

  const rootSelector = $("main").length ? "main" : $("body").length ? "body" : null;
  const rawText = rootSelector ? $(rootSelector).text() : $.root().text();
  const text = rawText
    .split("\n")
    .map(collapse)
    .filter((line) => line.length > 0)
    .join("\n");

  return { title, text, links, mentionsJavaScriptRequired };
}

/** Resolves a link against its page and strips the #fragment. Returns null for non-http(s). */
export function normalizeUrl(href: string, base: string): string | null {
  try {
    const url = new URL(href.trim(), base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * Same site = same host, or one host is a subdomain of the other
 * (docs.stripe.com <-> stripe.com). Sibling subdomains on shared hosts
 * (a.github.io vs b.github.io) are deliberately not treated as the same site.
 */
export function isSameSite(url: string, rootUrl: string): boolean {
  const a = hostOf(url);
  const b = hostOf(rootUrl);
  if (!a || !b) return false;
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}
