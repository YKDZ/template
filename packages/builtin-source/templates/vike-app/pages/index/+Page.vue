<script setup lang="ts">
import { ref } from "vue";

import CounterButton from "#/components/CounterButton.vue";
import type { Todo } from "#/database/schema";

import { onAddTodo, onLoadTodos } from "./+Page.telefunc";

const title = ref("");
const todos = ref<Todo[]>([]);
const error = ref<string | undefined>();

async function refreshTodos() {
  error.value = undefined;

  try {
    todos.value = await onLoadTodos();
  } catch (unknownError) {
    error.value =
      unknownError instanceof Error
        ? `待办加载失败：${unknownError.message}`
        : "无法加载待办事项";
  }
}

async function submitTodo() {
  const nextTitle = title.value.trim();
  if (nextTitle.length === 0) {
    return;
  }

  await onAddTodo(nextTitle);
  title.value = "";
  await refreshTodos();
}
</script>

<template>
  <section class="grid gap-8">
    <div class="grid gap-4">
      <p class="text-sm font-semibold tracking-wide text-rose-600 uppercase">
        Vike + Hono
      </p>
      <h1 class="text-4xl font-bold tracking-tight">全栈 Vike 应用</h1>
      <p class="max-w-2xl text-lg text-slate-700">
        使用 Hono 路由、Telefunc 动作和 Drizzle 数据访问构建服务端渲染 Vue
        应用。
      </p>
      <CounterButton />
    </div>

    <form class="flex max-w-xl gap-2" @submit.prevent="submitTodo">
      <input
        v-model="title"
        class="min-w-0 flex-1 rounded border border-slate-300 px-3 py-2"
        name="title"
        placeholder="添加一条数据库待办"
      />
      <button class="rounded bg-slate-950 px-4 py-2 text-white" type="submit">
        添加
      </button>
    </form>

    <button
      class="w-fit text-sm font-medium text-rose-700"
      type="button"
      @click="refreshTodos"
    >
      加载待办事项
    </button>

    <p
      v-if="error"
      class="max-w-xl rounded border border-amber-300 bg-amber-50 p-3 text-sm"
    >
      {{ error }}
    </p>

    <ul v-if="todos.length > 0" class="grid max-w-xl gap-2">
      <li
        v-for="todo in todos"
        :key="todo.id"
        class="rounded border border-slate-200 bg-white px-3 py-2"
      >
        {{ todo.title }}
      </li>
    </ul>
  </section>
</template>
