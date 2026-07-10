import { defineConfig } from "vitest/config";

process.env.TEMPLATE_REPOSITORY_ROOT ??= process.cwd();

export default defineConfig({
  ssr: {
    noExternal: [
      "@ykdz/template-builtin-source",
      "@ykdz/template-core",
      "@ykdz/template-shared",
      /^@ykdz\/template-builtin-source\//,
      /^@ykdz\/template-core\//,
    ],
  },
  test: {
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
