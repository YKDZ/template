import { sql } from "drizzle-orm";

import type { Database } from "#db/db";
import { todos } from "#db/schema";

export function assertDatabaseReady(db: Database) {
  try {
    db.select({ ready: sql`1` })
      .from(todos)
      .limit(1)
      .all();
  } catch (cause) {
    throw new Error(
      [
        "Database is not ready.",
        "For local development, run `pnpm --dir packages/db-migrations run db:prepare:dev`.",
        "For deployment, run `pnpm --dir packages/db-migrations run db:prepare:deploy` before starting the app.",
      ].join(" "),
      { cause },
    );
  }
}
