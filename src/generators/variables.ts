import type { Analysis, Auth } from "../core/schema.js";
import { baseUrlOf, documentedAuthMethods } from "./format.js";

/**
 * Variables shared by the Postman collection, its environment and the curl
 * examples. Credentials are always empty variables; public values (a single
 * documented base URL or token URL) are prefilled only when there is exactly
 * one documented choice, so Scout never picks an environment for the user.
 */

export type Variable = {
  key: string;
  /** Prefilled value (public URLs only), or "" for the user to fill in. */
  value: string;
  secret: boolean;
  /** Shown in Postman; empty for the obvious ones (a single base URL, a plain API key). */
  description: string;
};

export type EnvironmentOption = { name: string; url: string; status: string };

/** Body fields whose values are credentials; they become {{variables}} instead of doc examples. */
const CREDENTIAL_FIELD = /^(credential|credentials|password|passwd|secret|client_?secret|api_?key|access_?token|refresh_?token|token|auth_?token)$/i;

/** `{version}` in a server URL becomes a Postman variable `{{version}}`. */
export function serverUrlForPostman(url: string): { url: string; vars: string[] } {
  const vars: string[] = [];
  const out = url.replace(/(?<!\{)\{([A-Za-z_][\w-]*)\}(?!\})/g, (_, name: string) => {
    if (!vars.includes(name)) vars.push(name);
    return `{{${name}}}`;
  });
  return { url: out, vars };
}

/** The environments the docs list, de-duplicated by URL. Two or more mean the user must choose. */
export function environmentOptions(analysis: Pick<Analysis, "environments">): EnvironmentOption[] {
  const seen = new Set<string>();
  const out: EnvironmentOption[] = [];
  for (const e of analysis.environments ?? []) {
    if (e.status === "not_found" || !e.value) continue;
    const key = e.value.url.trim().replace(/\/+$/, "").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name: e.value.name, url: e.value.url.trim(), status: e.status });
  }
  return out;
}

/** The documented OAuth 2.0 client-credentials method, if Postman's token helper can be set up for it. */
export function clientCredentialsAuth(analysis: Pick<Analysis, "auth" | "authAlternatives">): (Auth & { tokenUrl: string }) | null {
  const primary = documentedAuthMethods(analysis)[0]?.value;
  if (primary?.type === "oauth2" && primary.grantType === "client_credentials" && primary.tokenUrl) {
    return primary as Auth & { tokenUrl: string };
  }
  return null;
}

/**
 * Replaces credential-like fields in a JSON body (e.g. "credential": "secret")
 * with {{variables}}, so a doc's placeholder secret is never sent as if real.
 * Non-JSON bodies are returned unchanged.
 */
export function maskCredentialFields(body: string): { body: string; fields: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { body, fields: [] };
  }
  const fields: string[] = [];
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v).map(([k, child]) => {
          if (typeof child === "string" && CREDENTIAL_FIELD.test(k)) {
            if (!fields.includes(k)) fields.push(k);
            return [k, `{{${k}}}`];
          }
          return [k, walk(child)];
        }),
      );
    }
    return v;
  };
  const masked = walk(parsed);
  return fields.length ? { body: JSON.stringify(masked, null, 2), fields } : { body, fields };
}

/**
 * The body for the webhook test request: the docs' example payload with
 * credential fields as variables, only if it is valid JSON. Docs often
 * abbreviate examples ("...": GitHub's issues payload), and sending that to a
 * receiver would only test its JSON parser.
 */
export function webhookTestPayload(analysis: Pick<Analysis, "webhooks">): { body: string; fields: string[] } | null {
  const hooks = analysis.webhooks.status !== "not_found" ? analysis.webhooks.value : null;
  if (!hooks?.examplePayload) return null;
  const masked = maskCredentialFields(hooks.examplePayload);
  try {
    JSON.parse(masked.body);
    return masked;
  } catch {
    return null;
  }
}

/** Every variable the collection uses, in a stable order. */
export function collectionVariables(analysis: Analysis): Variable[] {
  const vars: Variable[] = [];
  const add = (v: Variable) => {
    if (!vars.some((x) => x.key === v.key)) vars.push(v);
  };
  const options = environmentOptions(analysis);
  const serverVars: string[] = [];

  if (options.length > 1) {
    const list = options.map((o) => `${o.name}: ${serverUrlForPostman(o.url).url}`);
    for (const o of options) serverVars.push(...serverUrlForPostman(o.url).vars);
    add({
      key: "baseUrl",
      value: "",
      secret: false,
      description: `The docs list ${options.length} environments; choose one and paste its URL here. Options: ${list.join(" | ")}`,
    });
  } else {
    const single = options[0]?.url ?? baseUrlOf(analysis);
    const server = single ? serverUrlForPostman(single) : null;
    if (server) serverVars.push(...server.vars);
    add({ key: "baseUrl", value: server?.url ?? "", secret: false, description: "" });
  }
  for (const name of serverVars) {
    add({ key: name, value: "", secret: false, description: `Server variable in the base URL ({${name}}); see the docs for its value` });
  }

  const oauth = clientCredentialsAuth(analysis);
  if (oauth) {
    const token = serverUrlForPostman(oauth.tokenUrl);
    add({
      key: "tokenUrl",
      value: options.length > 1 ? "" : token.url,
      secret: false,
      description:
        options.length > 1
          ? `OAuth token URL. The docs state ${oauth.tokenUrl}; it may differ per environment, so check before using it.`
          : "OAuth token URL from the docs",
    });
    for (const name of token.vars) add({ key: name, value: "", secret: false, description: `Variable in the token URL ({${name}})` });
    add({ key: "clientId", value: "", secret: true, description: "Your OAuth client ID" });
    add({ key: "clientSecret", value: "", secret: true, description: "Your OAuth client secret" });
  }
  add({ key: "apiKey", value: "", secret: true, description: oauth ? "Not needed with the OAuth helper; used only by auth alternatives" : "" });

  for (const ep of analysis.endpoints) {
    if (!ep.value?.exampleBody) continue;
    for (const field of maskCredentialFields(ep.value.exampleBody).fields) {
      add({ key: field, value: "", secret: true, description: `Credential field in a request body ("${field}"); the docs' example value is not used` });
    }
  }
  if (webhookTestPayload(analysis)) {
    add({ key: "webhookUrl", value: "", secret: false, description: "Your own webhook endpoint, for the webhook test request" });
  }
  return vars;
}
