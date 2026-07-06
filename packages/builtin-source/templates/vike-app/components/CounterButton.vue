<script setup lang="ts">
import { onMounted, ref } from "vue";

const count = ref(0);
const mounted = ref(false);

onMounted(() => {
  mounted.value = true;
});
</script>

<template>
  <button
    type="button"
    class="rounded border border-slate-900 bg-white px-3 py-1 text-sm font-medium text-slate-900 shadow-sm disabled:cursor-wait disabled:opacity-60"
    :disabled="!mounted"
    @click="count += 1"
  >
    Count {{ count }}
  </button>
</template>
