<template>
  <section class="dev-perf-section dev-perf-platform-shell" aria-label="Static shell render test">
    <h2>Static shell render test</h2>
    <p>
      This mode renders a header/footer-shaped shell without UIcon, UColorModeButton, dropdowns, or nav data composables.
    </p>
    <div class="dev-perf-shell-frame">
      <header class="dev-perf-static-header">
        <NuxtLink to="/" class="dev-perf-static-brand">
          <img src="/platform/krabiclaw-symbol.svg" alt="KrabiClaw" width="34" height="34">
          <span>krabiclaw.com</span>
        </NuxtLink>
        <nav class="dev-perf-static-nav" aria-label="Static test navigation">
          <NuxtLink v-for="item in staticNavItems" :key="item.to" :to="item.to">
            {{ item.label }}
          </NuxtLink>
        </nav>
      </header>
      <main class="dev-perf-shell-body">
        <h3>Static body</h3>
        <p>
          This keeps shell-like markup and the logo image but removes the dynamic header pieces.
        </p>
      </main>
      <footer class="dev-perf-static-footer">
        Static footer text
      </footer>
    </div>
  </section>
</template>

<script setup lang="ts">
defineProps<{
  staticNavItems: Array<{ label: string, to: string }>
}>()
</script>
