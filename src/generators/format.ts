import type { Analysis, Endpoint, Finding, FindingStatus } from "../core/schema.js";

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

/** "/locations/{id}" -> "/locations/:id" (Postman path variable syntax). */
export function toPostmanPath(path: string): string {
  return path.replace(/\{([^}]+)\}/g, ":$1");
}
