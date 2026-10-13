import { defineConfig } from "oxlint";

import config from "./oxlint.config.ts";

export default defineConfig({
  ...config,
  options: {
    ...config.options,
    typeAware: false,
  },
});
