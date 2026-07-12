import { defineConfig } from "oxlint";

export default defineConfig({
  options: { typeAware: true },
  categories: { correctness: "error", suspicious: "warn" },
});
