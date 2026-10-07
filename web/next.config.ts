import type { NextConfig } from "next";

// Local development: /api/* is proxied to the worker (npm run worker in the repo root).
const workerUrl = process.env.WORKER_URL ?? "http://127.0.0.1:8787";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The app only imports types from ../src; keep Next's root at web/.
  turbopack: { root: import.meta.dirname },
  outputFileTracingRoot: import.meta.dirname,
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${workerUrl}/api/:path*` }];
  },
};

export default nextConfig;
