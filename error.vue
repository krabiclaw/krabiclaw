<template>
  <div class="min-h-screen flex items-center justify-center bg-default px-6 py-12">
    <div class="w-full max-w-sm text-center" :style="paletteStyle">
      <div class="mb-6 flex justify-center">
        <SiteLogo :alt="organization?.name || 'Site logo'" size="md" loading="eager">
          <span v-if="organization?.name" class="text-xl font-bold text-default">
            {{ organization.name }}
          </span>
        </SiteLogo>
      </div>

      <p class="text-sm font-medium text-dimmed uppercase tracking-[0.18em] mb-2">
        Error {{ errorStatusCode }}
      </p>
      <h1 class="text-2xl font-bold text-default tracking-tight mb-2">
        {{ isNotFound ? "Page not found" : "Something went wrong" }}
      </h1>
      <p class="text-sm text-muted mb-8">
        {{ isNotFound
          ? "The page you're looking for doesn't exist or may have moved."
          : "We hit an unexpected error. Please try again." }}
      </p>

      <button
        type="button"
        class="inline-flex items-center justify-center rounded-full bg-primary px-5 py-3 text-sm font-semibold text-on-primary transition hover:opacity-90 cursor-pointer"
        @click="clearError({ redirect: '/' })"
      >
        Go back home
      </button>
    </div>
    <!-- Nuxt renders this page outside app.vue, so the notice that grants
         analytics and offers Reject has to be mounted here as well: a visitor
         whose first page is a 404 was otherwise never granted and never asked. -->
    <ZarazConsentNotice />
  </div>
</template>

<script setup>
import { buildTenantHeadLinks } from '~/utils/tenant-head'
import { publicSurfaceStylesheetForRequest } from '~/utils/public-surface-hints'

const props = defineProps({
  error: Object
})

const errorStatusCode = computed(() => props.error?.statusCode ?? props.error?.status ?? 500)
const isNotFound = computed(() => errorStatusCode.value === 404)

const { isPlatform, tenantType, themeId, organization } = useTenantOrganization()
const { paletteStyle } = usePublicSiteBrand()
const route = useRoute()

// Nuxt renders this page outside the layout system, so the surface CSS a layout
// would import never loads and production served the error page in Times with
// no tokens at all. Dev hid it, because Vite injects every stylesheet there.
// The surface is resolved rather than hardcoded, since tenant sites 404 through
// this same component and must not be handed the platform sheet.
const surfaceStylesheet = computed(() => {
  try {
    return publicSurfaceStylesheetForRequest({
      pathname: route.path,
      tenantType,
      themeId,
      vertical: organization?.vertical,
    })
  } catch {
    // An unsupported template must not throw while already rendering an error.
    return null
  }
})


useHead(() => ({
  link: [
    ...(surfaceStylesheet.value ? [{ rel: 'stylesheet', href: surfaceStylesheet.value }] : []),
    ...buildTenantHeadLinks({
      isPlatform,
      organizationMedia: organization?.media,
    }),
  ],
}))
</script>
