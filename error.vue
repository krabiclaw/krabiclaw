<template>
  <div class="min-h-screen flex items-center justify-center bg-default px-6 py-12" :class="organization ? `${organization.template.slug}-theme` : 'platform-theme'" :style="paletteStyle" :data-font-preset="fontPreset">
    <div class="w-full max-w-sm text-center">
      <div v-if="organization" class="mb-6 flex justify-center">
        <SiteLogo :alt="organization.name" size="md" loading="eager">
          <span class="text-xl font-bold text-default">
            {{ organization.name }}
          </span>
        </SiteLogo>
      </div>

      <p class="text-sm font-medium text-dimmed uppercase tracking-[0.18em] mb-2">
        Error {{ errorStatusCode }}
      </p>
      <h1 class="text-2xl font-bold text-default tracking-tight mb-2">
        {{ isNotFound ? "Page not found" : isGone ? "Site no longer available" : "Something went wrong" }}
      </h1>
      <p class="text-sm text-muted mb-8">
        {{ isNotFound
          ? "The page you're looking for doesn't exist or may have moved."
          : isGone ? "This site's address has been retired."
          : error.data?.reason || error.message || "We hit an unexpected error. Please try again." }}
      </p>

      <button
        v-if="organization"
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
    <ZarazConsentNotice v-if="organization" />
  </div>
</template>

<script setup lang="ts">
import { buildTenantHeadLinks } from '~/utils/tenant-head'
import { publicSurfaceStylesheetForRequest } from '~/utils/public-surface-hints'
import type { TenantContext } from '~/composables/useTenantOrganization'

const props = defineProps<{ error: { statusCode?: number; status?: number; message?: string; tenantContext?: TenantContext; data?: { reason?: string } } }>()

const errorStatusCode = computed(() => props.error.statusCode ?? props.error.status ?? 500)
const isNotFound = computed(() => errorStatusCode.value === 404)
const isGone = computed(() => errorStatusCode.value === 410)

// An unknown host has no organization. Error rendering must not invoke the
// strict context used by a resolved public site. Nuxt's native error payload
// retains the already resolved identity of a known site, including hydration.
const tenantContext = useState<TenantContext | undefined>('tenant-context', () => props.error.tenantContext)
const organization = tenantContext.value?.organization
const isPlatform = organization?.template.slug === 'platform'
const { fontPreset, paletteStyle } = usePublicSiteBrand(organization ?? null)
const route = useRoute()

// Nuxt renders this page outside the layout system, so the surface CSS a layout
// would import never loads and production served the error page in Times with
// no tokens at all. Dev hid it, because Vite injects every stylesheet there.
// The surface is resolved rather than hardcoded, since tenant sites 404 through
// this same component and must not be handed the platform sheet.
const surfaceStylesheet = organization
  ? publicSurfaceStylesheetForRequest({
      pathname: route.path,
      tenantType: isPlatform ? 'platform' : 'tenant',
      themeId: organization.theme_id,
      vertical: organization.vertical,
    })
  : '/_nuxt/surfaces/platform.css'


useHead(() => ({
  link: [
    ...(surfaceStylesheet ? [{ rel: 'stylesheet' as const, href: surfaceStylesheet }] : []),
    ...buildTenantHeadLinks({
      isPlatform,
      organizationMedia: organization?.media,
    }),
  ],
}))
</script>
