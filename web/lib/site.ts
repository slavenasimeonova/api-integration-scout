/**
 * Build-time switches, inlined by Next (see next.config.ts).
 * STATIC_DEMO: the public static export, with live runs turned off.
 * BASE_PATH: where the site is served, e.g. "/api-integration-scout" on GitHub Pages.
 * REQUEST_API: the request-mode API origin (Netlify), or "" when request mode is off.
 */
export const STATIC_DEMO = process.env.NEXT_PUBLIC_STATIC_DEMO === "1";
export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
export const REQUEST_API = process.env.NEXT_PUBLIC_REQUEST_API ?? "";

/** Same limit as src/core/goal.ts (the worker and the request API enforce it; web/ can't import it). */
export const MAX_GOAL_CHARS = 300;

/** A file in public/, with the base path. next/link adds it by itself; fetch() does not. */
export const assetUrl = (path: string) => `${BASE_PATH}${path}`;
