import { getStore } from "@netlify/blobs";
import { createInterface } from "node:readline/promises";
import { blobsKv, REQUEST_STORE, type KvStore, type ScoutRequest } from "../src/access/index.js";
import type { Analysis, ProgressEvent } from "../src/core/index.js";
import { buildOutputs } from "../src/generators/index.js";

/** Shared by request:list and request:fulfil. Reads Netlify Blobs from your machine. */

export const PUBLIC_SITE = (process.env.PUBLIC_SITE_URL ?? "https://slavenasimeonova.github.io/api-integration-scout").replace(/\/+$/, "");

export function openRequestStore(env: NodeJS.ProcessEnv = process.env): KvStore {
  const siteID = env.NETLIFY_SITE_ID?.trim();
  const token = env.NETLIFY_AUTH_TOKEN?.trim();
  if (!siteID || !token) {
    throw new Error("Set NETLIFY_SITE_ID and NETLIFY_AUTH_TOKEN in .env to read requests (see docs/requests.md).");
  }
  return blobsKv(getStore({ name: REQUEST_STORE, siteID, token, consistency: "strong" }));
}

/** "2026-10-13 10:00 UTC" */
export const utc = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

export function describeRequest(r: ScoutRequest): string {
  return [
    `Request ${r.id}`,
    `  Code:    ${r.codeName}`,
    `  URL:     ${r.url}`,
    ...(r.goal ? [`  Goal:    ${r.goal}`] : []),
    `  Time:    ${utc(r.createdAt)}`,
    `  Status:  ${r.status}${r.updatedAt ? ` (${utc(r.updatedAt)})` : ""}${r.note ? `: ${r.note}` : ""}`,
  ].join("\n");
}

export const resultLink = (id: string) => `${PUBLIC_SITE}/results/?id=${id}`;

/**
 * The published result: the same shape as a saved example, so the site
 * replays it with the same components. It carries no code name.
 */
export function resultBundle(analysis: Analysis, events: ProgressEvent[]) {
  const { slug, files, postmanValidation } = buildOutputs(analysis);
  return { analysis, events, slug, files, postmanErrors: postmanValidation.errors };
}

/** Asks a yes/no question; anything but y/yes (or no terminal) is no. */
export async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
  } finally {
    rl.close();
  }
}
