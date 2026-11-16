<template>
  <div class="min-h-screen bg-default flex items-center justify-center px-6 py-12">
    <main class="w-full max-w-md">
      <slot />
    </main>
  </div>
</template>

<script setup lang="ts">
import '~/assets/css/platform-app-entry.css'

// The stable surface file is written by `nuxt build`; under `nuxt dev` Vite serves
// the imported entry itself, so the link exists only in built output.
useHead({
  link: import.meta.dev ? [] : [{ rel: 'stylesheet', href: '/_nuxt/surfaces/platform-app.css' }],
})
</script>
