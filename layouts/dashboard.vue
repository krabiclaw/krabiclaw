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
import { rendersDashboardCalendar, rendersWebsiteDocument } from '~/utils/dashboard-document'
import '~/assets/css/dashboard.css'

const nuxt = useNuxtApp()
const route = useRoute()
// Keep the shell mounted when navigating from a private dashboard document.
const document = useState('dashboard:server-document', () => (import.meta.server || nuxt.isHydrating)
  && typeof route.params.org_slug === 'string'
  && (rendersDashboardCalendar(route.path, route.query)
    || rendersWebsiteDocument(route.path.slice(`/dashboard/${route.params.org_slug}`.length), route.query)
    || /^\/dashboard\/[^/]+(?:\/(?:bookings\/[^/]+|products|earnings(?:\/(?:performance|payouts))?|integrations(?:\/google-calendar)?))?\/?$/.test(route.path)))
const wrapper = document.value ? 'div' : ClientOnly

if (import.meta.client && 'serviceWorker' in navigator) {
  usePwaInstall()
  void navigator.serviceWorker.register('/sw.js', { scope: '/dashboard/' }).catch((error) => {
    nuxt.callHook('vue:error', error, null, 'dashboard-service-worker-registration')
  })
}

useHead({
  meta: [
    { name: 'mobile-web-app-capable', content: 'yes' },
    { name: 'apple-mobile-web-app-capable', content: 'yes' },
    { name: 'apple-mobile-web-app-status-bar-style', content: 'default' },
    { name: 'apple-mobile-web-app-title', content: 'Blawby' },
  ],
  link: [
    { rel: 'manifest', href: '/manifest.webmanifest' },
    { rel: 'apple-touch-icon', href: '/platform/blawby-180.png' },
    // The shell reads theme breakpoints during setup.
    ...(import.meta.dev ? [] : [{ rel: 'stylesheet' as const, href: '/_nuxt/surfaces/dashboard.css' }]),
  ],
})
</script>
