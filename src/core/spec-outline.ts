/**
 * Outline of an OpenAPI/Swagger spec, built in code from the raw text (no YAML
 * parser). Long specs are read in parts, and the endpoints usually sit far past
 * the first part (UPS Track Alert: 11k characters of prose before `paths`), so
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
