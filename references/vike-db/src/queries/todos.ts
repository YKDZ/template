import { desc, eq } from "drizzle-orm";

import type { Database } from "#db/db";
import { todos, type NewTodo } from "#db/schema";

const listTodosStatements = new WeakMap<
  Database,
  ReturnType<typeof prepareListTodos>
>();

export async function listTodos(db: Database) {
  let statement = listTodosStatements.get(db);

  if (!statement) {
    statement = prepareListTodos(db);
    listTodosStatements.set(db, statement);
  }

  return statement.all();
}

export async function createTodo(db: Database, values: NewTodo) {
  const [todo] = await db.insert(todos).values(values).returning();

  if (!todo) throw new Error("Failed to create todo");

  return todo;
}

export async function completeTodo(db: Database, id: number) {
  const [todo] = await db
    .update(todos)
    .set({ completed: true })
    .where(eq(todos.id, id))
    .returning();

  if (!todo) throw new Error(`Todo ${id} was not found`);

  return todo;
}

function prepareListTodos(db: Database) {
  return db.select().from(todos).orderBy(desc(todos.createdAt)).prepare();
}
