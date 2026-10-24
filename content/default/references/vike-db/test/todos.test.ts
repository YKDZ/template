import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createDatabase } from "#db/db";
import { createTodo, listTodos } from "#db/queries/todos";
import { assertDatabaseReady } from "#db/readiness";

void describe("todo queries", () => {
  void it("creates and lists todos through Drizzle SQLite", async () => {
    const db = createDatabase();
    assertDatabaseReady(db);
    const title = `发布模板 ${Date.now()}`;

    assert.equal((await createTodo(db, { title })).title, title);
    assert.ok((await listTodos(db)).some((todo) => todo.title === title));
    assert.ok(
      (await db.query.todos.findMany()).some((todo) => todo.title === title),
    );
  });
});
