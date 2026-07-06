import { describe, expect, it } from "vitest";

import { createDatabase } from "#/database/db";
import { createTodo, listTodos } from "#/database/queries/todos";

describe("todo queries", () => {
  it("creates and lists todos through Drizzle SQLite", async () => {
    const db = createDatabase(":memory:");

    db.run(
      "CREATE TABLE todos (id integer PRIMARY KEY AUTOINCREMENT NOT NULL, title text NOT NULL, completed integer DEFAULT false NOT NULL, created_at text DEFAULT (CURRENT_TIMESTAMP) NOT NULL)",
    );

    await expect(createTodo(db, { title: "Ship" })).resolves.toMatchObject({
      id: 1,
      title: "Ship",
    });
    await expect(listTodos(db)).resolves.toMatchObject([{ title: "Ship" }]);
  });
});
