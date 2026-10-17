import databaseManifest from "@ykdz/reference-vike-db/package.json" with { type: "json" };
import vueConfig from "@ykdz/reference-vue-shared/vite";
import telefunc from "telefunc/vite";
import vike from "vike/plugin";
import { defineConfig, type PluginOption } from "vite";

// telefunc/vite 暂未为插件工厂提供精确类型。
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const telefuncPlugin = telefunc() as PluginOption;

export default defineConfig({
  ...vueConfig,
  plugins: [vike(), telefuncPlugin, ...(vueConfig.plugins ?? [])],
  resolve: { conditions: ["source"] },
  ssr: { external: [databaseManifest.name] },
});
