import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiBaseUrl =
    process.env.VITE_API_BASE_URL ?? env.VITE_API_BASE_URL ?? "http://localhost:3000";

  return {
    plugins: [vue(), tailwindcss()],
    resolve: {
      alias: {
        "@": fileURLToPath(new URL("./src", import.meta.url)),
      },
    },
    server: {
      proxy: {
        "/api": apiBaseUrl,
      },
    },
    preview: {
      proxy: {
        "/api": apiBaseUrl,
      },
    },
  };
});
