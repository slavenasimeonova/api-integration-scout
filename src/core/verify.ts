import { normalizeUrl } from "./html.js";
import type { AgentOutput, Auth, Finding, Source } from "./schema.js";
import type { StoredPage } from "./tools.js";

/** Quotes shorter than this after normalization are too weak to count as evidence. */
const MIN_QUOTE_CHARS = 8;

/**
 * Normalizes text for quote matching so formatting differences don't cause
 * false downgrades: Unicode compatibility forms (non-breaking spaces and
 * hyphens), case, punctuation and whitespace are all ignored. Only the
 * sequence of letters and digits must match.
 */
export function normalizeForMatch(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function quoteAppearsIn(quote: string, pageText: string): boolean {
  const q = normalizeForMatch(quote);
  if (q.length < MIN_QUOTE_CHARS) return false;
  return ` ${normalizeForMatch(pageText)} `.includes(` ${q} `);
}

export type Downgrade = { field: string; reason: string };

export type VerificationResult = { output: AgentOutput; downgrades: Downgrade[] };

const SINGLE_FIELDS = ["baseUrl", "auth", "pagination", "rateLimits", "webhooks", "errorFormat", "versioning"] as const;

/**
 * Checks every "documented" finding against the pages actually fetched. A
 * finding stays documented only if at least one cited quote really appears on
 * the cited page; otherwise it is downgraded to "inferred". Unverifiable quotes
 * are removed so a fabricated quote is never shown to the reader.
 */
export function verifyAnalysis(output: AgentOutput, pages: ReadonlyMap<string, StoredPage>): VerificationResult {
  const downgrades: Downgrade[] = [];
  const result = structuredClone(output);

  const check = <T>(field: string, finding: Finding<T>): Finding<T> => {
    const verified = verifyFinding(finding, pages);
    if (verified.downgradeReason) downgrades.push({ field, reason: verified.downgradeReason });
    return verified.finding;
  };

  for (const key of SINGLE_FIELDS) {
    // Each field keeps its own value type; the cast only satisfies the loop.
    (result as Record<string, unknown>)[key] = check(key, result[key] as Finding<unknown>);
  }
  result.authAlternatives = result.authAlternatives.map((alt, i) =>
    check(`authAlternatives[${i}] ${alt.value ? authLabel(alt.value) : `#${i + 1}`}`, alt),
  );
  result.endpoints = result.endpoints.map((ep, i) => {
    const label = ep.value ? `${ep.value.method} ${ep.value.path}` : `#${i + 1}`;
    return check(`endpoints[${i}] ${label}`, ep);
  });

  return { output: result, downgrades };
}

/** Short human label for an auth method, e.g. "api_key in query (token)". */
export function authLabel(auth: Auth): string {
  const where = auth.location && auth.location !== "none" ? ` in ${auth.location}` : "";
  return `${auth.type}${where}${auth.parameterName ? ` (${auth.parameterName})` : ""}`;
}

function verifyFinding<T>(
  finding: Finding<T>,
  pages: ReadonlyMap<string, StoredPage>,
): { finding: Finding<T>; downgradeReason?: string } {
  if (finding.status === "not_found") {
    return { finding: { ...finding, value: null } };
  }
  if (finding.status === "inferred") {
    return {
      finding: { ...finding, sources: finding.sources.map((s) => checkSource(s, pages).source) },
    };
  }

  const checked = finding.sources.map((s) => checkSource(s, pages));
  const sources = checked.map((c) => c.source);
  if (checked.some((c) => c.verified)) {
    return { finding: { ...finding, sources } };
  }

  const reason =
    finding.sources.length === 0
      ? "marked documented but cites no source"
      : checked.map((c) => c.problem).filter(Boolean).join("; ");
  const note = `Downgraded from documented: ${reason}.`;
  return {
    finding: {
      ...finding,
      status: "inferred",
      sources,
      reasoning: finding.reasoning ? `${finding.reasoning} ${note}` : note,
    },
    downgradeReason: reason,
  };
}

function checkSource(
  source: Source,
  pages: ReadonlyMap<string, StoredPage>,
): { source: Source; verified: boolean; problem?: string } {
  const url = normalizeUrl(source.url, source.url) ?? source.url;
  const page = pages.get(url);
  if (!page) {
    return { source: { url: source.url }, verified: false, problem: `${source.url} was not fetched` };
  }
  if (!source.quote) {
    return { source: { url: page.url }, verified: false, problem: `no quote given for ${page.url}` };
  }
  if (!quoteAppearsIn(source.quote, page.text)) {
    return { source: { url: page.url }, verified: false, problem: `quote not found on ${page.url}` };
  }
  return { source: { url: page.url, quote: source.quote }, verified: true };
}
