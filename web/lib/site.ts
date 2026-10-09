/**
 * Build-time switches, inlined by Next (see next.config.ts).
 * STATIC_DEMO: the public static export, with live runs turned off.
 * BASE_PATH: where the site is served, e.g. "/api-integration-scout" on GitHub Pages.
 */
export const STATIC_DEMO = process.env.NEXT_PUBLIC_STATIC_DEMO === "1";
export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

/** A file in public/, with the base path. next/link adds it by itself; fetch() does not. */
export const assetUrl = (path: string) => `${BASE_PATH}${path}`;
