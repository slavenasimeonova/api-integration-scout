import { getStore } from "@netlify/blobs";
import { createInterface } from "node:readline/promises";
import { blobsKv, interviewKey, REQUEST_STORE, type InterviewRecord, type KvStore, type ScoutRequest } from "../src/access/index.js";
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
    ...(r.goal ? [`  Goal:    ${r.goal}${r.interviewId ? " (written with the goal assistant)" : ""}`] : []),
    `  Time:    ${utc(r.createdAt)}`,
    `  Status:  ${r.status}${r.updatedAt ? ` (${utc(r.updatedAt)})` : ""}${r.note ? `: ${r.note}` : ""}`,
  ].join("\n");
}

/**
 * The interview behind a request's goal, as text (ASCII labels; the visitor's
 * words as typed). Transcripts are deleted after 14 days.
 */
export async function describeInterview(store: KvStore, r: ScoutRequest): Promise<string | undefined> {
  if (!r.interviewId) return undefined;
  const interview = await store.getJSON<InterviewRecord>(interviewKey(r.interviewId));
  if (!interview) return `Interview ${r.interviewId}: transcript deleted (kept 14 days)`;
  return [
    `Interview ${interview.id} (${utc(interview.createdAt)}, ${interview.tokens} tokens, deleted after ${utc(interview.expiresAt)})`,
    ...interview.turns.map((t) => `  ${t.role === "assistant" ? "Assistant" : "Visitor  "}: ${t.text.replace(/\s+/g, " ")}`),
    ...(interview.goal !== undefined ? [`  Proposed goal: ${interview.goal || "(none; the visitor wrote it)"}`] : []),
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
