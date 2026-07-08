import { getContext } from "telefunc";

// @template-anchor db-package-import

export type Todo = Awaited<ReturnType<typeof onLoadTodos>>[number];

export async function onLoadTodos() {
  const { db } = getContext();
  return listTodos(db);
}

export async function onAddTodo(title: string) {
  const { db } = getContext();
  return createTodo(db, { title });
}
