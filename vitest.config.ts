import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["templates/**", "node_modules/**", "dist/**"],
    globals: true,
    testTimeout: 60_000
  }
});
