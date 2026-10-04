import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// oxfmt-ignore
import { databaseStorageTarget } from "{{DB_PACKAGE_NAME}}/storage";
import { defineConfig } from "drizzle-kit";

// oxfmt-ignore
const schemaFile = fileURLToPath(import.meta.resolve("{{DB_PACKAGE_NAME}}/schema"));
const databaseFile = databaseStorageTarget();
mkdirSync(path.dirname(databaseFile), { recursive: true });

export default defineConfig({
  dialect: "sqlite",
  schema: schemaFile,
  out: "./drizzle/migrations",
  dbCredentials: {
    url: databaseFile,
  },
});
