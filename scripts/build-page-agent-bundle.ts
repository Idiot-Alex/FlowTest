import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const outputPath = path.join(
  repositoryRoot,
  "packages/page-agent-adapter/dist/page-agent.iife.js",
);

await build({
  entryPoints: [
    path.join(
      repositoryRoot,
      "packages/page-agent-adapter/src/browser-entry.ts",
    ),
  ],
  outfile: outputPath,
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  sourcemap: true,
  logLevel: "info",
});
