<script setup lang="ts">
import logoUrl from "#/assets/logo.svg";
</script>

<template>
  <div class="min-h-screen bg-slate-50 text-slate-950">
    <header class="border-b border-slate-200 bg-white">
      <nav class="mx-auto flex max-w-4xl items-center gap-3 px-6 py-4">
        <img :src="logoUrl" alt="" class="size-8" />
        <a href="/" class="font-semibold text-slate-950">Vike App</a>
      </nav>
    </header>
    <main class="mx-auto max-w-4xl px-6 py-10">
      <slot />
    </main>
  </div>
</template>
