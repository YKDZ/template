// @template-anchor db-package-import
import { getContext } from "telefunc";

export async function onLoadTodos() {
  const { db } = getContext();
  return listTodos(db);
}

export async function onAddTodo(title: string) {
  const { db } = getContext();
  return createTodo(db, { title });
}
