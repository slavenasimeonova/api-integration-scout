// Serves out/ locally to check the static demo before deploying. No dependencies.
// Usage: node scripts/serve-static.mjs [--base /api-integration-scout] [--port 4173]
import { createReadStream, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { base: { type: "string", default: "" }, port: { type: "string", default: "4173" } } });
const base = values.base.replace(/\/+$/, "");
const root = path.resolve(import.meta.dirname, "..", "out");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8" };

function resolveFile(urlPath) {
  const file = path.resolve(root, "." + decodeURIComponent(urlPath));
  if (file !== root && !file.startsWith(root + path.sep)) return undefined;
  for (const candidate of [file, path.join(file, "index.html")]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  return undefined;
}

http
  .createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (base && pathname === "/") return res.writeHead(302, { location: `${base}/` }).end();
    const inside = !base || pathname === base || pathname.startsWith(`${base}/`);
    const file = inside ? resolveFile(pathname.slice(base.length) || "/") : undefined;
    const target = file ?? resolveFile("/404.html");
    res.writeHead(file ? 200 : 404, { "content-type": TYPES[path.extname(target ?? "")] ?? "application/octet-stream" });
    if (target) createReadStream(target).pipe(res);
    else res.end("Not found. Run npm run build:static first.");
  })
  .listen(Number(values.port), "127.0.0.1", () => console.log(`Static demo: http://127.0.0.1:${values.port}${base}/`));
