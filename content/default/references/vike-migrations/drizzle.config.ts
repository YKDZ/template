import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import databaseManifest from "@ykdz/reference-vike-db/package.json" with { type: "json" };
import { databaseStorageTarget } from "@ykdz/reference-vike-db/storage";
import { defineConfig } from "drizzle-kit";

const schemaFile = fileURLToPath(
  import.meta.resolve(`${databaseManifest.name}/schema`),
);
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
