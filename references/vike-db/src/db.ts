import { mkdirSync } from "node:fs";
import path from "node:path";

import { drizzle } from "drizzle-orm/node-sqlite";
import { defineRelations } from "drizzle-orm/relations";

import * as schema from "#db/schema";
import { databaseStorageTarget } from "#db/storage";

const relations = defineRelations(schema);
export type Database = ReturnType<typeof createDatabase>;

export function createDatabase(databaseFile = databaseStorageTarget()) {
  const file = databaseFile;
  mkdirSync(path.dirname(file), { recursive: true });
  return drizzle(file, { relations });
}
