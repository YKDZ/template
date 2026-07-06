import { getContext } from "telefunc";

import { createTodo, listTodos } from "#/database/queries/todos";

export async function onLoadTodos() {
  const { db } = getContext();
  return listTodos(db);
}

export async function onAddTodo(title: string) {
  const { db } = getContext();
  return createTodo(db, { title });
}
