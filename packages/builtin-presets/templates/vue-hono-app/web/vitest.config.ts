import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [vue()],
  test: {
    exclude: ["test/e2e/**", "node_modules/**", "dist/**"],
    globals: true,
  },
});
