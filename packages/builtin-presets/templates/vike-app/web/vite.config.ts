import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import telefunc from "telefunc/vite";
import vike from "vike/plugin";
import { defineConfig, type PluginOption } from "vite";

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- telefunc/vite currently types its plugin factory as any.
const telefuncPlugin = telefunc() as PluginOption;

export default defineConfig({
  plugins: [vike(), telefuncPlugin, vue(), tailwindcss()],
});
