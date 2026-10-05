import type { Analysis, Endpoint, Finding } from "../core/schema.js";
import { usableEndpoints } from "./format.js";

/** Mermaid treats ; and # specially and messages must stay on one line. */
function text(s: string, max = 90): string {
  const clean = s.replace(/[\r\n]+/g, " ").replace(/;/g, ",").replace(/#/g, "no. ").replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function tag(f: Pick<Finding<unknown>, "status">): string {
  return f.status === "inferred" ? " (inferred)" : "";
}

function call(ep: Finding<Endpoint> & { value: Endpoint }): string {
  return `${ep.value.method} ${ep.value.path}`;
}

/** Sequence diagram of the main integration flow, built only from what was found. */
export function buildSequenceDiagram(analysis: Analysis): string {
  const endpoints = usableEndpoints(analysis);
  const auth = analysis.auth.status !== "not_found" ? analysis.auth.value : null;
  const credential = auth?.parameterName ?? (auth?.type === "bearer" || auth?.type === "oauth2" ? "Authorization: Bearer" : "credentials");
  const lines = ["sequenceDiagram", "  autonumber", "  participant App as Your app", `  participant API as ${text(analysis.apiName, 40)} API`];

  if (auth?.type === "oauth2") {
    lines.splice(3, 0, "  participant Auth as Authorization server");
    lines.push(`  App->>Auth: Request access token (OAuth 2.0)${tag(analysis.auth)}`, "  Auth-->>App: Access token");
  } else if (auth && auth.type !== "none") {
    lines.push(`  Note over App,API: Auth: ${text(auth.description, 70)}${tag(analysis.auth)}`);
  } else if (!auth) {
    lines.push("  Note over App,API: Auth not found in docs");
  }

  const main = endpoints.find((e) => e.value.method === "GET" && !e.value.path.includes("{")) ?? endpoints[0];
  if (main) {
    lines.push(`  App->>API: ${text(call(main))} (${text(credential, 30)})${tag(main)}`, `  API-->>App: 200 ${text(main.value.purpose, 60)}`);
  }

  if (analysis.errorFormat.status !== "not_found" && analysis.errorFormat.value) {
    lines.push("  alt Error", `    API-->>App: 4xx/5xx ${text(analysis.errorFormat.value.description, 60)}${tag(analysis.errorFormat)}`);
    if (analysis.rateLimits.status !== "not_found" && analysis.rateLimits.value) {
      lines.push("  else Rate limited", `    API-->>App: 429 (${text(analysis.rateLimits.value.limits, 50)})${tag(analysis.rateLimits)}`);
    }
    lines.push("  end");
  } else if (analysis.rateLimits.status !== "not_found" && analysis.rateLimits.value) {
    lines.push(`  Note over App,API: Rate limit: ${text(analysis.rateLimits.value.limits, 60)}${tag(analysis.rateLimits)}`);
  }

  const pagination = analysis.pagination.status !== "not_found" ? analysis.pagination.value : null;
  if (pagination && pagination.style !== "none") {
    const paramNames = new Set(pagination.parameters.map((p) => p.toLowerCase()));
    const paged =
      endpoints.find((e) => e.value.keyParams.some((p) => paramNames.has(p.name.toLowerCase()))) ??
      endpoints.find((e) => e.value.method === "GET" && !e.value.path.includes("{")) ??
      main;
    lines.push(
      `  loop Until no more pages (${pagination.style})${tag(analysis.pagination)}`,
      `    App->>API: ${paged ? text(call(paged)) : "List request"} with ${text(pagination.parameters.join(", ") || pagination.style, 40)}`,
      "    API-->>App: Page of results + next marker",
      "  end",
    );
  }

  const hooks = analysis.webhooks.status !== "not_found" ? analysis.webhooks.value : null;
  if (hooks?.supported) {
    const subscribe = endpoints.find((e) => e.value.keyParams.some((p) => /callback|webhook|url/i.test(p.name)) && e.value.method === "POST");
    lines.push(`  opt Webhooks${tag(analysis.webhooks)}`);
    if (subscribe) lines.push(`    App->>API: ${text(call(subscribe))} (register callback)`);
    lines.push(`    API->>App: POST event (${text(hooks.events.slice(0, 3).join(", ") || "event", 60)})`);
    if (hooks.signatureVerification) lines.push(`    App->>App: Verify signature: ${text(hooks.signatureVerification, 60)}`);
    lines.push("    App-->>API: 2xx acknowledge", "  end");
  }

  return lines.join("\n") + "\n";
}
