<template>
  <div
    class="tenant-layout saya-theme min-h-screen flex flex-col font-sans bg-default text-default"
    :style="paletteStyle"
    :data-hydrated="hydrated ? 'true' : 'false'"
    :data-public-critical-shell="isHome ? 'true' : undefined"
    :data-font-preset="fontPreset"
  >
    <!-- Teleport target for Saya components (e.g. BookingModal) that need to escape
         page overflow/stacking contexts but still must render inside this div to
         inherit the --ui-* tokens .saya-theme and the site palette set here.
         Teleporting straight to <body> puts them outside this scope entirely, which
         reads as the modal falling back to the platform's default (non-Saya) theme.
         Placed before the page content (rather than after) so it precedes any
         Teleport source in document order during SSR — Teleport targets that only
         appear later in the same render caused a hydration child-count mismatch. -->
    <div id="saya-portal-root" />

    <SayaHeader
      :organization="shellOrganization"
      :locations="locations"
      :has-products="shell.hasProducts.value"
      :has-bookable-products="shell.hasBookableProducts.value"
      :has-reservations="shell.hasReservations.value"
    />
    <main class="grow" :data-route-shell="route.path">
      <slot />
    </main>
    <LazySayaFooter
      :organization="shellOrganization"
      :locations="footerLocations"
      :error="bootstrapError"
      :has-products="shell.hasProducts.value"
      :has-bookable-products="shell.hasBookableProducts.value"
      :has-reservations="shell.hasReservations.value"
    />
  </div>
</template>

<script setup lang="ts">
import sayaCriticalCss from '~/assets/css/saya-critical.css?raw'
import '~/assets/css/saya-entry.css'

const route = useRoute()
const hydrated = ref(false)
onMounted(() => { hydrated.value = true })
const { locale: activeLocale } = useI18n()
const isHome = computed(() => route.path === '/'
  || (activeLocale.value !== 'en' && route.path === `/${activeLocale.value}`))

useHead(() => {
  return {
    htmlAttrs: { lang: activeLocale.value },
    link: [
      { rel: 'preconnect', href: 'https://imagedelivery.net' },
      { rel: 'preconnect', href: 'https://media.krabiclaw.com' },
      // The stable surface file is written by `nuxt build`; under `nuxt dev`
      // Vite serves the imported entry itself.
      ...(import.meta.dev ? [] : [{
        key: isHome.value ? 'saya-home-stylesheet' : 'saya-surface-stylesheet',
        rel: 'stylesheet' as const,
        href: '/_nuxt/surfaces/saya.css',
      }]),
    ],
    style: isHome.value ? [{ innerHTML: sayaCriticalCss, tagPriority: 'critical' }] : [],
  }
})

if (import.meta.dev) useDebugLCP()

// Persistent chrome uses the minimal shell contract. Route-specific Product and
// experience data comes from the keyed page loader and changes independently.
const shell = useOrganizationShellState()
// Await the existing keyed shell on every SSR route, not only the homepage, so
// a direct menu/contact visit serializes its header and footer with the shell.
if (import.meta.server) await shell.ready
const { locations, error: bootstrapError, organization: shellOrganization } = shell
const { fontPreset, paletteStyle } = usePublicSiteBrand()

// A page under /locations/<slug> is about exactly one location: the location
// itself, its menu, or a single dish. Printing every location's address, phone
// and today's hours in the footer of those pages was the single largest source
// of duplicate text on Kikuzuki's 896 dish pages — that block was roughly half
// of each page's ~124 visible words and byte-identical across all of them. The
// footer now carries the location the page is actually about, which also makes
// the 84 dishes sold at two locations genuinely distinct pages.
//
// Slug matching works in every locale because the shell's locations are fetched
// per locale and carry the same localized slugs the route does.
const scopedLocationSlug = computed(() => {
  const path = route.path
  const localePrefix = `/${activeLocale.value}`
  const sourcePath = activeLocale.value !== 'en' && path.startsWith(localePrefix)
    ? path.slice(localePrefix.length)
    : path
  const matched = sourcePath.match(/^\/locations\/([^/]+)/)?.[1]
  if (matched === undefined) return null
  try {
    return decodeURIComponent(matched)
  }
  catch {
    // A segment that is not a valid escape sequence. The request layer decodes
    // the pathname first and answers 400 for the ones I could construct
    // (`/locations/%`, `/locations/%252`), so nothing reaches here today —
    // this layout does not decide its own behaviour on that staying true. A
    // segment naming no location scopes the footer to nothing, and the page
    // below answers with its own 404.
    return null
  }
})
const footerLocations = computed(() => (scopedLocationSlug.value === null
  ? locations.value
  : locations.value.filter(location => location.slug === scopedLocationSlug.value)))
</script>
