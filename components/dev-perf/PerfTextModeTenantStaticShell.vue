<template>
  <section class="dev-perf-section dev-perf-platform-shell" aria-label="Static tenant shell render test">
    <h2>Static tenant shell render test</h2>
    <p>
      This mode renders Tenant-shaped header/footer markup without real tenant components.
    </p>
    <div class="dev-perf-shell-frame tenant-theme">
      <header class="dev-perf-static-header">
        <NuxtLink to="/" class="dev-perf-static-brand">
          <span class="dev-perf-static-mark">S</span>
          <span>Customer site</span>
        </NuxtLink>
        <nav class="dev-perf-static-nav" aria-label="Static tenant test navigation">
          <NuxtLink v-for="item in tenantStaticNavItems" :key="item.to" :to="item.to">
            {{ item.label }}
          </NuxtLink>
        </nav>
      </header>
      <main class="dev-perf-shell-body">
        <h3>Static body</h3>
        <p>This is the tenant static shell control.</p>
      </main>
      <footer class="dev-perf-static-footer">
        Static tenant footer text
      </footer>
    </div>
  </section>
</template>

<script setup lang="ts">
defineProps<{
  tenantStaticNavItems: Array<{ label: string, to: string }>
}>()
</script>
