import type { Analysis, Auth, Finding, FindingStatus } from "./types";

export const STATUS_LABEL: Record<FindingStatus, string> = {
  documented: "Documented",
  inferred: "Inferred",
  not_found: "Not found in docs",
};

export function authLabel(a: Auth): string {
  const where = a.location && a.location !== "none" ? ` in ${a.location}` : "";
  const name = a.parameterName ? ` (${a.parameterName})` : "";
  return `${a.type.replace("_", " ")}${where}${name}`;
}

/** One-line summary of each "at a glance" area, matching analysis.md. */
export function glanceRows(a: Analysis): { area: string; finding: Finding<unknown>; text: string }[] {
  return [
    { area: "Base URL", finding: a.baseUrl, text: a.baseUrl.value ?? "" },
    { area: "Authentication", finding: a.auth, text: a.auth.value ? `${authLabel(a.auth.value)}: ${a.auth.value.description}` : "" },
    {
      area: "Pagination",
      finding: a.pagination,
      text: a.pagination.value ? `${a.pagination.value.style}: ${a.pagination.value.description}` : "",
    },
    { area: "Rate limits", finding: a.rateLimits, text: a.rateLimits.value?.limits ?? "" },
    {
      area: "Webhooks",
      finding: a.webhooks,
      text: a.webhooks.value
        ? a.webhooks.value.supported
          ? `Yes${a.webhooks.value.events.length ? `: ${a.webhooks.value.events.join(", ")}` : ""}${a.webhooks.value.signatureVerification ? `. Signature: ${a.webhooks.value.signatureVerification}` : ""}`
          : "Not supported"
        : "",
    },
    { area: "Error format", finding: a.errorFormat, text: a.errorFormat.value?.description ?? "" },
    {
      area: "Versioning",
      finding: a.versioning,
      text: a.versioning.value
        ? `${a.versioning.value.scheme}${a.versioning.value.current ? ` (${a.versioning.value.current})` : ""}: ${a.versioning.value.description}`
        : "",
    },
  ];
}

/** Only http(s) links are rendered as links (the URLs come from model output). */
export function safeHref(url: string): string | undefined {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function shortPath(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return url;
  }
}
