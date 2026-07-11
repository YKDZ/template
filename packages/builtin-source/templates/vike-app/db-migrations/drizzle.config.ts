import { fileURLToPath } from "node:url";

import { defineConfig } from "drizzle-kit";

const schemaFile = fileURLToPath(
  new URL("../db/src/schema.ts", import.meta.url),
);
const migrationsDirectory = fileURLToPath(
  new URL("./drizzle/migrations", import.meta.url),
);

export default defineConfig({
  dialect: "sqlite",
  schema: schemaFile,
  out: migrationsDirectory,
  dbCredentials: {
    url: process.env.DATABASE_FILE ?? "./data/app.sqlite",
  },
});
