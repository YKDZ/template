<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";

import { getHealth } from "#/api";

const themeLabel = ref<"深色" | "浅色">("浅色");
const apiStatus = ref("检查中");

let preferredThemeQuery: MediaQueryList | undefined;

function updateThemeLabel(event: MediaQueryList | MediaQueryListEvent): void {
  themeLabel.value = event.matches ? "深色" : "浅色";
}

onMounted(() => {
  preferredThemeQuery = window.matchMedia("(prefers-color-scheme: dark)");
  updateThemeLabel(preferredThemeQuery);
  preferredThemeQuery.addEventListener("change", updateThemeLabel);
});

onUnmounted(() => {
  preferredThemeQuery?.removeEventListener("change", updateThemeLabel);
});

onMounted(async () => {
  const body = await getHealth();
  apiStatus.value = body.status === "ok" ? "正常" : body.status;
});
</script>

<template>
  <main class="min-h-screen bg-slate-950 text-white">
    <section
      class="mx-auto flex min-h-screen max-w-3xl flex-col justify-center px-6 py-16"
    >
      <p class="text-sm font-medium tracking-wide text-cyan-300 uppercase">
        Vue + Hono 应用预设
      </p>
      <h1 class="mt-4 text-4xl font-semibold">Vue 和 Hono 工作区</h1>
      <p class="mt-4 text-lg text-slate-300">
        页面启动后会检查服务状态，并在下方展示结果。
      </p>
      <div class="mt-8 flex flex-wrap items-center gap-4">
        <span class="text-sm text-slate-400">系统主题：{{ themeLabel }}</span>
        <span class="text-sm text-slate-400">API 状态：{{ apiStatus }}</span>
      </div>
    </section>
  </main>
</template>
