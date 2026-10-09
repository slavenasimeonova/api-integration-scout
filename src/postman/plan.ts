import { ACCESS_VARIABLE, CHECK_HOST_FLAG } from "../generators/postman.js";

/**
 * Decides which requests of a Postman collection may be sent automatically.
 * Safe by default: only GET runs. Writes (POST, PUT, PATCH, DELETE, ...) need
 * an explicit allowWrites. Requests that can't be sent correctly as generated
 * (empty path variable or required query value, unclear host) are skipped too.
 */

export type PlannedRequest = {
  /** Item name as in the collection, e.g. "GET /lite/{ip}". */
  name: string;
  folder: string;
  method: string;
  run: boolean;
  reason?: string;
  /** Plan or permission the docs say this endpoint needs (from the analysis). */
  requires?: string;
  /** Named with --expect-fail. */
  expectFail?: boolean;
};

type Variable = { key?: string; value?: unknown; disabled?: boolean };
type Url = { raw?: string; path?: string[]; variable?: Variable[]; query?: Variable[] } | string;
type CollectionItem = { name?: string; item?: CollectionItem[]; variable?: Variable[]; request?: { method?: string; url?: Url } & Record<string, unknown> } & Record<string, unknown>;
export type Collection = { info?: { name?: string }; item?: CollectionItem[] } & Record<string, unknown>;


const isEmpty = (v: unknown) => v === undefined || v === null || String(v).trim() === "";

function skipReason(item: CollectionItem, allowWrites: boolean): string | undefined {
  const method = (item.request?.method ?? "GET").toUpperCase();
  if (method !== "GET" && !allowWrites) return `${method} request; pass --allow-writes to send it`;
  if (item.name?.startsWith(CHECK_HOST_FLAG)) return "host is unclear in the docs; check it first";
  const url = item.request?.url;
  if (url && typeof url === "object") {
    const pathVar = url.variable?.find((v) => isEmpty(v.value));
    if (pathVar) return `no value for path variable :${pathVar.key}`;
    // A ":name" path segment with no variable at all would be sent literally.
    const segments = Array.isArray(url.path) ? url.path : [];
    const unfilled = segments.find((seg) => /^:/.test(seg) && !url.variable?.some((v) => v.key === seg.slice(1)));
    if (unfilled) return `no value for path variable ${unfilled}`;
    const query = url.query?.find((q) => !q.disabled && isEmpty(q.value));
    if (query) return `no value for required query parameter ${query.key}`;
  }
  return undefined;
}

/** Returns the plan for every request and a copy of the collection with only the runnable ones. */
export function planCollection(
  collection: Collection,
  opts: { allowWrites: boolean; expectFail?: string[] },
): { plan: PlannedRequest[]; runnable: Collection; unmatchedExpectFail: string[] } {
  const plan: PlannedRequest[] = [];
  const expectFail = new Set((opts.expectFail ?? []).map((n) => n.trim()));
  const matched = new Set<string>();

  const walk = (items: CollectionItem[], folder: string): CollectionItem[] =>
    items.flatMap((item): CollectionItem[] => {
      if (Array.isArray(item.item)) {
        const children = walk(item.item, folder ? `${folder}/${item.name ?? ""}` : (item.name ?? ""));
        return children.length ? [{ ...item, item: children }] : [];
      }
      if (!item.request) return [];
      const reason = skipReason(item, opts.allowWrites);
      const name = item.name ?? "(unnamed)";
      const requires = item.variable?.find((v) => v.key === ACCESS_VARIABLE && !isEmpty(v.value))?.value;
      if (expectFail.has(name)) matched.add(name);
      plan.push({
        name,
        folder,
        method: (item.request.method ?? "GET").toUpperCase(),
        run: !reason,
        ...(reason ? { reason } : {}),
        ...(requires !== undefined ? { requires: String(requires) } : {}),
        ...(expectFail.has(name) ? { expectFail: true } : {}),
      });
      return reason ? [] : [item];
    });

  const runnable = { ...collection, item: walk(collection.item ?? [], "") };
  return { plan, runnable, unmatchedExpectFail: [...expectFail].filter((n) => !matched.has(n)) };
}
