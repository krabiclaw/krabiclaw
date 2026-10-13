<template>
  <div>
    <!-- ── Page hero ─────────────────────────────────────────────────── -->
    <section class="relative overflow-hidden py-16 lg:py-20">
      <!-- Ambient gradient orbs -->
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
          <span class="text-default">Beautiful templates,</span><br>
          <span style="background: linear-gradient(135deg, var(--kc-coral) 0%, var(--kc-teal) 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text;">ready to launch.</span>
        </h1>
        <p class="text-lg text-muted max-w-xl mx-auto">
          Pick the template built for your business, connect ChatGPT, go live.
        </p>
      </div>
    </section>

    <!-- ── Template cards ───────────────────────────────────────────── -->
    <section class="mx-auto max-w-6xl px-4 pb-20 sm:px-6">
      <div class="grid gap-6 sm:grid-cols-2">
        <NuxtLink
          v-for="template in templates"
          :key="template.slug"
          :to="`/templates/${template.slug}`"
          class="group relative flex flex-col overflow-hidden rounded-2xl border border-default no-underline transition hover:border-(--kc-coral)/30 hover:shadow-lg"
          style="background: var(--ui-bg-elevated);"
        >
          <!-- Top gradient strip -->
          <div class="h-1 shrink-0" style="background: linear-gradient(90deg, var(--kc-coral) 0%, var(--kc-teal) 100%);"></div>

          <div class="relative flex aspect-[16/9] items-center justify-center overflow-hidden" style="background: linear-gradient(135deg, var(--ui-bg-muted) 0%, var(--ui-bg-elevated) 100%);">
            <img
              v-if="template.previewImageUrl"
              :src="template.previewImageUrl"
              :alt="`${template.displayName} template preview`"
              loading="lazy"
              class="absolute inset-0 size-full object-cover object-top transition-transform duration-300 group-hover:scale-105"
            />
            <template v-else>
              <div class="absolute inset-0 opacity-0 transition-opacity group-hover:opacity-100" style="background: linear-gradient(135deg, var(--kc-coral-50) 0%, var(--kc-teal-100)/30 100%);"></div>
              <div
                class="relative flex h-16 w-16 items-center justify-center rounded-2xl text-2xl font-bold text-white"
                style="background: linear-gradient(135deg, var(--kc-navy) 0%, var(--kc-navy-700) 100%); box-shadow: 0 8px 24px rgba(31,37,71,0.2);"
              >
                {{ template.displayName.charAt(0) }}
              </div>
            </template>
          </div>

          <div class="flex flex-1 flex-col gap-4 p-6">
            <div>
              <div class="flex items-center gap-2">
                <h2 class="text-xl font-bold text-default">{{ template.displayName }}</h2>
                <span
                  v-if="template.status === 'coming_soon'"
                  class="rounded-full bg-elevated px-2.5 py-0.5 text-xs font-medium text-muted"
                >
                  Coming soon
                </span>
                <span v-else class="rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary">
                  {{ template.priceLabel }}
                </span>
              </div>
              <p class="mt-1 text-sm font-medium text-muted">{{ template.tagline }}</p>
            </div>

            <p class="text-sm leading-relaxed text-muted">{{ template.summary }}</p>

            <div class="flex flex-wrap gap-1.5">
              <span
                v-for="vertical in template.supportedVerticals"
                :key="vertical"
                class="rounded-full border border-default px-2.5 py-0.5 text-xs font-medium text-default"
              >
                {{ vertical }}
              </span>
            </div>

            <div class="mt-auto flex items-center gap-3 pt-2">
              <span class="inline-flex items-center gap-1.5 text-sm font-semibold text-primary">
                View details
                <PlatformIcon name="arrow-right" class="size-4 transition group-hover:translate-x-0.5" />
              </span>
            </div>
          </div>
        </NuxtLink>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { listPublishedTemplateMarketing } from '~/utils/template-registry'

definePageMeta({ layout: 'platform' })

const templates = listPublishedTemplateMarketing()

const config = useRuntimeConfig()
const organizationUrl = config.public.siteUrl

// A page about the business: its image is the organization's.
const { social_image: organizationSocialImage, template: organizationTemplate } = useTenantOrganization().organization
if (organizationTemplate.slug !== 'platform') throw createError({ statusCode: 404, statusMessage: 'Page not found', fatal: true })
useSocialMetadata({
  path: '/templates',
  socialImage: organizationSocialImage,
  title: 'Templates',
  description: 'Browse Krabiclaw templates — Saya for restaurants and experiences, Blawby for professional services. Pick a template, connect ChatGPT, go live.',
  schemaPageType: 'CollectionPage',
  breadcrumbs: [
    { name: 'Home', url: '/' },
    { name: 'Templates', url: '/templates' },
  ],
  schemaNodes: [
    {
      '@type': 'ItemList',
      '@id': `${organizationUrl}/templates#themes`,
      name: 'Krabiclaw Templates',
      itemListElement: templates.map((template, index) => ({
        '@type': 'ListItem',
        position: index + 1,
        item: {
          '@type': 'Product',
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
      })),
    },
  ],
})
</script>
