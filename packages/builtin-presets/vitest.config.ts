import { defineConfig } from "vitest/config";

export default defineConfig({
  ssr: {
    noExternal: [
      "@ykdz/template-builtin-presets",
      "@ykdz/template-core",
      "@ykdz/template-shared",
      /^@ykdz\/template-builtin-presets\//,
      /^@ykdz\/template-core\//,
    ],
  },
  test: {
    include: ["src/*/behavior.test.ts"],
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
