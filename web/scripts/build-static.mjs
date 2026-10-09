// Builds the public static demo into out/. Works the same in PowerShell, Command Prompt and CI.
// Optional: PAGES_BASE_PATH=/api-integration-scout to serve from a subfolder (GitHub Pages).
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const next = createRequire(import.meta.url).resolve("next/dist/bin/next");
const { status } = spawnSync(process.execPath, [next, "build"], {
  stdio: "inherit",
  env: { ...process.env, STATIC_DEMO: "1" },
});
process.exit(status ?? 1);
