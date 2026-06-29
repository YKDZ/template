<script setup lang="ts">
import { usePreferredDark } from "@vueuse/core";
import { storeToRefs } from "pinia";
import { computed, onMounted, ref } from "vue";
import { api } from "@/api";
import { useCounterStore } from "@/stores/counter";

const counter = useCounterStore();
const { count } = storeToRefs(counter);
const prefersDark = usePreferredDark();
const themeLabel = computed(() => (prefersDark.value ? "dark" : "light"));
const apiStatus = ref("checking");

onMounted(async () => {
  const response = await api.api.health.$get();
  const body = await response.json();
  apiStatus.value = body.status;
});
</script>

<template>
  <main class="min-h-screen bg-slate-950 text-white">
    <section class="mx-auto flex min-h-screen max-w-3xl flex-col justify-center px-6 py-16">
      <p class="text-sm font-medium uppercase tracking-wide text-cyan-300">Vue Hono app preset</p>
      <h1 class="mt-4 text-4xl font-semibold">Vue, Hono, and typed RPC</h1>
      <p class="mt-4 text-lg text-slate-300">
        This generated workspace typechecks the web package against the API contract.
      </p>
      <div class="mt-8 flex flex-wrap items-center gap-4">
        <button
          class="rounded bg-cyan-300 px-4 py-2 font-semibold text-slate-950 hover:bg-cyan-200"
          type="button"
          @click="counter.increment()"
        >
          Count is {{ count }}
        </button>
        <span class="text-sm text-slate-400">Preferred theme: {{ themeLabel }}</span>
        <span class="text-sm text-slate-400">API status: {{ apiStatus }}</span>
      </div>
    </section>
  </main>
</template>
