<template>
  <ClientOnly>
    <!-- Save enables from UForm's dirty fields. A select marks its field on
         change and again on a debounced input; with the 300ms default a Save
         inside that window was re-dirtied after the submit cleared it. -->
    <UTheme :props="{ form: { validateOnInputDelay: 0 } }">
      <DashboardShell>
        <slot />
      </DashboardShell>
    </UTheme>
  </ClientOnly>
</template>

<script setup lang="ts">
import '~/assets/css/dashboard.css'

// The shell reads the theme breakpoints during setup, so the document must
// load this stylesheet before running the dashboard entry script.
useHead({ link: import.meta.dev ? [] : [{ rel: 'stylesheet', href: '/_nuxt/surfaces/dashboard.css' }] })
</script>
