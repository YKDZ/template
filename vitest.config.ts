import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const repoRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@ykdz\/template-core\/(.+)$/,
        replacement: path.join(repoRoot, "packages/core/src/$1.ts"),
      },
      {
        find: /^@ykdz\/template-builtin-source\/registry$/,
        replacement: path.join(
          repoRoot,
          "packages/builtin-source/templates/registry.ts",
        ),
      },
      {
        find: /^@ykdz\/template-builtin-source\/projection-plans$/,
        replacement: path.join(
          repoRoot,
          "packages/builtin-source/templates/projection-plans.ts",
        ),
      },
      {
        find: /^@ykdz\/template-builtin-source\/templates\/(.+)$/,
        replacement: path.join(
          repoRoot,
          "packages/builtin-source/templates/$1.ts",
        ),
      },
      {
        find: "@ykdz/template-builtin-source",
        replacement: path.join(
          repoRoot,
          "packages/builtin-source/src/index.ts",
        ),
      },
      {
        find: /^@ykdz\/template-checks\/(.+)$/,
        replacement: path.join(repoRoot, "packages/checks/src/$1.ts"),
      },
      {
        find: "@ykdz/template-shared",
        replacement: path.join(repoRoot, "packages/shared/src/index.ts"),
      },
    ],
  },
  test: {
    env: {
      TSX_TSCONFIG_PATH: path.join(repoRoot, "tsconfig.json"),
    },
    exclude: [
      "**/node_modules/**",
      "packages/builtin-source/templates/**",
      "templates/**",
      "node_modules/**",
      "dist/**",
    ],
    globals: true,
    testTimeout: 60_000,
  },
});
