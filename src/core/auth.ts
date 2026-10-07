import type { AnalysisEndpoint } from "./hosts.js";
import type { Auth, Finding } from "./schema.js";
import { authLabel } from "./verify.js";

/**
 * Deterministic auth rules applied after verification (the model's choice of
 * "primary" isn't reliable; in one real run it picked the token-in-query
 * method while its own risks said to prefer the header):
 * 1. The primary method is the best-ranked documented one:
 *    header (Bearer, custom header) > HTTP Basic > query parameter > cookie.
 * 2. Endpoint params that carry a documented credential (e.g. ?token=) are
 *    removed from endpoints; the auth method already covers them.
 */

type AuthFinding = Finding<Auth>;

/** Lower is preferred. */
export function authRank(auth: Auth): number {
  if (auth.type === "basic") return 1;
  if (auth.location === "query") return 2;
  if (auth.location === "cookie") return 3;
  if (auth.location === "header") return 0;
  // Bearer / OAuth tokens go in the Authorization header even when no location is given.
  if (auth.type === "bearer" || auth.type === "oauth2") return 0;
  return 4;
}

/** "query:token", "header:authorization": where each documented credential travels. */
export function credentialParamKeys(methods: Auth[]): Set<string> {
  const keys = new Set<string>();
  for (const value of methods) {
    if (value.type === "api_key" && value.parameterName) {
      const where = value.location === "query" ? "query" : value.location === "cookie" ? "cookie" : "header";
      keys.add(`${where}:${value.parameterName.toLowerCase()}`);
    }
    if (value.type === "bearer" || value.type === "basic" || value.type === "oauth2") keys.add("header:authorization");
  }
  return keys;
}

export type AuthNormalization<E extends AnalysisEndpoint> = {
  auth: AuthFinding;
  authAlternatives: AuthFinding[];
  endpoints: E[];
  /** Set when the primary method was changed by rule 1. */
  primaryChange?: { from: string; to: string };
  /** Credential params removed from endpoints, e.g. "query:token". */
  removedCredentialParams: string[];
};

const isDocumented = (f: AuthFinding): f is AuthFinding & { value: Auth } => f.status === "documented" && f.value !== null;

export function normalizeAuth<E extends AnalysisEndpoint>(input: {
  auth: AuthFinding;
  authAlternatives: AuthFinding[];
  endpoints: E[];
}): AuthNormalization<E> {
  // Stable sort: equal ranks keep the docs' order.
  const byRank = (list: (AuthFinding & { value: Auth })[]) => [...list].sort((a, b) => authRank(a.value) - authRank(b.value));

  let auth = input.auth;
  let authAlternatives = input.authAlternatives;
  let primaryChange: AuthNormalization<E>["primaryChange"];
  if (isDocumented(input.auth)) {
    const ranked = byRank([input.auth, ...input.authAlternatives.filter(isDocumented)]);
    auth = ranked[0]!;
    authAlternatives = [...ranked.slice(1), ...input.authAlternatives.filter((f) => !isDocumented(f))];
    if (auth !== input.auth) primaryChange = { from: authLabel(input.auth.value), to: authLabel(auth.value!) };
  } else {
    // An inferred primary stays as found; the generators use the best documented alternative.
    authAlternatives = [...byRank(input.authAlternatives.filter(isDocumented)), ...input.authAlternatives.filter((f) => !isDocumented(f))];
  }

  const keys = credentialParamKeys([auth, ...authAlternatives].filter(isDocumented).map((f) => f.value));
  const removed = new Set<string>();
  const endpoints = input.endpoints.map((ep) => {
    if (!ep.value) return ep;
    const keyParams = ep.value.keyParams.filter((p) => {
      const key = `${p.in}:${p.name.toLowerCase()}`;
      if (!keys.has(key)) return true;
      removed.add(key);
      return false;
    });
    return keyParams.length === ep.value.keyParams.length ? ep : { ...ep, value: { ...ep.value, keyParams } };
  });

  return { auth, authAlternatives, endpoints, primaryChange, removedCredentialParams: [...removed].sort() };
}

export function primaryChangeDetail(change: { from: string; to: string }): string {
  return `Primary auth set to ${change.to} instead of ${change.from} (rule: header > Basic > query parameter)`;
}
