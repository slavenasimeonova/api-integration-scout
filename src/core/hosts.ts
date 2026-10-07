import type { Endpoint, Finding } from "./schema.js";

/** Result of checking an endpoint's host against the URLs in its verified quotes. */
export type HostCheck =
  | { status: "corrected"; from: string; to: string; evidence: string }
  | { status: "ambiguous"; candidates: string[]; evidence: string[] };

export type AnalysisEndpoint = Finding<Endpoint> & { hostCheck?: HostCheck };

const URL_IN_TEXT = /https?:\/\/[^\s"'<>`)\]]+/gi;

type Match = { origin: string; prefix: string; quote: string };

/**
 * Code-level safeguard for endpoint hosts (the prompt alone isn't reliable).
 *
 * Runs after quote verification, so it only sees quotes that really appear in
 * the docs. For each endpoint with a relative path, it looks for full URLs in
 * those quotes whose path matches the endpoint's path template:
 * - all matches on one other host (none on the base URL's host): use that host
 * - matches on several hosts: mark the endpoint ambiguous for a human to check
 * - no matches, or only the base host: leave the endpoint unchanged
 */
export function checkEndpointHosts(
  endpoints: ReadonlyArray<Finding<Endpoint>>,
  baseUrl: string | null,
): AnalysisEndpoint[] {
  const base = parseBase(baseUrl);
  return endpoints.map((ep) => {
    if (!ep.value || /^https?:\/\//i.test(ep.value.path.trim())) return ep;
    const template = templateRegex(ep.value.path);
    if (!template) return ep;

    const matches: Match[] = [];
    for (const source of ep.sources) {
      if (!source.quote) continue;
      for (const raw of source.quote.match(URL_IN_TEXT) ?? []) {
        const match = matchUrl(raw.replace(/[.,;:!?]+$/, ""), template, source.quote);
        if (match) matches.push(match);
      }
    }

    const onBase = base ? matches.filter((m) => m.origin === base.origin && (m.prefix === base.path || m.prefix === "")) : [];
    const others = matches.filter((m) => !base || m.origin !== base.origin);
    const otherOrigins = [...new Set(others.map((m) => m.origin))];
    if (otherOrigins.length === 0) return ep;

    const path = ep.value.path.startsWith("/") ? ep.value.path : `/${ep.value.path}`;
    if (otherOrigins.length === 1 && onBase.length === 0) {
      const chosen = others[0]!;
      const to = `${chosen.origin}${chosen.prefix}${path}`;
      return {
        ...ep,
        value: { ...ep.value, path: to },
        hostCheck: { status: "corrected", from: ep.value.path, to, evidence: chosen.quote },
      };
    }

    const candidates = [...(onBase.length && baseUrl ? [baseUrl] : []), ...otherOrigins];
    return {
      ...ep,
      hostCheck: { status: "ambiguous", candidates, evidence: [...new Set(matches.map((m) => m.quote))] },
    };
  });
}

function parseBase(baseUrl: string | null): { origin: string; path: string } | null {
  if (!baseUrl) return null;
  try {
    const url = new URL(baseUrl);
    return { origin: url.origin.toLowerCase(), path: url.pathname.replace(/\/+$/, "") };
  } catch {
    return null;
  }
}

/** "/{ip}/json" -> regex matching "<prefix>/8.8.8.8/json" and capturing the prefix. */
function templateRegex(path: string): RegExp | null {
  const segments = path.split("?")[0]!.split("/").filter(Boolean);
  if (segments.length === 0) return null;
  const body = segments
    .map((s) => (/^\{[^}]+\}$/.test(s) ? "[^/]+" : s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("/");
  return new RegExp(`^(.*?)/${body}/?$`, "i");
}

function matchUrl(raw: string, template: RegExp, quote: string): Match | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const m = template.exec(url.pathname);
  if (!m) return null;
  return { origin: url.origin.toLowerCase(), prefix: m[1] ?? "", quote };
}

/** Values that are placeholders in the docs, not usable examples: {ip}, <id>, :id, $IP, YOUR_ID. */
const PLACEHOLDER = /^[{<:$]|your|^x+$|\.\.\./i;

/**
 * Example values for an endpoint's path variables, read from the full URLs in
 * its quotes (only verified quotes remain after verification). For example,
 * GET /lite/{ip} with the quote "curl https://api.ipinfo.io/lite/8.8.8.8?token=$TOKEN"
 * gives { ip: "8.8.8.8" }. The first usable value per variable wins.
 */
export function pathVariableExamples(ep: Finding<Endpoint>): Record<string, string> {
  if (!ep.value) return {};
  const templatePath = ep.value.path.trim().replace(/^https?:\/\/[^/]+/i, "").split("?")[0]!;
  const segments = templatePath.split("/").filter(Boolean);
  const names = segments.flatMap((s) => (/^\{[^}]+\}$/.test(s) ? [s.slice(1, -1)] : []));
  if (names.length === 0) return {};
  const body = segments.map((s) => (/^\{[^}]+\}$/.test(s) ? "([^/]+)" : s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("/");
  const template = new RegExp(`/${body}/?$`, "i");

  const examples: Record<string, string> = {};
  for (const source of ep.sources) {
    for (const raw of source.quote?.match(URL_IN_TEXT) ?? []) {
      let pathname: string;
      try {
        pathname = new URL(raw.replace(/[.,;:!?]+$/, "")).pathname;
      } catch {
        continue;
      }
      const m = template.exec(pathname);
      if (!m) continue;
      names.forEach((name, i) => {
        let value = m[i + 1] ?? "";
        try {
          value = decodeURIComponent(value);
        } catch {
          // Malformed escape: keep the raw text.
        }
        if (!(name in examples) && value && !PLACEHOLDER.test(value)) examples[name] = value;
      });
    }
  }
  return examples;
}
