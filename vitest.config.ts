import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const repoRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    conditions: ["source"],
  },
  ssr: {
    noExternal: [
      "@ykdz/template-builtin-source",
      "@ykdz/template-core",
      "@ykdz/template-shared",
      /^@ykdz\/template-builtin-source\//,
      /^@ykdz\/template-core\//,
    ],
    resolve: {
      conditions: ["source"],
    },
  },
  test: {
    env: {
      NODE_OPTIONS: [process.env.NODE_OPTIONS, "--conditions=source"]
        .filter(Boolean)
        .join(" "),
      TSX_TSCONFIG_PATH: path.join(repoRoot, "tsconfig.json"),
    },
    include: [
      "test/**/*.test.ts",
      "packages/builtin-source/templates/*/behavior.test.ts",
    ],
    exclude: [
      "**/node_modules/**",
      "templates/**",
      "node_modules/**",
      "dist/**",
    ],
    globals: true,
    testTimeout: 60_000,
  },
});
