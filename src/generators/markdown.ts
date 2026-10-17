import type { Analysis, Auth, Finding, PageVisit, Severity } from "../core/schema.js";
import { authLabel } from "../core/verify.js";
import type { z } from "zod";
import { STATUS_LABEL, usableEndpoints } from "./format.js";
import { buildExampleRequests } from "./requests.js";

type Sev = z.infer<typeof Severity>;
const SEVERITY_ORDER: Record<Sev, number> = { high: 0, medium: 1, low: 2 };

function cell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
}

function sourcesInline(f: Finding<unknown>): string {
  if (!f.sources.length) return "—";
  return f.sources.map((s) => `[${new URL(s.url).pathname || "/"}](${s.url})`).join(", ");
}

function evidence(f: Finding<unknown>): string[] {
  const out = [`**Status:** ${STATUS_LABEL[f.status]}`];
  for (const s of f.sources) {
    out.push(s.quote ? `> "${s.quote.replace(/\n/g, " ")}"\n> — [${s.url}](${s.url})` : `Source: [${s.url}](${s.url})`);
  }
  if (f.reasoning) out.push(`_Reasoning:_ ${f.reasoning}`);
  return out;
}

function describeAuth(v: Auth): string[] {
  return [
    `- Type: ${v.type}`,
    ...(v.location ? [`- Location: ${v.location}`] : []),
    ...(v.parameterName ? [`- Parameter: \`${v.parameterName}\``] : []),
    `- ${v.description}`,
  ];
}

function section(title: string, f: Finding<unknown>, describe: () => string[]): string[] {
  const body = f.status === "not_found" || f.value === null ? ["Not found in docs."] : describe();
  return [`### ${title}`, "", ...body, "", ...evidence(f), ""];
}

/** How much of a long page the agent read. Older analyses have no part counts. */
function partsNote(p: PageVisit): string {
  if (p.parts && p.parts > 1) {
    return p.truncated ? ` (read ${p.partsRead ?? 0} of ${p.parts} parts; findings may be incomplete)` : ` (read in ${p.parts} parts)`;
  }
  return p.truncated ? " (truncated; findings may be incomplete)" : "";
}

const DIRECTION_LABEL = { app_to_api: "Your app → API", api_to_app: "API → your app", api_to_webhook: "API → your webhook" } as const;

/** Goal mode: the integration's steps in order, each with its evidence status. */
function flowSection(a: Analysis): string[] {
  const steps = (a.flow ?? []).filter((s) => s.status !== "not_found" && s.value);
  if (!steps.length) return [];
  return [
    "## Integration flow",
    "",
    ...steps.map((s, i) => {
      const v = s.value!;
      return `${i + 1}. **${cell(v.action)}** (${DIRECTION_LABEL[v.direction]}${v.endpoint ? `, \`${cell(v.endpoint)}\`` : ""}). ${STATUS_LABEL[s.status]}${s.sources.length ? `: ${sourcesInline(s)}` : ""}`;
    }),
    "",
    "The diagram is in `sequence.mmd`.",
    "",
  ];
}

/** Servers the docs list. Postman's baseUrl is left for the user to choose when there are several. */
function environmentsSection(a: Analysis): string[] {
  const envs = (a.environments ?? []).filter((e) => e.status !== "not_found" && e.value);
  if (!envs.length) return [];
  return [
    "## Environments",
    "",
    "The docs list these servers. Pick one yourself; the Postman `baseUrl` variable lists them as options.",
    "",
    "| Name | Base URL | Status | Source |",
    "| --- | --- | --- | --- |",
    ...envs.map((e) => `| ${cell(e.value!.name)} | \`${cell(e.value!.url)}\` | ${STATUS_LABEL[e.status]} | ${sourcesInline(e)} |`),
    "",
  ];
}

/** Goal mode: one curl command per endpoint, with {{variables}} for the base URL and credentials. */
function exampleRequestsSection(a: Analysis): string[] {
  const requests = buildExampleRequests(a);
  if (!requests.length) return [];
  return [
    "## Example requests",
    "",
    "Built from the analysis. `{{baseUrl}}` and `{{apiKey}}` are the same variables as in the Postman collection; fill them in yourself. Bodies appear only when the docs show one. Commands are for bash; in PowerShell, run `curl.exe` and adjust the quoting.",
    "",
    ...requests.flatMap((r) => [
      `### ${cell(r.title)}`,
      "",
      r.purpose,
      ...(r.placeholders.length ? ["", `Replace: ${r.placeholders.map((p) => `\`{${p}}\``).join(", ")}.`] : []),
      ...(r.bodyFrom === "converted" ? ["", "The body is the docs' example rewritten as JSON (in a different order or form); every key and value was checked against the page."] : []),
      ...(r.maskedFields.length ? ["", `Credential fields replaced by variables: ${r.maskedFields.map((f) => `\`{{${f}}}\``).join(", ")}.`] : []),
      "",
      "```bash",
      r.curl,
      "```",
      "",
    ]),
  ];
}

const READ_LABEL ={ read: "read", partly: "partly read", failed: "failed", not_read: "not read" } as const;

/** Goal mode: which pages were considered, how they scored, and why they were (not) read. */
function discoverySection(a: Analysis): string[] {
  const d = a.discovery;
  if (!d) return [];
  const sitemap = d.sitemap
    ? `Sitemap: ${d.sitemap.urls} pages listed, ${d.sitemap.matches} match the goal's keywords.`
    : "No sitemap was used (none found, or the docs are on GitHub); pages were ranked from the links on each page read.";
  const terms = d.terms.map((t) => `\`${t}\``).join(", ") || "none";
  return [
    "## Pages considered for the goal",
    "",
    `Goal keywords: ${terms}. ${sitemap}`,
    "Score: 2 per keyword in the link text, 1 per keyword only in the URL path, 1 for authentication pages. Scores are keyword hints; the reasons are the agent's.",
    "",
    "| Page | Score | Matched | Read | Relevant | Reason |",
    "| --- | --- | --- | --- | --- | --- |",
    ...d.pages.map((p) => {
      const relevant = p.relevant === undefined ? "—" : p.relevant ? "yes" : "no";
      return `| ${cell(p.url)} | ${p.score} | ${cell(p.matched.join(", ") || "—")} | ${READ_LABEL[p.read]} | ${relevant} | ${cell(p.reason ?? "—")} |`;
    }),
    "",
  ];
}

/** Human-readable integration summary (analysis.md). */
export function buildMarkdown(a: Analysis): string {
  const endpoints = usableEndpoints(a);
  const glance: [string, Finding<unknown>, string][] = [
    ["Base URL", a.baseUrl, a.baseUrl.value ?? ""],
    [
      "Authentication",
      a.auth,
      a.auth.value
        ? `${a.auth.value.type}: ${a.auth.value.description}${a.authAlternatives.length ? ` (+${a.authAlternatives.length} documented alternative${a.authAlternatives.length > 1 ? "s" : ""})` : ""}`
        : "",
    ],
    ["Pagination", a.pagination, a.pagination.value ? `${a.pagination.value.style}: ${a.pagination.value.description}` : ""],
    ["Rate limits", a.rateLimits, a.rateLimits.value?.limits ?? ""],
    ["Webhooks", a.webhooks, a.webhooks.value ? (a.webhooks.value.supported ? `Yes: ${a.webhooks.value.events.join(", ")}` : "Not supported") : ""],
    ["Error format", a.errorFormat, a.errorFormat.value?.description ?? ""],
    ["Versioning", a.versioning, a.versioning.value ? `${a.versioning.value.scheme}${a.versioning.value.current ? ` (${a.versioning.value.current})` : ""}` : ""],
  ];

  const risks = [...a.risks].sort((x, y) => SEVERITY_ORDER[x.severity] - SEVERITY_ORDER[y.severity]);
  const r = a.run;

  const lines = [
    `# ${a.apiName}: integration analysis`,
    "",
    `> Generated by API Integration Scout from <${a.docsUrl}> on ${a.generatedAt}.`,
    `> Every finding is marked **Documented** (quoted from the docs and verified), **Inferred** (the agent's reasoning) or **Not found in docs**.`,
    "",
    ...(a.goal ? [`**Goal:** ${a.goal}`, "", "This analysis covers only what the goal needs.", ""] : []),
    a.summary,
    "",
    "## At a glance",
    "",
    "| Area | Finding | Status | Source |",
    "| --- | --- | --- | --- |",
    ...glance.map(([area, f, v]) => `| ${area} | ${cell(f.status === "not_found" ? "—" : v)} | ${STATUS_LABEL[f.status]} | ${sourcesInline(f)} |`),
    `| Endpoints | ${endpoints.length} found | ${endpoints.filter((e) => e.status === "documented").length} documented, ${endpoints.filter((e) => e.status === "inferred").length} inferred | — |`,
    "",
    ...flowSection(a),
    ...environmentsSection(a),
    ...(a.goal ? exampleRequestsSection(a) : []),
    "## Risks",
    "",
    ...(risks.length
      ? risks.map((x) => `- **${x.severity.toUpperCase()}**: ${x.title}. ${x.detail}${x.origin !== "agent" ? ` _(${x.origin} check)_` : ""}`)
      : ["No risks identified."]),
    "",
    "## Open questions",
    "",
    ...(a.openQuestions.length ? a.openQuestions.map((q) => `- ${q}`) : ["None."]),
    "",
    "## Details",
    "",
    ...section("Base URL", a.baseUrl, () => [`\`${a.baseUrl.value}\``]),
    ...section("Authentication (primary)", a.auth, () => describeAuth(a.auth.value!)),
    ...(a.authAlternatives.length
      ? [
          "### Authentication alternatives",
          "",
          "Other methods the docs state. Each has a sample request in the Postman \"Auth alternatives\" folder.",
          "",
          ...a.authAlternatives.flatMap((alt, i) => [
            `#### ${i + 1}. ${alt.value ? authLabel(alt.value) : "Unnamed method"}`,
            "",
            ...(alt.value ? describeAuth(alt.value) : []),
            "",
            ...evidence(alt),
            "",
          ]),
        ]
      : []),
    "### Endpoints",
    "",
    ...(endpoints.length
      ? [
          "| Method | Path | Purpose | Key params | Status | Source |",
          "| --- | --- | --- | --- | --- | --- |",
          ...endpoints.map((e) => {
            const params = e.value.keyParams.map((p) => `\`${p.name}\` (${p.in}${p.required ? ", required" : ""})`).join(", ") || "—";
            const hostNote =
              e.hostCheck?.status === "ambiguous"
                ? ` **(host unclear: ${e.hostCheck.candidates.join(", ")})**`
                : e.hostCheck?.status === "corrected"
                  ? " (host from the docs' example URL)"
                  : "";
            return `| ${e.value.method} | \`${cell(e.value.path)}\`${cell(hostNote)} | ${cell(e.value.purpose)} | ${cell(params)} | ${STATUS_LABEL[e.status]} | ${sourcesInline(e)} |`;
          }),
        ]
      : ["Not found in docs."]),
    "",
    ...section("Pagination", a.pagination, () => {
      const v = a.pagination.value!;
      return [`- Style: ${v.style}`, `- Parameters: ${v.parameters.map((p) => `\`${p}\``).join(", ") || "—"}`, `- ${v.description}`];
    }),
    ...section("Rate limits", a.rateLimits, () => {
      const v = a.rateLimits.value!;
      return [`- Limits: ${v.limits}`, `- Headers: ${v.headers.map((h) => `\`${h}\``).join(", ") || "—"}`, `- ${v.description}`];
    }),
    ...section("Webhooks", a.webhooks, () => {
      const v = a.webhooks.value!;
      return [
        `- Supported: ${v.supported ? "yes" : "no"}`,
        `- Events: ${v.events.map((e) => `\`${e}\``).join(", ") || "—"}`,
        `- Signature verification: ${v.signatureVerification ?? "not described"}`,
        `- ${v.description}`,
        ...(v.payloadFields?.length
          ? [
              "",
              "Payload fields:",
              "",
              "| Field | Type | Description |",
              "| --- | --- | --- |",
              ...v.payloadFields.slice(0, 25).map((p) => `| \`${cell(p.name)}\` | ${cell(p.type ?? "—")} | ${cell(p.description)} |`),
            ]
          : []),
        ...(v.examplePayload ? ["", "Example payload (from the docs):", "", "```", v.examplePayload, "```"] : []),
      ];
    }),
    ...section("Error format", a.errorFormat, () => {
      const v = a.errorFormat.value!;
      return [v.description, ...(v.example ? ["", "```json", v.example, "```"] : [])];
    }),
    ...section("Versioning", a.versioning, () => {
      const v = a.versioning.value!;
      return [`- Scheme: ${v.scheme}`, ...(v.current ? [`- Current: ${v.current}`] : []), `- ${v.description}`];
    }),
    ...discoverySection(a),
    "## Pages visited",
    "",
    ...a.pagesVisited.map((p) => `- ${p.url}: ${p.status === "fetched" ? `${p.textLength} chars${p.lowText ? " (low text, may need JavaScript)" : ""}${partsNote(p)}` : `failed (${p.error})`}`),
    "",
    ...(a.warnings.length ? ["## Warnings", "", ...a.warnings.map((w) => `- ${w}`), ""] : []),
    "## Run",
    "",
    `- Model: ${r.model}`,
    `- Turns: ${r.numTurns}, duration ${(r.durationMs / 1000).toFixed(1)}s`,
    `- Tokens: ${r.inputTokens} input, ${r.outputTokens} output, ${r.cacheCreationInputTokens} cache write, ${r.cacheReadInputTokens} cache read (${r.totalTokens} total)`,
    `- Estimated cost: $${r.costUsd.toFixed(4)}`,
    "",
  ];
  return lines.join("\n");
}
