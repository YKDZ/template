import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "drizzle-kit";

const databasePackageName = process.env.DATABASE_PACKAGE_NAME ?? "@database";
const schemaFile = fileURLToPath(
  import.meta.resolve(`${databasePackageName}/schema`),
);
const databaseFile = process.env.DATABASE_FILE ?? "./data/app.sqlite";
mkdirSync(path.dirname(databaseFile), { recursive: true });

export default defineConfig({
  dialect: "sqlite",
  schema: schemaFile,
  out: "./drizzle/migrations",
  dbCredentials: {
    url: databaseFile,
  },
});
