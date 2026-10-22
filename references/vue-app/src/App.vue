<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";

import CounterButton from "./components/CounterButton.vue";
const themeLabel = ref<"深色" | "浅色">("浅色");

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
</script>

<template>
  <main class="min-h-screen bg-slate-950 text-white">
    <section
      class="mx-auto flex min-h-screen max-w-3xl flex-col justify-center px-6 py-16"
    >
      <p class="text-sm font-medium tracking-wide text-cyan-300 uppercase">
        Vue 应用预设
      </p>
      <h1 class="mt-4 text-4xl font-semibold">Vue、Vite、Tailwind 和 Pinia</h1>
      <p class="mt-4 text-lg text-slate-300">
        这个生成的应用已经接入严格 TypeScript 检查、单元测试和 Playwright
        端到端测试。
      </p>
      <div class="mt-8 flex items-center gap-4">
        <CounterButton />
        <span class="text-sm text-slate-400">系统主题：{{ themeLabel }}</span>
      </div>
    </section>
  </main>
</template>
