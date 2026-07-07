import vikeVue from "vike-vue/config";
import type { Config } from "vike/types";

const config: Config = {
  title: "Vike 应用",
  description: "使用 Vike、Hono、Telefunc、Drizzle 和 Vue 的示例应用。",
  extends: [vikeVue],
};

export default config;
