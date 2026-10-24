import databaseManifest from "@ykdz/reference-vike-db/package.json" with { type: "json" };
import telefunc from "telefunc/vite";
import vike from "vike/plugin";
import { defineConfig, type PluginOption } from "vite";

import vueConfig from "./tooling/vite.ts";

// telefunc/vite 暂未为插件工厂提供精确类型。
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const telefuncPlugin = telefunc() as PluginOption;

export default defineConfig({
  plugins: [vike(), telefuncPlugin, ...(vueConfig.plugins ?? [])],
  resolve: { conditions: ["source"] },
  ssr: { external: [databaseManifest.name] },
});
