import type { Analysis, Auth } from "../core/schema.js";
import { baseUrlOf, documentedAuthMethods, endpointTarget, usableEndpoints, type UsableEndpoint } from "./format.js";
import { clientCredentialsAuth, maskCredentialFields } from "./variables.js";

export type ExampleRequest = {
  /** e.g. "POST /subscription/{type}/package" */
  title: string;
  purpose: string;
  curl: string;
  /** Where the body came from: verbatim from the docs, or a spec example converted to JSON. */
  bodyFrom?: "verbatim" | "converted";
  /** Path or query placeholders the user replaces, e.g. ["type", "version"]. */
  placeholders: string[];
  /** Body fields whose doc values were replaced by {{variables}}. */
  maskedFields: string[];
};

/** Single-quoted for POSIX shells: ' becomes '\'' */
const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

function authParts(auth: Auth | undefined): { headers: string[]; query: string[]; extra: string[]; note?: string } {
  if (!auth) return { headers: [], query: [], extra: [], note: "No documented auth method: add the credential yourself." };
  const name = auth.parameterName;
  switch (auth.type) {
    case "api_key":
      if (auth.location === "query") return { headers: [], query: [`${name ?? "api_key"}={{apiKey}}`], extra: [] };
      if (auth.location === "cookie") return { headers: [], query: [], extra: [`-b ${sq(`${name ?? "session"}={{apiKey}}`)}`] };
      return { headers: [`${name ?? "X-API-Key"}: {{apiKey}}`], query: [], extra: [] };
    case "bearer":
    case "oauth2":
      return { headers: ["Authorization: Bearer {{apiKey}}"], query: [], extra: [] };
    case "basic":
      return { headers: [], query: [], extra: [`-u ${sq("{{apiKey}}:")}`] };
    default:
      return { headers: [], query: [], extra: [], note: `Auth (${auth.type}): ${auth.description}` };
  }
}

/**
 * Example requests as curl commands, built in code from the verified analysis.
 * Credentials and the base URL are always {{variables}} (the same names as in
 * the Postman collection); a body is included only when it came from the docs.
 */
export function buildExampleRequests(analysis: Analysis): ExampleRequest[] {
  const baseUrl = baseUrlOf(analysis);
  // With a documented client-credentials flow, the first example gets the token and the rest use it.
  const oauth = clientCredentialsAuth(analysis);
  const auth = oauth
    ? { headers: ["Authorization: Bearer {{accessToken}}"], query: [], extra: [] }
    : authParts(documentedAuthMethods(analysis)[0]?.value);
  const token: ExampleRequest[] = oauth
    ? [
        {
          title: "Get an access token (OAuth 2.0 client credentials)",
          purpose: `Token URL from the docs: ${oauth.tokenUrl}. Put the access_token from the response in {{accessToken}}.`,
          curl: [
            "curl -X POST '{{tokenUrl}}' \\",
            "  -u '{{clientId}}:{{clientSecret}}' \\",
            "  -H 'Content-Type: application/x-www-form-urlencoded' \\",
            "  --data 'grant_type=client_credentials'",
          ].join("\n"),
          placeholders: [],
          maskedFields: [],
        },
      ]
    : [];
  return token.concat(usableEndpoints(analysis).map((ep: UsableEndpoint) => {
    const { method, path, purpose, keyParams, exampleBodyFrom } = ep.value;
    const masked = ep.value.exampleBody !== undefined ? maskCredentialFields(ep.value.exampleBody) : { body: undefined, fields: [] as string[] };
    const exampleBody = masked.body;
    const target = endpointTarget(path, baseUrl);
    const host = target.kind === "absolute" ? target.origin : "{{baseUrl}}";
    const requiredQuery = keyParams.filter((p) => p.in === "query" && p.required).map((p) => `${p.name}={${p.name}}`);
    const query = [...requiredQuery, ...auth.query];
    const url = `${host}${target.path}${query.length ? `${target.path.includes("?") ? "&" : "?"}${query.join("&")}` : ""}`;

    const lines = [`curl -X ${method} ${sq(url)}`];
    for (const h of auth.headers) lines.push(`  -H ${sq(h)}`);
    for (const p of keyParams.filter((k) => k.in === "header" && k.required)) lines.push(`  -H ${sq(`${p.name}: {${p.name}}`)}`);
    for (const x of auth.extra) lines.push(`  ${x}`);
    if (exampleBody !== undefined) {
      let json = false;
      try {
        JSON.parse(exampleBody);
        json = true;
      } catch {
        // Not JSON (e.g. form data): sent as-is.
      }
      if (json) lines.push(`  -H ${sq("Content-Type: application/json")}`);
      lines.push(`  --data ${sq(exampleBody)}`);
    }
    const curl = (auth.note ? [`# ${auth.note}`] : []).concat(lines.map((l, i) => (i < lines.length - 1 ? `${l} \\` : l))).join("\n");
    const placeholders = [...new Set([...`${target.path} ${requiredQuery.join(" ")}`.matchAll(/\{([^{}]+)\}/g)].map((m) => m[1]!))];
    for (const p of keyParams.filter((k) => k.in === "header" && k.required)) if (!placeholders.includes(p.name)) placeholders.push(p.name);
    return {
      title: `${method} ${path}`,
      purpose,
      curl,
      ...(exampleBody !== undefined && exampleBodyFrom ? { bodyFrom: exampleBodyFrom } : {}),
      placeholders,
      maskedFields: masked.fields,
    };
  }));
}
