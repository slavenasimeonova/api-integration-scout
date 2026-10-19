import * as cheerio from "cheerio";

export type PageLink = { url: string; text: string };

export type Heading = { level: 1 | 2 | 3; text: string };

export type ExtractedPage = {
  title: string;
  text: string;
  links: PageLink[];
  /** h1 to h3 in page order: the section map of long pages, and goal matches. */
  headings: Heading[];
  /**
   * True when the page shows signs of client-side rendering: a <noscript>
   * notice asking for JavaScript, or an empty SPA mount element.
   */
  looksClientRendered: boolean;
};

const BLOCK_SELECTOR =
  "p,div,li,ul,ol,h1,h2,h3,h4,h5,h6,tr,table,pre,section,article,header,footer,nav,aside,main,dt,dd,dl,blockquote,figure";

/** Mount points used by common SPA frameworks (React, Vue, Next, Nuxt, Docusaurus, Svelte). */
const SPA_MOUNT_SELECTOR = "#root, #app, #__next, #__nuxt, #__docusaurus, #svelte, [data-reactroot]";

const SKIP_LINK_EXTENSIONS = /\.(png|jpe?g|gif|svg|webp|ico|css|js|zip|gz|tar|mp4|woff2?)$/i;

/** Turns an HTML page into readable plain text plus its outgoing http(s) links. */
export function extractPage(html: string, pageUrl: string): ExtractedPage {
  const $ = cheerio.load(html);

  const title = $("title").first().text().trim() || $("h1").first().text().trim();
  const emptyMount = $(SPA_MOUNT_SELECTOR)
    .toArray()
    .some((el) => collapse($(el).text()) === "");
  const looksClientRendered = /javascript/i.test($("noscript").text()) || emptyMount;

  const links: PageLink[] = [];
  const seen = new Set<string>();
  $("a[href]").each((_, el) => {
    const url = normalizeUrl($(el).attr("href") ?? "", pageUrl);
    if (!url || seen.has(url) || SKIP_LINK_EXTENSIONS.test(new URL(url).pathname)) return;
    // Unrendered template placeholders (GitHub's docs link to "${externalDocsUrl}/..."): not real pages.
    if (/\$\{|\{\{|\$%7B|%7B%7B/i.test(url)) return;
    seen.add(url);
    links.push({ url, text: collapse($(el).text()).slice(0, 100) });
  });

  const headings: Heading[] = $("h1,h2,h3")
    .toArray()
    .map((el) => ({ level: Number(el.tagName.slice(1)) as Heading["level"], text: collapse($(el).text()).slice(0, 120) }))
    .filter((h) => h.text);

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

  return { title, text, links, headings, looksClientRendered };
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

const GITHUB_HOSTS = new Set(["github.com", "raw.githubusercontent.com"]);

/** The repository owner of a github.com or raw.githubusercontent.com URL, lowercased ("" for the home page). */
function githubOwner(url: string): string | null {
  try {
    const u = new URL(url);
    if (!GITHUB_HOSTS.has(u.hostname.toLowerCase().replace(/^www\./, ""))) return null;
    return (u.pathname.split("/")[1] ?? "").toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Same site = same host, or one host is a subdomain of the other
 * (docs.stripe.com <-> stripe.com). Sibling subdomains on shared hosts
 * (a.github.io vs b.github.io) are deliberately not treated as the same site.
 * Docs on GitHub (e.g. github.com/UPS-API/api-documentation): the same owner
 * on github.com or raw.githubusercontent.com, never another owner's repos.
 */
export function isSameSite(url: string, rootUrl: string): boolean {
  const rootOwner = githubOwner(rootUrl);
  if (rootOwner !== null) return githubOwner(url) === rootOwner;
  const a = hostOf(url);
  const b = hostOf(rootUrl);
  if (!a || !b) return false;
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

/**
 * The URL to fetch for a docs link. A GitHub file page ("blob") becomes its raw
 * file: the blob page's text extraction loses YAML indentation and adds the site's
 * navigation. Other URLs are returned unchanged.
 */
export function fetchableUrl(url: string): string {
  try {
    const u = new URL(url);
    const m = /^\/([^/]+)\/([^/]+)\/blob\/(.+)$/.exec(u.pathname);
    if (u.hostname.toLowerCase().replace(/^www\./, "") !== "github.com" || !m) return url;
    return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`;
  } catch {
    return url;
  }
}

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}
