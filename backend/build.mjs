import { build } from "esbuild";
import { rm, utimes } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const backendDirectory = dirname(fileURLToPath(import.meta.url));
const outputDirectory = resolve(backendDirectory, "dist");
const outputFiles = ["index.mjs", "ingest.mjs", "schedule.mjs", "fleet-registration-hook.mjs"].map((name) => resolve(outputDirectory, name));

await rm(outputDirectory, { recursive: true, force: true });
await build({
  entryPoints: {
    index: "src/lambda.ts",
    ingest: "src/ingest-lambda.ts",
    schedule: "src/schedule-lambda.ts",
    "fleet-registration-hook": "src/fleet-registration-hook.ts",
  },
  outdir: "dist",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  minify: false,
  sourcemap: false,
  legalComments: "none",
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
});
const reproducibleTimestamp = new Date("1980-01-01T00:00:00.000Z");
await Promise.all(outputFiles.map((file) => utimes(file, reproducibleTimestamp, reproducibleTimestamp)));
console.log("built dist/index.mjs, dist/ingest.mjs, dist/schedule.mjs, dist/fleet-registration-hook.mjs");
