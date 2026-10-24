import { eq } from "drizzle-orm";

import type { Database } from "#db/db";
import { todos } from "#db/schema";

const exampleTodos = [
  "Read the generated TODO.md",
  "Try the Telefunc todo flow",
] as const;

export async function seedExampleData(db: Database) {
  for (const title of exampleTodos) {
    const existing = await db
      .select({ id: todos.id })
      .from(todos)
      .where(eq(todos.title, title))
      .limit(1);

    if (existing.length === 0) {
      await db.insert(todos).values({ title });
    }
  }
}
