import { mkdirSync } from "node:fs";
import path from "node:path";

import { drizzle } from "drizzle-orm/node-sqlite";

import * as schema from "#db/schema";

export type Database = ReturnType<typeof createDatabase>;

export function createDatabase(databaseFile = process.env.DATABASE_FILE) {
  const file = databaseFile ?? "./data/app.sqlite";
  mkdirSync(path.dirname(file), { recursive: true });
  return drizzle(file, { schema });
}
