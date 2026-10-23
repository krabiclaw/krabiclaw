<template>
  <div class="template-page">
    <Teleport to="body">
      <div v-if="isDemoPreviewOpen" ref="previewDialogRef" class="template-preview" role="dialog" aria-modal="true" :aria-label="`${template.displayName} template demo preview`">
        <div class="template-preview__bar">
          <button ref="closePreviewButtonRef" type="button" class="template-preview__close" aria-label="Close demo preview" @click="closeDemoPreview">
            <PlatformIcon name="x" class="size-5" />
          </button>
          <img v-if="template.logoUrl" :src="template.logoUrl" width="32" height="32" :alt="`${template.displayName} logo`" class="template-preview__logo">
          <div class="template-preview__name">
            <p>{{ template.displayName }}</p>
            <span>{{ template.priceLabel }}</span>
          </div>
          <PlatformAccountCta :to="template.ctaTo" :label="template.ctaLabel" size="md" class="template-preview__start" />
        </div>
        <iframe :src="demoUrl" class="template-preview__site" :title="`${template.displayName} template live demo`" />
      </div>
    </Teleport>

    <div :inert="isDemoPreviewOpen">
      <section v-if="isNclsShowcase" class="theme-intro theme-intro--law">
        <div class="theme-intro__copy">
          <NuxtLink to="/templates" class="theme-back">← All templates</NuxtLink>
          <p class="theme-eyebrow">{{ template.displayName }} / Websites for lawyers</p>
          <h1>{{ template.tagline }}</h1>
          <p class="theme-intro__summary">{{ template.summary }}</p>
          <div class="theme-actions">
            <PlatformAccountCta :to="template.ctaTo" :label="template.ctaLabel" size="xl" class="theme-start" />
            <button type="button" class="theme-text-action" @click="openDemoPreview">View live customer site <span aria-hidden="true">↗</span></button>
          </div>
          <p class="theme-note">{{ template.priceLabel }}</p>
        </div>
        <figure class="theme-intro__painting">
          <img :src="template.artworkUrl" width="1122" height="1402" alt="A warmly lit law office, painted in indigo and coral" fetchpriority="high" decoding="async">
        </figure>
      </section>

      <section v-else class="theme-intro theme-intro--saya">
        <div class="theme-intro__top">
          <div>
            <NuxtLink to="/templates" class="theme-back">← All templates</NuxtLink>
            <p class="theme-eyebrow">{{ template.displayName }} / {{ template.supportedVerticals.join(', ') }}</p>
            <h1>{{ template.tagline }}</h1>
          </div>
          <div class="theme-intro__copy">
            <p class="theme-intro__summary">{{ template.summary }}</p>
            <div class="theme-actions">
              <PlatformAccountCta :to="template.ctaTo" :label="template.ctaLabel" size="xl" class="theme-start" />
              <button type="button" class="theme-text-action" @click="openDemoPreview">View live demo <span aria-hidden="true">↗</span></button>
              <NuxtLink to="/lodging" class="theme-text-action">Explore lodging websites <span aria-hidden="true">↗</span></NuxtLink>
            </div>
            <p class="theme-note">{{ template.priceLabel }}</p>
          </div>
        </div>
        <figure class="theme-saya-preview">
          <img :src="template.previewImageUrl" width="2048" height="1340" alt="Kikuzuki restaurant’s Saya website, with its menu, experiences, and location links" fetchpriority="high" decoding="async" class="theme-saya-preview__desktop">
          <img src="/images/products/pottery-phone.png" width="946" height="1884" alt="Pottery House Krabi’s Saya website on a phone" decoding="async" class="theme-saya-preview__phone">
          <figcaption>Real places, made with Saya. Kikuzuki & Pottery House Krabi.</figcaption>
        </figure>
      </section>

      <section class="theme-story" :class="{ 'theme-story--law': isNclsShowcase }">
        <div class="theme-story__heading">
          <p class="theme-eyebrow">{{ isNclsShowcase ? 'Built around your practice' : 'A welcome that feels like you' }}</p>
          <h2>{{ isNclsShowcase ? 'Make the first step\nfeel straightforward.' : 'Tell the story\nbehind the visit.' }}</h2>
        </div>
        <p class="theme-story__body">{{ template.description }}</p>
        <figure v-if="isNclsShowcase" class="theme-customer">
          <button type="button" :aria-label="template.demoLabel" @click="openDemoPreview">
            <img :src="template.previewImageUrl" width="2048" height="1466" alt="North Carolina Legal Services’ live Blawby website, with a clear consultation call to action" loading="lazy" decoding="async">
          </button>
          <figcaption><span>North Carolina Legal Services · A live customer website built with Blawby.</span><button type="button" class="theme-text-action" @click="openDemoPreview">Explore the site <span aria-hidden="true">↗</span></button></figcaption>
        </figure>
        <figure v-else class="theme-story__art">
          <img :src="template.artworkUrl" width="1536" height="1024" alt="Food and hands-on craft, painted in warm coral and indigo" loading="lazy" decoding="async">
        </figure>
      </section>

      <section class="theme-features">
        <div class="theme-features__intro">
          <p class="theme-eyebrow">Made for your day to day</p>
          <h2>{{ isNclsShowcase ? 'A website with\nyour clients in mind.' : 'The details that\nbring people in.' }}</h2>
        </div>
        <ol class="theme-features__list">
          <li v-for="(feature, index) in template.features" :key="feature.label">
            <span class="theme-features__number">0{{ index + 1 }}</span>
            <div><h3>{{ feature.label }}</h3><p>{{ feature.description }}</p></div>
          </li>
        </ol>
      </section>

      <section class="theme-included">
        <div>
          <p class="theme-eyebrow">Your starting point</p>
          <h2>Ready to make yours.</h2>
          <p>Both templates are included on every plan. Start free with two locations. Add your own domain on Growth or Business. Payment features require Business and provider setup.</p>
          <NuxtLink to="/pricing" class="theme-text-action">See plans and what’s included <span aria-hidden="true">↗</span></NuxtLink>
        </div>
        <ul><li v-for="item in template.included" :key="item">{{ item }}</li></ul>
      </section>

      <section class="theme-connect">
        <div>
          <p class="theme-eyebrow">Keep it current</p>
          <h2>Your next update<br>starts with a conversation.</h2>
          <p>Use the dashboard, or connect ChatGPT, Claude, or another compatible MCP client to manage your website with the AI assistant you already use.</p>
          <NuxtLink to="/plugin" class="theme-text-action">Explore AI connections <span aria-hidden="true">↗</span></NuxtLink>
        </div>
        <div class="theme-connect__start">
          <p>Start with {{ template.displayName }}.<br>Make it your own.</p>
          <PlatformAccountCta :to="template.ctaTo" :label="template.ctaLabel" size="xl" class="theme-start" />
          <button type="button" class="theme-text-action" @click="openDemoPreview">{{ template.demoLabel }} <span aria-hidden="true">↗</span></button>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { findPublishedTemplateMarketing } from '~/utils/template-registry'
import { tenantOrganizationOrigin } from '~/utils/tenant-organization-origin'

// Keyed by full path so navigating directly between two template slugs (e.g.
// /templates/saya -> /templates/blawby) remounts the page instead of Vue
// Router reusing the instance — template/isNclsShowcase/demoUrl are all
// computed once at setup from route.params.slug, so without this key a
// same-component slug change would silently keep showing the old template.
definePageMeta({ layout: 'platform', key: route => route.fullPath })

const route = useRoute()
const slug = String(route.params.slug ?? '')

// These code-owned routes read the canonical theme marketing registry.
// Unknown or unpublished slugs 404 immediately.
const template = findPublishedTemplateMarketing(slug)

if (!template) {
  throw createError({ statusCode: 404, statusMessage: 'Template not found', fatal: true })
}

const config = useRuntimeConfig()
const isDemoPreviewOpen = ref(false)
const previewDialogRef = ref<HTMLElement | null>(null)
const closePreviewButtonRef = ref<HTMLButtonElement | null>(null)
let previewTrigger: HTMLElement | null = null

const isNclsShowcase = template.slug === 'blawby'

// The shared resolver addresses the existing demo tenant in this environment,
// including local ports and staging aliases. Blawby keeps its approved showcase.
const demoUrl = computed(() => {
  if (template.demoUrl) return template.demoUrl
  const origin = tenantOrganizationOrigin({
    platformDomain: config.public.platformDomain,
    freeOrganizationDomain: config.public.freeOrganizationDomain,
    subdomain: 'demo',
  })
  if (!origin) throw createError({ statusCode: 500, statusMessage: 'NUXT_PUBLIC_FREE_ORGANIZATION_DOMAIN is required' })
  return origin
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

<style scoped>
.template-page { background: #f6f4ef; color: #171920; }
.theme-intro, .theme-story, .theme-features, .theme-included, .theme-connect { padding: clamp(4rem, 7.5vw, 7.5rem) max(7%, calc((100% - 86rem) / 2)); }
.theme-eyebrow { color: #945448; text-transform: uppercase; letter-spacing: .15em; font-size: .75rem; font-weight: 600; margin: 0 0 1.5rem; }
.theme-back { display: inline-block; color: #65666e; font-size: .85rem; text-decoration: none; margin-bottom: 3.5rem; }
.theme-back:hover { text-decoration: underline; }
.theme-intro h1 { margin: 0; font-size: clamp(3.4rem, 6.7vw, 6.7rem); line-height: 1.02; font-weight: 400; letter-spacing: -.055em; white-space: pre-line; text-wrap: balance; }
.theme-intro__summary { max-width: 32rem; color: #62646c; font-size: clamp(1.1rem, 1.6vw, 1.45rem); line-height: 1.6; margin: 2rem 0; }
.theme-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 1rem 1.75rem; }
.theme-text-action { display: inline-flex; align-items: center; gap: .8rem; padding: .4rem 0; border: 0; border-bottom: 1px solid currentColor; background: transparent; color: #944537; font-size: .95rem; font-weight: 500; text-decoration: none; cursor: pointer; }
.theme-text-action:hover { opacity: .75; }
.theme-note { margin: 1.25rem 0 0; color: #75757a; font-size: .85rem; }
.template-page :deep(.theme-start) { background: #171b31; color: #fff; border-radius: 999px; padding: 1rem 1.75rem; }
.theme-intro--law { display: grid; grid-template-columns: 1.15fr 1fr; align-items: center; gap: 5%; padding-top: 3rem; padding-bottom: 3rem; }
.theme-intro--law .theme-intro__copy { padding-bottom: 2rem; }
.theme-intro__painting { margin: 0; height: clamp(34rem, 53vw, 50rem); }
.theme-intro__painting img { display: block; width: 100%; height: 100%; object-fit: cover; }
.theme-intro--saya { background: #161c32; color: #f8f7f3; padding-top: 3rem; padding-bottom: 4rem; }
.theme-intro--saya .theme-back, .theme-intro--saya .theme-note { color: #b9bdcc; }
.theme-intro--saya .theme-eyebrow, .theme-intro--saya .theme-text-action { color: #ffab98; }
.theme-intro--saya :deep(.theme-start) { background: #f8f7f3; color: #171b31; }
.theme-intro__top { display: grid; grid-template-columns: 1.3fr 1fr; gap: 4rem; align-items: end; }
.theme-intro--saya .theme-intro__summary { color: #c5c8d2; margin-top: 0; }
.theme-intro--saya h1 { font-size: clamp(3.2rem, 6vw, 6rem); }
.theme-saya-preview { position: relative; margin: 4rem 3rem 0 0; padding-right: 14%; padding-bottom: 2.5rem; }
.theme-saya-preview__desktop { display: block; width: 100%; height: auto; }
.theme-saya-preview__phone { position: absolute; right: 0; bottom: 4rem; width: 22%; height: auto; box-shadow: 0 1rem 2rem #0005; }
.theme-saya-preview figcaption { margin-top: 1rem; color: #b9bdcc; font-size: .85rem; }
.theme-story { display: grid; grid-template-columns: 1fr 1fr; gap: 2rem 5rem; align-items: center; }
.theme-story h2, .theme-features h2, .theme-included h2, .theme-connect h2 { margin: 0; font-size: clamp(2.5rem, 4.7vw, 4.7rem); font-weight: 400; letter-spacing: -.045em; line-height: 1.05; white-space: pre-line; text-wrap: balance; }
.theme-story__body { grid-column: 2; color: #62646c; font-size: clamp(1.1rem, 1.6vw, 1.45rem); line-height: 1.6; margin: 0; }
.theme-story__art { grid-column: 1; grid-row: 1 / 3; margin: 0; }
.theme-story__art img { display: block; width: 100%; height: auto; }
.theme-story:not(.theme-story--law) .theme-story__heading { grid-column: 2; }
.theme-customer { grid-column: 1 / -1; margin: 2rem 0 0; }
.theme-customer > button { display: block; width: 100%; padding: 3rem 8%; border: 0; background: #d9dfe6; cursor: pointer; }
.theme-customer img { display: block; width: 100%; height: auto; box-shadow: 0 1rem 2rem #17192024; }
.theme-customer figcaption { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 1rem; color: #62646c; font-size: .85rem; padding-top: 1rem; }
.theme-features { display: grid; grid-template-columns: 1fr 1.1fr; gap: 6rem; background: #e9e6de; }
.theme-features__intro { align-self: start; }
.theme-features__list { margin: 0; padding: 0; list-style: none; }
.theme-features__list li { display: grid; grid-template-columns: 2rem 1fr; gap: 1.5rem; padding: 2rem 0; border-top: 1px solid #c8c5bf; }
.theme-features__list li:first-child { padding-top: 0; border-top: 0; }
.theme-features__number { color: #945448; font-size: .85rem; padding-top: .35rem; }
.theme-features h3 { font-size: clamp(1.4rem, 2.4vw, 2rem); font-weight: 400; letter-spacing: -.025em; line-height: 1.2; margin: 0; }
.theme-features__list p { color: #62646c; font-size: 1.05rem; line-height: 1.65; margin: 1rem 0 0; }
.theme-included { display: grid; grid-template-columns: 1fr 1fr; gap: 6rem; }
.theme-included h2 { font-size: clamp(2.5rem, 4vw, 4rem); }
.theme-included p:not(.theme-eyebrow) { max-width: 32rem; color: #62646c; font-size: 1.1rem; line-height: 1.65; margin: 1.5rem 0; }
.theme-included ul { list-style: none; padding: 0; margin: 0; }
.theme-included li { padding: 1.1rem 0; border-bottom: 1px solid #d4d1c9; font-size: 1.05rem; }
.theme-included li:first-child { border-top: 1px solid #d4d1c9; }
.theme-connect { display: grid; grid-template-columns: 1.2fr 1fr; gap: 6rem; background: #161c32; color: #f8f7f3; }
.theme-connect .theme-eyebrow, .theme-connect .theme-text-action { color: #ffab98; }
.theme-connect h2 { font-size: clamp(2.5rem, 4vw, 4rem); }
.theme-connect p:not(.theme-eyebrow) { max-width: 32rem; color: #c5c8d2; font-size: 1.1rem; line-height: 1.65; margin: 1.5rem 0; }
.theme-connect__start { align-self: end; padding-left: 3rem; border-left: 1px solid #ffffff29; }
.theme-connect .theme-connect__start p { font-size: 1.75rem; line-height: 1.3; letter-spacing: -.025em; }
.theme-connect :deep(.theme-start) { display: table; background: #f8f7f3; color: #171b31; margin-bottom: 1rem; }
.template-preview { position: fixed; inset: 0; z-index: 100; display: flex; flex-direction: column; background: #0b0d13; }
.template-preview__bar { display: flex; flex-wrap: wrap; flex: none; align-items: center; gap: .75rem; padding: .75rem 1rem; border-bottom: 1px solid #ffffff29; color: white; }
.template-preview__close { display: inline-flex; align-items: center; justify-content: center; width: 2.5rem; height: 2.5rem; border: 1px solid #ffffff4d; border-radius: 50%; background: transparent; color: white; cursor: pointer; }
.template-preview__close:hover { background: #ffffff1a; }
.template-preview__logo { width: 2rem; height: 2rem; object-fit: contain; }
.template-preview__name p { margin: 0; font-size: .9rem; font-weight: 600; }
.template-preview__name span { font-size: .75rem; color: #b9bdcc; }
.template-preview__start { margin-left: auto; }
.template-preview__site { display: block; width: 100%; flex: 1; min-height: 0; border: 0; background: white; }
@media (max-width: 767px) {
  .theme-intro--law, .theme-intro__top, .theme-story, .theme-features, .theme-included, .theme-connect { grid-template-columns: 1fr; gap: 2.5rem; }
  .theme-intro--law { padding-top: 2rem; }
  .theme-back { margin-bottom: 2.5rem; }
  .theme-intro__painting { height: auto; }
  .theme-intro__painting img { height: auto; }
  .theme-intro__top { gap: 1.5rem; }
  .theme-saya-preview { margin: 3rem 0 0; padding-bottom: 1rem; }
  .theme-saya-preview__phone { width: 26%; bottom: 4rem; }
  .theme-saya-preview figcaption { max-width: 75%; font-size: .75rem; }
  .theme-story__body, .theme-story:not(.theme-story--law) .theme-story__heading, .theme-story__art, .theme-customer { grid-column: auto; grid-row: auto; }
  .theme-story__art { order: 3; }
  .theme-customer { margin-top: 0; }
  .theme-customer > button { padding: 1.25rem; }
  .theme-connect__start { padding: 2rem 0 0; border-left: 0; border-top: 1px solid #ffffff29; }
  .template-preview__name { min-width: 0; flex: 1; }
  .template-preview__logo { display: none; }
}
</style>
