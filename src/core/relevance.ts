import { fetchableUrl, normalizeUrl } from "./html.js";
import type { ConsideredPage, Discovery, PageVisit } from "./schema.js";
import type { Candidate } from "./tools.js";

/**
 * Goal-directed discovery, done in code: the goal's keywords score each link
 * (its text and URL path), sitemap entry and page heading, so the agent sees
 * the most relevant pages first and the analysis can report what was
 * considered. The agent still chooses what to read, within the page limit.
 */

export { MAX_GOAL_CHARS, normalizeGoal } from "./goal.js";

const STOPWORDS = new Set(
  (
    "a an and are as at be by for from get how i in into is it me my of on or our receive send the their them then this " +
    "to up use using via want we when with you your api apis docs doc documentation integration integrate automation build building " +
    "need needs new make all any can do does each per out over about which what will should would"
  ).split(" "),
);

/** Splits text into lowercase word tokens; camelCase and digits split too ("TrackAlert" -> track, alert). */
export function tokens(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Crude stem so "events"/"event", "tracking"/"track" and "subscriptions"/"subscribe" meet. */
export function stem(word: string): string {
  let w = word;
  for (const suffix of ["ations", "ation", "tions", "tion", "ings", "ing", "ers", "er", "ies", "es", "ed", "s"]) {
    if (w.length - suffix.length >= 4 && w.endsWith(suffix)) {
      w = suffix === "ies" ? `${w.slice(0, -3)}y` : w.slice(0, -suffix.length);
      break;
    }
  }
  if (w.length > 4 && w.endsWith("e")) w = w.slice(0, -1);
  // "subscri-be" / "subscri-ption": long words meet on a 7-letter prefix.
  return w.length > 7 ? w.slice(0, 7) : w;
}

/** The goal's keywords, stemmed and de-duplicated, in the order they appear. */
export function goalTerms(goal: string): string[] {
  const out: string[] = [];
  for (const t of tokens(goal)) {
    if (t.length < 3 || STOPWORDS.has(t) || /^\d+$/.test(t)) continue;
    const s = stem(t);
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

/**
 * Authentication is rarely part of a goal but every integration needs it, so
 * auth links always get 1 point (matched as "auth").
 */
const AUTH_STEMS = new Set(["auth", "oauth", "oauth2", "authent", "authori", "token", "credent", "apikey", "login"].map((w) => w));

export type Match = { score: number; matched: string[] };

function matchTerms(words: string[], terms: string[]): string[] {
  const stems = new Set(words.map(stem));
  return terms.filter((t) => stems.has(t));
}

/**
 * Scores a link for the goal: 2 per term in the link text, 1 per term only in
 * the URL path (file and folder names, e.g. UPSTrackAlert.yaml). Query strings
 * and the host are ignored.
 */
export function scoreLink(link: { url: string; text: string }, terms: string[]): Match {
  let path = "";
  try {
    path = decodeURIComponent(new URL(link.url).pathname);
  } catch {
    path = link.url;
  }
  const inText = matchTerms(tokens(link.text), terms);
  const inPath = matchTerms(tokens(path), terms).filter((t) => !inText.includes(t));
  const matched = [...inText, ...inPath];
  let score = inText.length * 2 + inPath.length;
  const words = [...tokens(link.text), ...tokens(path)].map(stem);
  if (!matched.some((t) => AUTH_STEMS.has(t)) && words.some((w) => AUTH_STEMS.has(w))) {
    matched.push("auth");
    score += 1;
  }
  return { score, matched };
}

/** Headings on a page that mention a goal term, for the "sections on this page" hint. */
export function matchingHeadings(headings: string[], terms: string[], max = 12): string[] {
  return headings.filter((h) => matchTerms(tokens(h), terms).length > 0).slice(0, max);
}

/** Unread candidates kept in the report, best first. */
const MAX_UNREAD_IN_REPORT = 25;

type Note = { url: string; relevant: boolean; reason: string };

/**
 * The "pages considered" report: pages read (in order) and the best-scoring
 * links seen but not read, with the agent's reasons attached. A reason for a
 * URL the agent never read or saw is dropped and returned in `dropped`, so the
 * report only describes pages that really were considered.
 */
export function buildDiscovery(args: {
  terms: string[];
  visits: PageVisit[];
  candidates: Candidate[];
  notes: Note[] | undefined;
  sitemap: Discovery["sitemap"];
}): { discovery: Discovery; dropped: string[] } {
  const key = (url: string) => fetchableUrl(normalizeUrl(url, url) ?? url);
  const byUrl = new Map(args.candidates.map((c) => [key(c.url), c]));
  const pages = new Map<string, ConsideredPage>();

  for (const v of args.visits) {
    const k = key(v.url);
    if (pages.has(k)) continue;
    const c = byUrl.get(k) ?? { ...scoreLink({ url: v.url, text: "" }, args.terms) };
    const read = v.status === "failed" ? "failed" : v.truncated ? "partly" : "read";
    pages.set(k, { url: v.url, score: c.score, matched: c.matched, read });
  }
  for (const c of args.candidates) {
    if (pages.size >= args.visits.length + MAX_UNREAD_IN_REPORT) break;
    const k = key(c.url);
    if (c.score > 0 && !pages.has(k)) pages.set(k, { url: c.url, score: c.score, matched: c.matched, read: "not_read" });
  }

  const dropped: string[] = [];
  for (const note of args.notes ?? []) {
    const k = key(note.url);
    let page = pages.get(k);
    if (!page && byUrl.has(k)) {
      // A link the agent chose to skip although its keyword score was 0.
      const c = byUrl.get(k)!;
      page = { url: c.url, score: c.score, matched: c.matched, read: "not_read" };
      pages.set(k, page);
    }
    if (!page) {
      dropped.push(note.url);
      continue;
    }
    page.relevant = note.relevant;
    page.reason = note.reason.replace(/\s+/g, " ").trim().slice(0, 300);
  }
  return { discovery: { terms: args.terms, sitemap: args.sitemap, pages: [...pages.values()] }, dropped };
}

/** Every <loc> in a sitemap or sitemap index (XML; no parser needed for this shape). */
export function sitemapLocations(xml: string): string[] {
  const out: string[] = [];
  for (const m of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
    out.push(m[1]!.replace(/&amp;/g, "&"));
  }
  return out;
}

/** Sitemap URLs listed in robots.txt ("Sitemap: https://..."). */
export function robotsSitemaps(robots: string): string[] {
  return [...robots.matchAll(/^\s*sitemap\s*:\s*(\S+)/gim)].map((m) => m[1]!);
}
