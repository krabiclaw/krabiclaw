<template>
  <component :is="wrapper">
    <!-- Save enables from UForm's dirty fields. A select marks its field on
         change and again on a debounced input; with the 300ms default a Save
         inside that window was re-dirtied after the submit cleared it. -->
    <UTheme :props="{ form: { validateOnInputDelay: 0 } }">
      <DashboardShell>
        <slot />
      </DashboardShell>
    </UTheme>
  </component>
</template>

<script setup lang="ts">
import { ClientOnly } from '#components'
import '~/assets/css/dashboard.css'

const nuxt = useNuxtApp()
const route = useRoute()
// Keep the shell mounted as navigation moves away from a server-rendered reservation.
const document = useState('dashboard:reservation-document', () => (import.meta.server || nuxt.isHydrating)
  && /^\/dashboard\/[^/]+\/bookings\/[^/]+\/?$/.test(route.path))
const wrapper = document.value ? 'div' : ClientOnly

// The shell reads the theme breakpoints during setup, so the document must
// load this stylesheet before running the dashboard entry script.
useHead({ link: import.meta.dev ? [] : [{ rel: 'stylesheet', href: '/_nuxt/surfaces/dashboard.css' }] })
</script>
