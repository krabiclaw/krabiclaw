<template>
  <div class="templates-page">
    <section class="templates-intro">
      <div class="templates-intro__heading">
        <p class="templates-eyebrow">Website templates</p>
        <h1>Your business.<br>Its own kind of beautiful.</h1>
      </div>
      <div class="templates-intro__copy">
        <p>A table worth booking. An experience worth finding. A lawyer you can trust. Start with a website that understands your business.</p>
        <PlatformAccountCta label="Start free" size="xl" class="template-start" />
        <p class="templates-note">Both templates are included on every plan.</p>
      </div>
    </section>

    <section class="templates-collection" aria-label="Choose a website template">
      <article v-for="(template, index) in templates" :key="template.slug" class="template-row" :class="`template-row--${template.slug}`">
        <div class="template-row__copy">
          <p class="templates-eyebrow">0{{ index + 1 }} / {{ template.supportedVerticals.join(' & ') }}</p>
          <h2>{{ template.displayName }}</h2>
          <p class="template-row__tagline">{{ template.tagline }}</p>
          <p class="template-row__summary">{{ template.summary }}</p>
          <NuxtLink :to="`/templates/${template.slug}`" class="templates-link">Explore {{ template.displayName }} <span aria-hidden="true">↗</span></NuxtLink>
        </div>
        <NuxtLink :to="`/templates/${template.slug}`" class="template-row__visual" :aria-label="`Explore the ${template.displayName} website template`">
          <img :src="template.previewImageUrl" width="2048" :height="template.slug === 'saya' ? 1340 : 1466" :alt="template.slug === 'saya' ? 'Kikuzuki restaurant website, built with Saya' : 'North Carolina Legal Services website, built with Blawby'" loading="lazy" decoding="async" class="template-row__desktop">
          <img v-if="template.slug === 'saya'" src="/images/products/pottery-phone.png" width="946" height="1884" alt="Pottery House Krabi experience website on a phone, built with Saya" loading="lazy" decoding="async" class="template-row__phone">
        </NuxtLink>
      </article>
    </section>

    <section class="templates-more">
      <div>
        <p class="templates-eyebrow">A familiar way to make it yours</p>
        <h2>Your website.<br>Your AI assistant.</h2>
      </div>
      <div class="templates-more__copy">
        <p>Choose your template, add your story, and keep it current from the dashboard or a connected AI assistant. KrabiClaw works with ChatGPT, Claude, and other compatible MCP clients.</p>
        <NuxtLink to="/plugin" class="templates-link">Explore AI connections <span aria-hidden="true">↗</span></NuxtLink>
        <NuxtLink to="/pricing" class="templates-more__pricing">Compare plans and what’s included →</NuxtLink>
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
  description: 'Website templates for restaurants, experiences, and law firms. Explore Saya and Blawby, see real customer websites, and start free with KrabiClaw.',
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

<style scoped>
.templates-page { background: #f6f4ef; color: #171920; }
.templates-intro, .templates-collection, .templates-more { width: min(86%, 86rem); margin: auto; }
.templates-intro { display: grid; grid-template-columns: 1.35fr 1fr; gap: 4rem; align-items: end; padding: clamp(5rem, 9vw, 9rem) 0 clamp(4rem, 7vw, 7rem); }
.templates-eyebrow { margin: 0 0 1.75rem; color: #945448; font-size: .75rem; font-weight: 600; letter-spacing: .15em; text-transform: uppercase; }
.templates-intro h1 { max-width: 12ch; margin: 0; font-size: clamp(3.2rem, 6.6vw, 6.6rem); font-weight: 400; line-height: 1.02; letter-spacing: -.055em; text-wrap: balance; }
.templates-intro__copy { max-width: 28rem; padding-bottom: .25rem; }
.templates-intro__copy > p:first-child, .templates-more__copy > p { margin: 0 0 2rem; color: #61636a; font-size: clamp(1.1rem, 1.7vw, 1.5rem); line-height: 1.55; }
.templates-intro :deep(.template-start) { background: #171b31; color: #fff; border-radius: 999px; padding: 1rem 1.75rem; }
.templates-note { color: #75757a; font-size: .85rem; margin: 1rem 0 0; }
.template-row { display: grid; grid-template-columns: .8fr 1.2fr; align-items: center; gap: 5rem; padding: 5rem 0 7rem; border-top: 1px solid #d4d1c9; }
.template-row__copy h2 { margin: 0; font-size: clamp(2.5rem, 4vw, 4rem); font-weight: 400; line-height: 1.05; letter-spacing: -.04em; }
.template-row__tagline { margin: 1.25rem 0; font-size: clamp(1.6rem, 2.7vw, 2.6rem); line-height: 1.15; letter-spacing: -.035em; white-space: pre-line; }
.template-row__summary { margin: 0; max-width: 28rem; color: #61636a; font-size: 1.1rem; line-height: 1.65; }
.templates-link { display: inline-flex; gap: 1.5rem; align-items: center; padding: .5rem 0; margin-top: 1.5rem; border-bottom: 1px solid currentColor; color: #944537; font-weight: 500; text-decoration: none; }
.templates-link:hover { color: #5e3027; }
.template-row__visual { position: relative; display: block; min-width: 0; padding: 2.5rem 2.5rem 3rem 1rem; background: #e4e5e5; }
.template-row__desktop { display: block; width: 100%; height: auto; box-shadow: 0 1rem 2rem #1719201c; }
.template-row--saya .template-row__visual { padding-right: 5rem; padding-bottom: 5rem; background: #dfdace; }
.template-row__phone { position: absolute; right: -.6rem; bottom: -1.25rem; width: 28%; height: auto; box-shadow: 0 1rem 2rem #17192024; }
.template-row--blawby { grid-template-columns: 1.2fr .8fr; }
.template-row--blawby .template-row__visual { grid-column: 1; grid-row: 1; padding: 2.5rem 1rem 2.5rem 2.5rem; background: #d7dce4; }
.template-row--blawby .template-row__copy { grid-column: 2; grid-row: 1; }
.templates-more { display: grid; grid-template-columns: 1fr 1fr; gap: 5rem; border-top: 1px solid #d4d1c9; padding: clamp(4rem, 7vw, 7rem) 0; }
.templates-more h2 { margin: 0; font-size: clamp(2.6rem, 4.6vw, 4.6rem); font-weight: 400; line-height: 1.05; letter-spacing: -.045em; }
.templates-more__copy { max-width: 32rem; align-self: end; }
.templates-more__copy > p { margin-bottom: 0; }
.templates-more__pricing { display: block; width: fit-content; margin-top: 2rem; color: #61636a; font-size: .95rem; text-decoration: none; }
.templates-more__pricing:hover { text-decoration: underline; }
@media (max-width: 767px) {
  .templates-intro, .template-row, .template-row--blawby, .templates-more { grid-template-columns: 1fr; gap: 2.5rem; }
  .templates-intro { padding-top: 4rem; }
  .templates-intro h1 { max-width: 13ch; }
  .template-row { padding: 3.5rem 0 5rem; }
  .template-row__visual { padding: 1.5rem; }
  .template-row--saya .template-row__visual { padding: 1.5rem 3rem 3.5rem 1rem; }
  .template-row--blawby .template-row__copy, .template-row--blawby .template-row__visual { grid-column: auto; grid-row: auto; }
  .template-row--blawby .template-row__visual { padding: 1.5rem; }
  .templates-more { padding: 4rem 0; }
}
</style>
