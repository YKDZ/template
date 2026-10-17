<script setup lang="ts">
import { storeToRefs } from "pinia";

import { useCounterStore } from "../stores/counter.ts";

const counter = useCounterStore();
const { count } = storeToRefs(counter);
</script>

<template>
  <button
    class="rounded bg-cyan-300 px-4 py-2 font-semibold text-slate-950 hover:bg-cyan-200"
    type="button"
    @click="counter.increment()"
  >
    计数：{{ count }}
  </button>
</template>
