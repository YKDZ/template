import { mkdirSync } from "node:fs";
import path from "node:path";

import { drizzle } from "drizzle-orm/node-sqlite";
import { defineRelations } from "drizzle-orm/relations";

import * as schema from "#db/schema";

const relations = defineRelations(schema);
const defaultDatabaseFile = "./data/app.sqlite";

export type Database = ReturnType<typeof createDatabase>;

export function createDatabase(databaseFile = process.env.DATABASE_FILE) {
  const file = databaseFile ?? defaultDatabaseFile;
  mkdirSync(path.dirname(file), { recursive: true });
  return drizzle(file, { relations });
}
