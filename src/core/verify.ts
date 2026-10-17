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
    const checked = check(`endpoints[${i}] ${label}`, ep);
    if (!checked.value) return checked;
    // exampleBodyFrom is set here, never taken from the model.
    const { exampleBodyFrom: _claimed, ...unflagged } = checked.value;
    let value: typeof checked.value = unflagged;
    // An example body is used as-is in Postman, so it must come from a cited page.
    if (value.exampleBody !== undefined) {
      const from = exampleOnCitedPage(value.exampleBody, ep.sources, pages);
      if (from) {
        value = { ...value, exampleBodyFrom: from };
      } else {
        const { exampleBody: _dropped, ...rest } = value;
        value = rest;
        downgrades.push({ field: `endpoints[${i}] ${label} example body`, reason: "example body not found on the cited page" });
      }
    }
    // An access restriction makes failures "expected" in test runs, so it must be quoted from the docs.
    if (value.access) {
      const result = checkSource(value.access.source, pages);
      if (result.verified) {
        value = { ...value, access: { ...value.access, source: result.source } };
      } else {
        const { access: _dropped, ...rest } = value;
        value = rest;
        downgrades.push({ field: `endpoints[${i}] ${label} access`, reason: `access restriction: ${result.problem}` });
      }
    }
    return { ...checked, value };
  });

  // OAuth token URLs are used in Postman's token helper, so they must be on a cited page.
  const checkTokenUrl = <F extends Finding<Auth>>(field: string, f: F): F => {
    if (!f.value?.tokenUrl || onCitedPage(f.value.tokenUrl, f.sources, pages)) return f;
    const { tokenUrl: _dropped, ...rest } = f.value;
    downgrades.push({ field: `${field} token URL`, reason: "token URL not found on the cited page" });
    return { ...f, value: rest };
  };
  result.auth = checkTokenUrl("auth", result.auth);
  result.authAlternatives = result.authAlternatives.map((alt, i) => checkTokenUrl(`authAlternatives[${i}]`, alt));

  if (result.webhooks.value?.examplePayload !== undefined) {
    const { examplePayload, ...rest } = result.webhooks.value;
    if (!exampleOnCitedPage(examplePayload, result.webhooks.sources, pages)) {
      result.webhooks = { ...result.webhooks, value: rest };
      downgrades.push({ field: "webhooks example payload", reason: "example payload not found on the cited page" });
    }
  }

  if (result.environments) {
    result.environments = result.environments.map((env, i) => {
      const label = `environments[${i}] ${env.value?.name ?? ""}`.trim();
      const checked = check(label, env);
      // A documented environment's URL must itself appear on the cited page, not just its name.
      if (checked.status === "documented" && checked.value && !onCitedPage(checked.value.url, checked.sources, pages)) {
        downgrades.push({ field: label, reason: "its URL was not found on the cited page" });
        const note = "Downgraded from documented: its URL was not found on the cited page.";
        return { ...checked, status: "inferred" as const, reasoning: checked.reasoning ? `${checked.reasoning} ${note}` : note };
      }
      return checked;
    });
  }

  if (result.flow) {
    const known = new Set(result.endpoints.flatMap((e) => (e.value ? [endpointKey(`${e.value.method} ${e.value.path}`)] : [])));
    result.flow = result.flow.map((step, i) => {
      const checked = check(`flow[${i}] ${step.value?.action ?? ""}`.trim(), step);
      // A step may only point at an endpoint the analysis lists.
      if (checked.value?.endpoint && !known.has(endpointKey(checked.value.endpoint))) {
        const { endpoint: _dropped, ...rest } = checked.value;
        return { ...checked, value: rest };
      }
      return checked;
    });
  }

  return { output: result, downgrades };
}

const endpointKey = (s: string) => s.trim().replace(/\s+/g, " ").toUpperCase();

/**
 * True when a JSON example's keys and values all appear on the page, e.g. an
 * OpenAPI spec's YAML example rewritten as JSON. Every key and every string or
 * number must be a whole word sequence in the page text; at least two must exist.
 */
export function jsonExampleMatchesPage(example: string, pageText: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(example);
  } catch {
    return false;
  }
  const atoms: string[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") {
      for (const [k, child] of Object.entries(v)) {
        atoms.push(k);
        walk(child);
      }
    } else if (typeof v === "string" || typeof v === "number") atoms.push(String(v));
  };
  walk(parsed);
  const words = atoms.map(normalizeForMatch).filter(Boolean);
  if (words.length < 2) return false;
  const page = ` ${normalizeForMatch(pageText)} `;
  return words.every((w) => page.includes(` ${w} `));
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

function citedPages(sources: Source[], pages: ReadonlyMap<string, StoredPage>): StoredPage[] {
  return sources.flatMap((s) => {
    const page = pages.get(normalizeUrl(s.url, s.url) ?? s.url);
    return page ? [page] : [];
  });
}

function onCitedPage(text: string, sources: Source[], pages: ReadonlyMap<string, StoredPage>): boolean {
  return citedPages(sources, pages).some((p) => quoteAppearsIn(text, p.text));
}

/**
 * Where an example comes from: verbatim (the same words in the same order on a
 * cited page; formatting and punctuation ignored, so JSON of an in-order YAML
 * example counts), converted (every key and value is there, in another order
 * or form), or not found.
 */
function exampleOnCitedPage(
  example: string,
  sources: Source[],
  pages: ReadonlyMap<string, StoredPage>,
): "verbatim" | "converted" | null {
  const cited = citedPages(sources, pages);
  if (cited.some((p) => quoteAppearsIn(example, p.text))) return "verbatim";
  if (cited.some((p) => jsonExampleMatchesPage(example, p.text))) return "converted";
  return null;
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
