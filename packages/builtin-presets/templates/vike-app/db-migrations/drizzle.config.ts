import { fileURLToPath } from "node:url";

import { defineConfig } from "drizzle-kit";

const databasePackageName = process.env.DATABASE_PACKAGE_NAME ?? "@database";
const schemaFile = fileURLToPath(
  import.meta.resolve(`${databasePackageName}/schema`),
);

export default defineConfig({
  dialect: "sqlite",
  schema: schemaFile,
  out: "./drizzle/migrations",
  dbCredentials: {
    url: process.env.DATABASE_FILE ?? "./data/app.sqlite",
  },
});
