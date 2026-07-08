import { describe, expect, it } from "vitest";

import { createDatabase } from "#db/db";
import { createTodo, listTodos } from "#db/queries/todos";

describe("todo queries", () => {
  it("creates and lists todos through Drizzle SQLite", async () => {
    const db = createDatabase();
    const title = `发布模板 ${Date.now()}`;

    await expect(createTodo(db, { title })).resolves.toMatchObject({
      title,
    });
    await expect(listTodos(db)).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ title })]),
    );
  });
});
