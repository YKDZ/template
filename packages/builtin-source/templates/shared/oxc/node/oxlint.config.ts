import { defineConfig } from "oxlint";

export default defineConfig({
  categories: {
    correctness: "error",
    suspicious: "error",
  },
  plugins: ["typescript", "oxc"],
  rules: {
    "no-unused-vars": "error",
  },
});
