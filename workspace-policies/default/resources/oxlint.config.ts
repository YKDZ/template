import lintConfiguration from "@ykdz/reference-tooling-config/oxlint";
import { defineConfig } from "oxlint";

export default defineConfig({
  extends: [lintConfiguration],
  categories: { correctness: "error", suspicious: "warn" },
});
