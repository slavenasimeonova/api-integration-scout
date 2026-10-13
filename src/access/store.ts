/**
 * Minimal key-value store for requests and counters. Netlify Blobs in
 * production (netlify/functions, scripts), MemoryKv in tests; a file or Redis
 * store can implement it for a container later.
 */
/** The Netlify Blobs store holding requests, counters and throttle entries. */
export const REQUEST_STORE = "scout-requests";

export type KvStore = {
  getJSON<T>(key: string): Promise<T | undefined>;
  setJSON(key: string, value: unknown): Promise<void>;
  /** Keys starting with prefix. */
  list(prefix: string): Promise<string[]>;
};

export class MemoryKv implements KvStore {
  readonly data = new Map<string, string>();
  async getJSON<T>(key: string): Promise<T | undefined> {
    const raw = this.data.get(key);
    return raw === undefined ? undefined : (JSON.parse(raw) as T);
  }
  async setJSON(key: string, value: unknown): Promise<void> {
    this.data.set(key, JSON.stringify(value));
  }
  async list(prefix: string): Promise<string[]> {
    return [...this.data.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
}

/** The subset of @netlify/blobs' Store used here (structural, so this file has no dependency). */
type BlobStore = {
  get(key: string, options: { type: "json" }): Promise<unknown>;
  setJSON(key: string, value: unknown): Promise<unknown>;
  list(options: { prefix: string }): Promise<{ blobs: { key: string }[] }>;
};

export function blobsKv(store: BlobStore): KvStore {
  return {
    async getJSON<T>(key: string) {
      return ((await store.get(key, { type: "json" })) ?? undefined) as T | undefined;
    },
    async setJSON(key, value) {
      await store.setJSON(key, value);
    },
    async list(prefix) {
      return (await store.list({ prefix })).blobs.map((b) => b.key).sort();
    },
  };
}
