import { getStore } from "@netlify/blobs";
import { blobsKv, pruneInterviews, REQUEST_STORE } from "../../src/access/index.js";

/** Scheduled daily: deletes interview transcripts older than 14 days (the panel promises this). */
export default async (): Promise<Response> => {
  const deleted = await pruneInterviews(blobsKv(getStore({ name: REQUEST_STORE, consistency: "strong" })));
  console.log(`[prune-interviews] deleted ${deleted} transcript(s)`);
  return new Response(null, { status: 204 });
};

export const config = { schedule: "@daily" };
