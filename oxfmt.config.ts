import formatterConfiguration from "@ykdz/reference-tooling-config/oxfmt";
import { defineConfig } from "oxfmt";

export default defineConfig({
  ...formatterConfiguration,
  sortImports: true,
});
