import type { Analysis, Auth, Endpoint, Finding, FindingStatus } from "../core/schema.js";

export const STATUS_LABEL: Record<FindingStatus, string> = {
  documented: "Documented",
  inferred: "Inferred",
  not_found: "Not found in docs",
};

/** Folder-safe slug for outputs/<api-name>/. */
export function apiSlug(analysis: Pick<Analysis, "apiName" | "docsUrl">): string {
  const fromName = analysis.apiName
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  if (fromName) return fromName;
  return new URL(analysis.docsUrl).hostname.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
}

/** Base URL without a trailing slash, or null if it wasn't found. */
export function baseUrlOf(analysis: Pick<Analysis, "baseUrl">): string | null {
  const value = analysis.baseUrl.status === "not_found" ? null : analysis.baseUrl.value;
  return value ? value.replace(/\/+$/, "") : null;
}

export function usableEndpoints(analysis: Pick<Analysis, "endpoints">): Array<Finding<Endpoint> & { value: Endpoint }> {
  return analysis.endpoints.filter(
    (e): e is Finding<Endpoint> & { value: Endpoint } => e.status !== "not_found" && e.value !== null,
  );
}

export type AuthMethod = Finding<Auth> & { value: Auth };

/**
 * Every documented auth method, primary first, without duplicates. Only
 * documented methods count: an inferred primary is left out, so the first
 * documented alternative takes its place.
 */
export function documentedAuthMethods(analysis: Pick<Analysis, "auth" | "authAlternatives">): AuthMethod[] {
  const methods: AuthMethod[] = [];
  const seen = new Set<string>();
  for (const f of [analysis.auth, ...analysis.authAlternatives]) {
    if (f.status !== "documented" || !f.value) continue;
    const key = `${f.value.type}|${f.value.location ?? ""}|${(f.value.parameterName ?? "").toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    methods.push(f as AuthMethod);
  }
  return methods;
}

export type EndpointTarget =
  | { kind: "relative"; path: string }
  | { kind: "absolute"; origin: string; host: string; path: string };

/**
 * The agent is asked for paths relative to the base URL, but docs sometimes
 * show a full URL (often on another host). Full URLs under the base URL are
 * made relative; others keep their own origin.
 */
export function endpointTarget(path: string, baseUrl: string | null): EndpointTarget {
  const trimmed = path.trim();
  if (baseUrl && trimmed.toLowerCase().startsWith(baseUrl.toLowerCase())) {
    const rest = trimmed.slice(baseUrl.length);
    if (rest === "" || rest.startsWith("/") || rest.startsWith("?")) {
      return { kind: "relative", path: rest.startsWith("/") ? rest : `/${rest}` };
    }
  }
  // Parsed by hand: new URL() would percent-encode {placeholders}.
  const match = /^(https?:\/\/([^/?#]+))(\/[^?#]*)?/i.exec(trimmed);
  if (match) {
    return { kind: "absolute", origin: match[1]!, host: match[2]!.toLowerCase(), path: match[3] || "/" };
  }
  return { kind: "relative", path: trimmed.startsWith("/") ? trimmed : `/${trimmed}` };
}

/** "/locations/{id}" -> "/locations/:id" (Postman path variable syntax). */
export function toPostmanPath(path: string): string {
  return path.replace(/\{([^}]+)\}/g, ":$1");
}
