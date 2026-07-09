import { describe, expect, it } from "vitest";

import { createDatabase } from "#db/db";
import { createTodo, listTodos } from "#db/queries/todos";
import { assertDatabaseReady } from "#db/readiness";

describe("todo queries", () => {
  it("creates and lists todos through Drizzle SQLite", async () => {
    const db = createDatabase();
    assertDatabaseReady(db);
    const title = `发布模板 ${Date.now()}`;

    await expect(createTodo(db, { title })).resolves.toMatchObject({
      title,
    });
    await expect(listTodos(db)).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ title })]),
    );
    await expect(db.query.todos.findMany()).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ title })]),
    );
  });
});
