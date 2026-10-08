import { normalizeAuth, primaryChangeDetail } from "./auth.js";
import type { PendingEvent } from "./events.js";
import { checkEndpointHosts, type AnalysisEndpoint } from "./hosts.js";
import type { Analysis, Auth, Endpoint, Finding, Risk } from "./schema.js";

/**
 * The deterministic rules applied after quote verification, in one place so
 * every caller gets the same result: runScout for live runs, and the scripts
 * that regenerate saved examples offline. (A separate offline copy once
 * skipped the host check and sent IPinfo's /{ip}/json to the wrong host.)
 *
 * 1. Endpoint hosts are checked against full URLs in verified quotes (hosts.ts).
 * 2. Primary auth and credential params follow fixed rules (auth.ts).
 *
 * Each change comes back as a notice: the progress event, the warning and,
 * where needed, the risk. Applying the rules twice changes nothing.
 */

export type RuleNotice = { event: PendingEvent; warning: string; risk?: Risk };

export type RuleInput = {
  baseUrl: Finding<string>;
  auth: Finding<Auth>;
  authAlternatives: Finding<Auth>[];
  endpoints: (Finding<Endpoint> | AnalysisEndpoint)[];
};

export type RuleOutput = {
  auth: Finding<Auth>;
  authAlternatives: Finding<Auth>[];
  endpoints: AnalysisEndpoint[];
  notices: RuleNotice[];
};

export function applyCodeRules(input: RuleInput): RuleOutput {
  const notices: RuleNotice[] = [];

  const endpoints = checkEndpointHosts(input.endpoints, input.baseUrl.status !== "not_found" ? input.baseUrl.value : null).map(
    (ep, i) => {
      // An endpoint corrected in an earlier pass keeps its record; it isn't re-announced.
      const earlier = (input.endpoints[i] as AnalysisEndpoint).hostCheck;
      return earlier && !ep.hostCheck ? { ...ep, hostCheck: earlier } : ep;
    },
  );
  endpoints.forEach((ep, i) => {
    const check = ep.hostCheck;
    if (!check || !ep.value || (input.endpoints[i] as AnalysisEndpoint).hostCheck) return;
    const name = `${ep.value.method} ${check.status === "corrected" ? check.from : ep.value.path}`;
    if (check.status === "corrected") {
      const detail = `${name}: host corrected to ${check.to} from the docs' example URL`;
      notices.push({
        event: { step: "endpoint_host_corrected", detail, endpoint: name, from: check.from, to: check.to },
        warning: `Endpoint ${detail} ("${check.evidence}")`,
      });
    } else {
      const detail = `${name}: host is ambiguous (docs show ${check.candidates.join(", ")})`;
      notices.push({
        event: { step: "endpoint_host_ambiguous", detail, endpoint: name, candidates: check.candidates },
        warning: `Endpoint ${detail}; the Postman request is flagged [CHECK HOST]`,
        risk: {
          severity: "medium",
          title: `Unclear host for ${name}`,
          detail: `The docs show this endpoint on more than one host (${check.candidates.join(", ")}). Confirm which host to call.`,
          origin: "verification",
        },
      });
    }
  });

  const normalized = normalizeAuth({ auth: input.auth, authAlternatives: input.authAlternatives, endpoints });
  if (normalized.primaryChange) {
    const detail = primaryChangeDetail(normalized.primaryChange);
    notices.push({ event: { step: "auth_primary_changed", detail, ...normalized.primaryChange }, warning: detail });
  }

  return { auth: normalized.auth, authAlternatives: normalized.authAlternatives, endpoints: normalized.endpoints, notices };
}

/**
 * Re-applies the rules to a saved analysis (offline, no model call): used to
 * regenerate examples recorded before a rule existed. Warnings and risks from
 * the notices are added once.
 */
export function applyCodeRulesToAnalysis(analysis: Analysis): { analysis: Analysis; notices: RuleNotice[] } {
  const ruled = applyCodeRules(analysis);
  const warnings = [...analysis.warnings];
  const risks = [...analysis.risks];
  for (const n of ruled.notices) {
    if (!warnings.includes(n.warning)) warnings.push(n.warning);
    if (n.risk && !risks.some((r) => r.title === n.risk!.title)) risks.push(n.risk);
  }
  return {
    analysis: { ...analysis, auth: ruled.auth, authAlternatives: ruled.authAlternatives, endpoints: ruled.endpoints, warnings, risks },
    notices: ruled.notices,
  };
}
