import { CHECK_HOST_FLAG } from "../generators/postman.js";

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
};

type Variable = { key?: string; value?: unknown; disabled?: boolean };
type Url = { raw?: string; variable?: Variable[]; query?: Variable[] } | string;
type CollectionItem = { name?: string; item?: CollectionItem[]; request?: { method?: string; url?: Url } & Record<string, unknown> } & Record<string, unknown>;
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
    const query = url.query?.find((q) => !q.disabled && isEmpty(q.value));
    if (query) return `no value for required query parameter ${query.key}`;
  }
  return undefined;
}

/** Returns the plan for every request and a copy of the collection with only the runnable ones. */
export function planCollection(collection: Collection, opts: { allowWrites: boolean }): { plan: PlannedRequest[]; runnable: Collection } {
  const plan: PlannedRequest[] = [];

  const walk = (items: CollectionItem[], folder: string): CollectionItem[] =>
    items.flatMap((item): CollectionItem[] => {
      if (Array.isArray(item.item)) {
        const children = walk(item.item, folder ? `${folder}/${item.name ?? ""}` : (item.name ?? ""));
        return children.length ? [{ ...item, item: children }] : [];
      }
      if (!item.request) return [];
      const reason = skipReason(item, opts.allowWrites);
      plan.push({
        name: item.name ?? "(unnamed)",
        folder,
        method: (item.request.method ?? "GET").toUpperCase(),
        run: !reason,
        ...(reason ? { reason } : {}),
      });
      return reason ? [] : [item];
    });

  const runnable = { ...collection, item: walk(collection.item ?? [], "") };
  return { plan, runnable };
}
