import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const repositoryRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@flowtest/assertion-kit": path.join(
        repositoryRoot,
        "packages/assertion-kit/src/index.ts",
      ),
      "@flowtest/config-schema": path.join(
        repositoryRoot,
        "packages/config-schema/src/index.ts",
      ),
      "@flowtest/page-agent-adapter": path.join(
        repositoryRoot,
        "packages/page-agent-adapter/src/index.ts",
      ),
      "@flowtest/playwright-adapter": path.join(
        repositoryRoot,
        "packages/playwright-adapter/src/index.ts",
      ),
      "@flowtest/reporters": path.join(
        repositoryRoot,
        "packages/reporters/src/index.ts",
      ),
      "@flowtest/runner-core": path.join(
        repositoryRoot,
        "packages/runner-core/src/index.ts",
      ),
    },
  },
  test: {
    testTimeout: 60_000,
    hookTimeout: 60_000,
    exclude: ["**/dist/**", "**/node_modules/**"],
  },
});
