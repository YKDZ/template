import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import telefunc from "telefunc/vite";
import vike from "vike/plugin";
import { defineConfig, type PluginOption } from "vite";

const webRoot = path.dirname(fileURLToPath(import.meta.url));
const migrationsRoot = path.resolve(webRoot, "../../packages/db-migrations");
const databaseRoot = path.resolve(webRoot, "../../packages/db");
const databaseFile = path.join(webRoot, "data/app.sqlite");

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- telefunc/vite currently types its plugin factory as any.
const telefuncPlugin = telefunc() as PluginOption;

async function prepareDatabase(): Promise<void> {
  const env = { ...process.env, DATABASE_FILE: databaseFile };
  process.env.DATABASE_FILE = databaseFile;
  execFileSync("pnpm", ["run", "db:push"], {
    cwd: migrationsRoot,
    env,
    stdio: "inherit",
  });
  execFileSync("pnpm", ["run", "db:seed:example"], {
    cwd: databaseRoot,
    env,
    stdio: "inherit",
  });
}

function databasePreparationPlugin(): PluginOption {
  return {
    name: "database-preparation",
    configureServer: () => prepareDatabase(),
    configurePreviewServer: () => prepareDatabase(),
  };
}

export default defineConfig({
  plugins: [
    vike(),
    telefuncPlugin,
    vue(),
    tailwindcss(),
    databasePreparationPlugin(),
  ],
});
