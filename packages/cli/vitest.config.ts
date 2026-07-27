import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    conditions: ["source"],
  },
  ssr: {
    resolve: {
      conditions: ["source"],
    },
    noExternal: [
      "@ykdz/template-builtin-presets",
      "@ykdz/template-core",
      /^@ykdz\/template-builtin-presets\//,
      /^@ykdz\/template-core\//,
    ],
  },
  test: {
    include: ["test/**/*.test.ts"],
  },
});
