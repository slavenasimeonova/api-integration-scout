import type { NextConfig } from "next";

// Local development: /api/* is proxied to the worker (npm run worker in the repo root).
const workerUrl = process.env.WORKER_URL ?? "http://127.0.0.1:8787";

// Public demo: a static export with the examples only (npm run build:static).
const staticDemo = process.env.STATIC_DEMO === "1";
const basePath = staticDemo ? (process.env.PAGES_BASE_PATH ?? "").replace(/\/+$/, "") : "";
// Request mode API (Netlify Function, see docs/requests.md). Unset = no access-code panel.
const requestApi = staticDemo ? (process.env.REQUEST_API_URL ?? "").replace(/\/+$/, "") : "";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The app only imports types from ../src; keep Next's root at web/.
  turbopack: { root: import.meta.dirname },
  outputFileTracingRoot: import.meta.dirname,
  env: { NEXT_PUBLIC_STATIC_DEMO: staticDemo ? "1" : "", NEXT_PUBLIC_BASE_PATH: basePath, NEXT_PUBLIC_REQUEST_API: requestApi },
  ...(staticDemo
    ? { output: "export", basePath, trailingSlash: true, images: { unoptimized: true } }
    : {
        async rewrites() {
          return [{ source: "/api/:path*", destination: `${workerUrl}/api/:path*` }];
        },
      }),
};

export default nextConfig;
