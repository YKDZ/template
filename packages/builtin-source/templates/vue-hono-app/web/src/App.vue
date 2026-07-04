<script setup lang="ts">
import { storeToRefs } from "pinia";
import { onMounted, onUnmounted, ref } from "vue";

import { api } from "#/api";
import { useCounterStore } from "#/stores/counter";

const counter = useCounterStore();
const { count } = storeToRefs(counter);
const themeLabel = ref<"dark" | "light">("light");
const apiStatus = ref("checking");

let preferredThemeQuery: MediaQueryList | undefined;

function updateThemeLabel(event: MediaQueryList | MediaQueryListEvent): void {
  themeLabel.value = event.matches ? "dark" : "light";
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
  const response = await api.api.health.$get();
  const body = await response.json();
  apiStatus.value = body.status;
});
</script>

<template>
  <main class="min-h-screen bg-slate-950 text-white">
    <section
      class="mx-auto flex min-h-screen max-w-3xl flex-col justify-center px-6 py-16"
    >
      <p class="text-sm font-medium tracking-wide text-cyan-300 uppercase">
        Vue Hono app preset
      </p>
      <h1 class="mt-4 text-4xl font-semibold">Vue, Hono, and typed RPC</h1>
      <p class="mt-4 text-lg text-slate-300">
        This generated workspace typechecks the web package against the API
        contract.
      </p>
      <div class="mt-8 flex flex-wrap items-center gap-4">
        <button
          class="rounded bg-cyan-300 px-4 py-2 font-semibold text-slate-950 hover:bg-cyan-200"
          type="button"
          @click="counter.increment()"
        >
          Count is {{ count }}
        </button>
        <span class="text-sm text-slate-400"
          >Preferred theme: {{ themeLabel }}</span
        >
        <span class="text-sm text-slate-400">API status: {{ apiStatus }}</span>
      </div>
    </section>
  </main>
</template>
