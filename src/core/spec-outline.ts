/**
 * Outline of an OpenAPI/Swagger spec, built in code from the raw text (no YAML
 * parser). Long specs are read in parts, and the endpoints usually sit far past
 * the first part (one real spec had 11k characters of prose before `paths`), so
 * the agent gets a map of where each path, webhook and schema is.
 */

export type OutlineItem = {
  section: "server" | "path" | "webhook" | "security" | "schema";
  /** e.g. "POST /subscription/{type}/package: Create subscriptions", or a schema name. */
  label: string;
  /** Character offset in the page text, used to name the part that holds it. */
  offset: number;
};

const METHODS = new Set(["get", "put", "post", "delete", "patch", "head", "options", "trace"]);
const MAX_SCHEMAS = 80;
const MAX_LABEL = 100;

/** Most sections listed for a long HTML page; the rest are summarized as a count. */
const MAX_SECTION_CHARS = 6000;

export type Section = { level: 1 | 2 | 3; text: string; offset: number };

/**
 * Where each heading of a long HTML page starts in its extracted text (every
 * heading is its own line there), so the agent can jump to the right part,
 * e.g. the "issues" event on GitHub's 141k-character events page.
 */
export function sectionOffsets(text: string, headings: { level: 1 | 2 | 3; text: string }[]): Section[] {
  const out: Section[] = [];
  let cursor = 0;
  for (const h of headings) {
    let at = text.indexOf(h.text, cursor);
    // A heading must start a line; skip mentions inside paragraphs.
    while (at > 0 && text[at - 1] !== "\n") at = text.indexOf(h.text, at + 1);
    if (at < 0) continue;
    out.push({ ...h, offset: at });
    cursor = at + h.text.length;
  }
  return out;
}

/**
 * The section map: every h1/h2, plus h3s that match the goal (a page can have
 * hundreds). Goal matches are marked with *. Each section names the parts it
 * spans ("parts 5-6"), up to the next heading of the same or a higher level or
 * `textLength`, so the agent knows when a section continues past one part.
 * Capped at MAX_SECTION_CHARS.
 */
export function formatSections(
  sections: Section[],
  partOf: (offset: number) => number,
  matches: (text: string) => boolean,
  textLength: number,
): string {
  const lines: string[] = [];
  let size = 0;
  let left = 0;
  sections.forEach((s, i) => {
    const hit = matches(s.text);
    if (s.level === 3 && !hit) return;
    const end = sections.slice(i + 1).find((n) => n.level <= s.level)?.offset ?? textLength;
    const [first, last] = [partOf(s.offset), partOf(Math.max(s.offset, end - 1))];
    const parts = last > first ? `parts ${first}-${last}` : `part ${first}`;
    const line = `- ${hit ? "* " : ""}${s.level === 3 ? "  " : ""}${s.text} (${parts})`;
    if (size + line.length > MAX_SECTION_CHARS) {
      left++;
      return;
    }
    lines.push(line);
    size += line.length + 1;
  });
  if (left) lines.push(`- ... and ${left} more sections`);
  return lines.join("\n");
}

/** Returns the outline, or null when the text isn't an OpenAPI/Swagger document. */
export function specOutline(text: string): OutlineItem[] | null {
  const body = text.replace(/^﻿/, "");
  if (/^\s*\{/.test(body)) return jsonOutline(body);
  if (/^(?:\s*(?:#.*|---)?\n)*\s*(?:openapi|swagger)\s*:\s*['"]?\d/.test(body)) return yamlOutline(body);
  return null;
}

/** Formats the outline for the model, naming the part that holds each item. */
export function formatOutline(items: OutlineItem[], partOf: (offset: number) => number): string {
  const lines: string[] = [];
  const schemas = items.filter((i) => i.section === "schema");
  const groups: [OutlineItem["section"], string][] = [
    ["server", "Servers"],
    ["security", "Security schemes"],
    ["path", "Paths"],
    ["webhook", "Webhooks"],
  ];
  for (const [section, heading] of groups) {
    const group = items.filter((i) => i.section === section);
    if (!group.length) continue;
    lines.push(`${heading}:`, ...group.map((i) => `- ${i.label} (part ${partOf(i.offset)})`));
  }
  if (schemas.length) {
    const shown = schemas.slice(0, MAX_SCHEMAS).map((i) => `${i.label} (part ${partOf(i.offset)})`);
    const more = schemas.length > MAX_SCHEMAS ? `, and ${schemas.length - MAX_SCHEMAS} more` : "";
    lines.push(`Schemas (${schemas.length}): ${shown.join(", ")}${more}`);
  }
  return lines.join("\n");
}

type Line = { indent: number; key: string | null; rest: string; raw: string; offset: number };

function yamlLines(text: string): Line[] {
  const lines: Line[] = [];
  let offset = 0;
  for (const raw of text.split("\n")) {
    const trimmed = raw.trim();
    if (trimmed && !trimmed.startsWith("#")) {
      const indent = raw.length - raw.trimStart().length;
      const m = /^(['"]?)([^'"]+?)\1\s*:(?:\s+(.*))?$/.exec(trimmed);
      lines.push({ indent, key: m && !trimmed.startsWith("- ") ? m[2]! : null, rest: m?.[3]?.trim() ?? "", raw: trimmed, offset });
    }
    offset += raw.length + 1;
  }
  return lines;
}

/** Lines strictly inside the block that starts at index `start` (deeper indentation). */
function block(lines: Line[], start: number): Line[] {
  const own = lines[start]!.indent;
  const out: Line[] = [];
  for (let i = start + 1; i < lines.length && lines[i]!.indent > own; i++) out.push(lines[i]!);
  return out;
}

/** Keys of the direct children of a block (the shallowest indentation in it). */
function childKeys(inner: Line[]): Line[] {
  const depth = Math.min(...inner.filter((l) => l.key).map((l) => l.indent));
  return inner.filter((l) => l.key && l.indent === depth);
}

function clean(s: string): string {
  const v = s.replace(/^['"]|['"]$/g, "").replace(/\s+/g, " ").trim();
  return v.length > MAX_LABEL ? `${v.slice(0, MAX_LABEL - 3)}...` : v;
}

function yamlOutline(text: string): OutlineItem[] {
  const lines = yamlLines(text);
  const items: OutlineItem[] = [];
  const top = (key: string) => lines.findIndex((l) => l.indent === 0 && l.key === key);

  const servers = top("servers");
  if (servers >= 0) {
    for (const l of block(lines, servers)) {
      const m = /^-?\s*url:\s*(\S+)/.exec(l.raw);
      if (m) items.push({ section: "server", label: clean(m[1]!), offset: l.offset });
    }
  }

  for (const [key, section] of [["paths", "path"], ["webhooks", "webhook"], ["x-webhooks", "webhook"]] as const) {
    const at = top(key);
    if (at < 0) continue;
    const inner = block(lines, at);
    for (const entry of childKeys(inner)) {
      const idx = lines.indexOf(entry);
      const ops = block(lines, idx);
      for (const op of ops.length ? childKeys(ops) : []) {
        if (!METHODS.has(op.key!.toLowerCase())) continue;
        const summary = block(lines, lines.indexOf(op)).find((l) => l.key === "summary" && l.rest);
        const label = `${op.key!.toUpperCase()} ${entry.key}${summary ? `: ${clean(summary.rest)}` : ""}`;
        items.push({ section, label: clean(label), offset: op.offset });
      }
    }
  }

  const components = top("components");
  if (components >= 0) {
    const inner = block(lines, components);
    for (const sub of inner.length ? childKeys(inner) : []) {
      const section = sub.key === "securitySchemes" ? "security" : sub.key === "schemas" ? "schema" : null;
      if (!section) continue;
      const children = block(lines, lines.indexOf(sub));
      for (const c of children.length ? childKeys(children) : []) items.push({ section, label: clean(c.key!), offset: c.offset });
    }
  }
  // Swagger 2: schemas under `definitions`, security under `securityDefinitions`.
  for (const [key, section] of [["definitions", "schema"], ["securityDefinitions", "security"]] as const) {
    const at = top(key);
    const inner = at >= 0 ? block(lines, at) : [];
    for (const c of inner.length ? childKeys(inner) : []) items.push({ section, label: clean(c.key!), offset: c.offset });
  }
  return items;
}

function jsonOutline(text: string): OutlineItem[] | null {
  let spec: Record<string, unknown>;
  try {
    spec = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!spec || typeof spec !== "object" || !("openapi" in spec || "swagger" in spec)) return null;

  const items: OutlineItem[] = [];
  const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
  // Offsets: the first occurrence of the quoted key after its parent's position.
  const find = (key: string, from: number) => {
    const at = text.indexOf(JSON.stringify(key), from);
    return at < 0 ? from : at;
  };

  if (Array.isArray(spec.servers)) {
    let from = find("servers", 0);
    for (const s of spec.servers) {
      const url = obj(s).url;
      if (typeof url !== "string") continue;
      from = find(url, from);
      items.push({ section: "server", label: clean(url), offset: from });
    }
  }
  for (const [key, section] of [["paths", "path"], ["webhooks", "webhook"], ["x-webhooks", "webhook"]] as const) {
    if (!(key in spec)) continue;
    let from = find(key, 0);
    for (const [path, ops] of Object.entries(obj(spec[key]))) {
      from = find(path, from);
      for (const [method, op] of Object.entries(obj(ops))) {
        if (!METHODS.has(method.toLowerCase())) continue;
        const summary = obj(op).summary;
        const label = `${method.toUpperCase()} ${path}${typeof summary === "string" && summary ? `: ${summary}` : ""}`;
        items.push({ section, label: clean(label), offset: find(method, from) });
      }
    }
  }
  const components = obj(spec.components);
  for (const [group, section, parent] of [
    [components.securitySchemes, "security", "securitySchemes"],
    [components.schemas, "schema", "schemas"],
    [spec.securityDefinitions, "security", "securityDefinitions"],
    [spec.definitions, "schema", "definitions"],
  ] as const) {
    let from = find(parent, 0);
    for (const name of Object.keys(obj(group))) {
      from = find(name, from);
      items.push({ section, label: clean(name), offset: from });
    }
  }
  return items;
}
