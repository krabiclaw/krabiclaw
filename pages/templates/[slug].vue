<template>
  <div>
    <Teleport to="body">
      <div
        v-if="isDemoPreviewOpen"
        ref="previewDialogRef"
        class="fixed inset-0 z-[100] bg-zinc-950"
        role="dialog"
        aria-modal="true"
        :aria-label="`${template.displayName} template demo preview`"
      >
        <div class="fixed inset-x-0 top-0 z-[101] border-b border-white/10 bg-zinc-950/95 backdrop-blur-md">
          <div class="mx-auto flex max-w-7xl items-center gap-3 px-4 py-3 sm:px-6">
            <button
              ref="closePreviewButtonRef"
              type="button"
              class="inline-flex size-10 shrink-0 items-center justify-center rounded-full border border-white/20 text-white transition hover:bg-white/10"
              aria-label="Close demo preview"
              @click="closeDemoPreview"
            >
              <PlatformIcon name="x" class="size-5" />
            </button>
            <div class="flex min-w-0 items-center gap-3">
              <img
                v-if="template.logoUrl"
                :src="template.logoUrl"
                :alt="`${template.displayName} logo`"
                class="h-8 w-8 shrink-0 rounded-lg object-contain"
              />
              <div v-else class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-sm font-bold text-white" style="background: linear-gradient(135deg, var(--kc-navy) 0%, var(--kc-navy-700) 100%);">
                {{ template.displayName.charAt(0) }}
              </div>
              <div class="min-w-0">
                <p class="text-sm font-semibold text-white">{{ template.displayName }}</p>
                <p class="truncate text-xs text-white/50">by Krabiclaw · {{ template.priceLabel }}</p>
              </div>
            </div>
            <div class="ml-auto">
              <PlatformAccountCta :to="template.ctaTo" :label="template.ctaLabel" variant="gradient" size="md" />
            </div>
          </div>
        </div>
        <iframe
          :src="demoUrl"
          class="absolute inset-x-0 top-[113px] h-[calc(100dvh-113px)] w-full border-0 sm:top-[65px] sm:h-[calc(100dvh-65px)]"
          :title="`${template.displayName} template live demo`"
        />
      </div>
    </Teleport>

    <div :inert="isDemoPreviewOpen">

    <!-- ── Page hero ─────────────────────────────────────────────────── -->
    <section class="relative overflow-hidden py-16 lg:py-20">
      <div class="pointer-events-none absolute inset-0 -z-10">
        <div class="absolute -top-20 right-1/4 w-[500px] h-[500px] rounded-full opacity-20 blur-3xl" style="background: radial-gradient(circle, var(--kc-coral-200) 0%, transparent 70%);"></div>
        <div class="absolute -bottom-10 left-1/3 w-[400px] h-[400px] rounded-full opacity-15 blur-3xl" style="background: radial-gradient(circle, var(--kc-teal-100) 0%, transparent 70%);"></div>
      </div>

      <div class="mx-auto max-w-6xl px-4 sm:px-6 text-center">
        <span class="inline-flex items-center gap-2 text-[11px] font-bold tracking-[0.3em] uppercase text-(--kc-teal-600) bg-(--kc-teal-100) px-3.5 py-1.5 rounded-full border border-(--kc-teal)/20 mb-5">
          <span class="w-1.5 h-1.5 rounded-full bg-(--kc-teal) shrink-0" />
          Templates
        </span>
        <h1 class="text-[clamp(32px,5vw,56px)] font-extrabold tracking-tight leading-[1.05] mb-4 m-0">
          <span class="text-default">{{ template.displayName }}</span>
        </h1>
        <p class="text-lg text-muted max-w-xl mx-auto">{{ template.tagline }}</p>
      </div>
    </section>

    <!-- ── Preview card ─────────────────────────────────────────────── -->
    <section class="mx-auto max-w-6xl px-4 py-4 sm:px-6">
      <div class="relative overflow-hidden rounded-2xl border border-default" style="background: var(--ui-bg-elevated);">
        <div class="absolute top-0 inset-x-0 h-0.5" style="background: linear-gradient(90deg, var(--kc-coral) 0%, var(--kc-teal) 100%);"></div>
        <div class="relative aspect-[16/10] overflow-hidden bg-zinc-950">
          <iframe
            :src="demoUrl"
            class="absolute inset-0 w-full h-full border-0"
            loading="lazy"
            :title="`${template.displayName} template live preview`"
          />
        </div>

        <div class="border-t border-default px-6 py-4" style="background: var(--ui-bg-elevated);">
          <div class="flex flex-wrap items-center justify-between gap-4">
            <div class="flex items-center gap-3">
              <img
                v-if="template.logoUrl"
                :src="template.logoUrl"
                :alt="`${template.displayName} logo`"
                class="h-8 w-8 rounded-lg object-contain"
              />
              <div v-else class="w-8 h-8 rounded-lg flex items-center justify-center text-white text-sm font-bold" style="background: linear-gradient(135deg, var(--kc-navy) 0%, var(--kc-navy-700) 100%);">
                {{ template.displayName.charAt(0) }}
              </div>
              <div>
                <p class="text-sm font-semibold text-default">{{ template.displayName }}</p>
                <p class="text-xs text-muted">{{ template.priceNote }}</p>
              </div>
            </div>

            <div class="flex items-center gap-3">
              <PlatformButton variant="outline" size="md" @click="openDemoPreview">
                <PlatformIcon name="arrow-up-right" class="size-4" />
                {{ isNclsShowcase ? 'Open customer site' : 'Open demo' }}
              </PlatformButton>
              <PlatformAccountCta :to="template.ctaTo" :label="template.ctaLabel" variant="gradient" size="md" />
            </div>
          </div>
          <p v-if="isNclsShowcase" class="mt-3 text-xs text-muted">
            This is a live, approved customer site — North Carolina Legal Services — shown here as a real-world Blawby example, not a synthetic demo.
          </p>
        </div>
      </div>
    </section>

    <!-- ── Template detail ─────────────────────────────────────────── -->
    <div class="mx-auto max-w-6xl px-6 py-16 lg:py-20">
      <div class="grid gap-16 lg:grid-cols-[1fr_360px]">
        <div>
          <div class="mb-2 flex items-center gap-3">
            <h2 class="text-3xl font-bold text-default">{{ template.displayName }}</h2>
            <span
              v-if="template.status === 'coming_soon'"
              class="rounded-full bg-elevated px-3 py-0.5 text-sm font-medium text-muted"
            >
              Coming soon
            </span>
            <span v-else class="rounded-full bg-primary/10 px-3 py-0.5 text-sm font-medium text-primary">
              {{ template.priceLabel }}
            </span>
          </div>
          <p class="mt-3 text-lg leading-relaxed text-muted">{{ template.description }}</p>

          <div class="mt-6 flex flex-wrap gap-1.5">
            <span
              v-for="vertical in template.supportedVerticals"
              :key="vertical"
              class="rounded-full border border-default px-2.5 py-0.5 text-xs font-medium text-default"
            >
              {{ vertical }}
            </span>
          </div>

          <!-- Feature grid -->
          <div class="mt-10 grid gap-4 sm:grid-cols-2">
            <div v-for="feature in template.features" :key="feature.label" class="group overflow-hidden rounded-xl border border-default bg-elevated hover:border-(--kc-coral)/30 hover:shadow-md transition-all duration-300">
              <div class="relative flex aspect-video items-center justify-center overflow-hidden" style="background: linear-gradient(135deg, var(--ui-bg-muted) 0%, var(--ui-bg-elevated) 100%);">
                <div class="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity" style="background: linear-gradient(135deg, var(--kc-coral-50) 0%, var(--kc-teal-100)/30 100%);"></div>
                <div class="relative w-14 h-14 rounded-2xl flex items-center justify-center" style="background: linear-gradient(135deg, var(--kc-navy) 0%, var(--kc-navy-700) 100%); box-shadow: 0 8px 24px rgba(31,37,71,0.2);">
                  <PlatformIcon :name="feature.icon" class="size-6 text-white" />
                </div>
              </div>
              <div class="p-4">
                <p class="text-sm font-semibold text-default">{{ feature.label }}</p>
                <p class="mt-1 text-xs leading-relaxed text-muted">{{ feature.description }}</p>
              </div>
            </div>
          </div>

          <!-- What's included -->
          <div class="mt-12">
            <h3 class="text-xl font-semibold text-default mb-6">What's included</h3>
            <div class="grid gap-3 sm:grid-cols-2">
              <div v-for="item in template.included" :key="item" class="flex items-start gap-3">
                <PlatformIcon name="check" class="mt-0.5 size-4 shrink-0 text-primary" />
                <span class="text-sm text-default">{{ item }}</span>
              </div>
            </div>
          </div>
        </div>

        <!-- Right: sticky sidebar -->
        <div class="lg:sticky lg:top-8 lg:self-start">
          <div class="rounded-2xl border border-default overflow-hidden" style="background: var(--ui-bg-elevated); box-shadow: 0 8px 40px rgba(31,37,71,0.08);">
            <div class="h-1" style="background: linear-gradient(90deg, var(--kc-coral) 0%, var(--kc-teal) 100%);"></div>
            <div class="p-6">
              <img
                v-if="template.logoUrl"
                :src="template.logoUrl"
                :alt="`${template.displayName} logo`"
                class="w-12 h-12 rounded-xl object-contain mb-4"
              />
              <div v-else class="w-12 h-12 rounded-xl flex items-center justify-center text-white text-xl font-bold mb-4" style="background: linear-gradient(135deg, var(--kc-navy) 0%, var(--kc-navy-700) 100%); box-shadow: 0 4px 12px rgba(31,37,71,0.2);">
                {{ template.displayName.charAt(0) }}
              </div>
              <h3 class="text-xl font-bold text-default">{{ template.displayName }}</h3>
              <p class="mt-1 text-sm text-muted">{{ template.tagline }}</p>

              <div class="mt-6 space-y-3">
                <PlatformAccountCta :to="template.ctaTo" :label="template.ctaLabel" variant="gradient" size="lg" block />
                <PlatformButton variant="outline" size="lg" block @click="openDemoPreview">
                  <PlatformIcon name="arrow-up-right" class="size-4" />
                  {{ template.demoLabel }}
                </PlatformButton>
              </div>

              <div class="mt-6 border-t border-default pt-6 space-y-2">
                <div v-for="spec in template.specs" :key="spec.label" class="flex justify-between text-sm">
                  <span class="text-muted">{{ spec.label }}</span>
                  <span class="font-medium text-default">{{ spec.value }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { findPublishedTemplateMarketing } from '~/utils/template-registry'

// Keyed by full path so navigating directly between two template slugs (e.g.
// /templates/saya -> /templates/blawby) remounts the page instead of Vue
// Router reusing the instance — template/isNclsShowcase/demoUrl are all
// computed once at setup from route.params.slug, so without this key a
// same-component slug change would silently keep showing the old template.
definePageMeta({ layout: 'platform', key: route => route.fullPath })

const route = useRoute()
const slug = String(route.params.slug ?? '')

// Static, local-data-driven lookup — no server round trip and no async
// fetch, so the "nested SSR self-fetch loses Cloudflare bindings" pitfall in
// This route does not use the public tenant data loader. Unknown or unpublished
// slugs 404 immediately.
const template = findPublishedTemplateMarketing(slug)

if (!template) {
  throw createError({ statusCode: 404, statusMessage: 'Template not found', fatal: true })
}

const config = useRuntimeConfig()
const requestUrl = useRequestURL()
const platformHostname = config.public.freeOrganizationDomain?.replace(/^https?:\/\//, '').replace(/\/$/, '')
if (!platformHostname) throw createError({ statusCode: 500, statusMessage: 'NUXT_PUBLIC_FREE_ORGANIZATION_DOMAIN is required' })
const isDemoPreviewOpen = ref(false)
const previewDialogRef = ref<HTMLElement | null>(null)
const closePreviewButtonRef = ref<HTMLButtonElement | null>(null)
let previewTrigger: HTMLElement | null = null

const isNclsShowcase = template.slug === 'blawby'

// Saya has no static registry demoUrl (see TemplateMarketingMetadata.demoUrl
// doc) because its demo runs on an ephemeral seeded subdomain that differs
// between dev and production — resolved the same way pages/templates.vue
// always has. Blawby's demoUrl is the literal NCLS-approved production URL.
const demoUrl = computed(() => {
  if (template.demoUrl) return template.demoUrl
  const isLocalOrigin = requestUrl.hostname === 'localhost'
    || requestUrl.hostname === '127.0.0.1'
    || requestUrl.hostname.endsWith('.localhost')
  return isLocalOrigin
    ? requestUrl.origin
    : `https://demo.${platformHostname}`
})

function openDemoPreview(event: MouseEvent) {
  previewTrigger = event.currentTarget as HTMLElement
  isDemoPreviewOpen.value = true
  nextTick(() => closePreviewButtonRef.value?.focus())
}

function closeDemoPreview() {
  isDemoPreviewOpen.value = false
  nextTick(() => previewTrigger?.focus())
}

function handlePreviewKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && isDemoPreviewOpen.value) closeDemoPreview()
  if (event.key !== 'Tab' || !isDemoPreviewOpen.value || !previewDialogRef.value) return
  const focusable = [...previewDialogRef.value.querySelectorAll<HTMLElement>('button, a[href], iframe, [tabindex]:not([tabindex="-1"])')]
    .filter(element => !element.hasAttribute('disabled'))
  if (!focusable.length) return
  const first = focusable[0]!
  const last = focusable[focusable.length - 1]!
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

watch(isDemoPreviewOpen, (isOpen) => {
  if (!import.meta.client) return
  document.documentElement.classList.toggle('overflow-hidden', isOpen)
})

onMounted(() => {
  window.addEventListener('keydown', handlePreviewKeydown)
})

onUnmounted(() => {
  window.removeEventListener('keydown', handlePreviewKeydown)
  if (import.meta.client) document.documentElement.classList.remove('overflow-hidden')
})

const organizationUrl = config.public.siteUrl

// A page about the business: its image is the organization's.
const { social_image: organizationSocialImage, template: organizationTemplate } = useTenantOrganization().organization
if (organizationTemplate.slug !== 'platform') throw createError({ statusCode: 404, statusMessage: 'Page not found', fatal: true })
useSocialMetadata({
  path: `/templates/${template.slug}`,
  socialImage: organizationSocialImage,
  title: template.seo.title,
  description: template.seo.description,
  schemaPageType: 'ItemPage',
  breadcrumbs: [
    { name: 'Home', url: '/' },
    { name: 'Templates', url: '/templates' },
    { name: template.displayName, url: `/templates/${template.slug}` },
  ],
  schemaNodes: [
    {
      '@type': 'Product',
      '@id': `${organizationUrl}/templates/${template.slug}#product`,
      name: template.displayName,
      description: template.description,
      url: `${organizationUrl}/templates/${template.slug}`,
      offers: template.schemaOffer ? {
        '@type': 'Offer',
        price: template.schemaOffer.price,
        priceCurrency: template.schemaOffer.priceCurrency,
        availability: template.status === 'coming_soon'
          ? 'https://schema.org/PreOrder'
          : 'https://schema.org/InStock',
      } : undefined,
    },
  ],
})
</script>
