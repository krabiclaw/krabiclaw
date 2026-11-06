<template>
  <NuxtLayout :name="site.layout">
    <TenantContact v-if="legalPractice" />

    <!-- Brand contact page (tenant sites only — the platform marketing contact page was retired in favor of /help) -->
    <div v-else>

      <!-- Brand contact layout — shows for all tenant shapes -->
      <div>
        <!-- Page header -->
        <header v-if="contactHeroEyebrow || contactHeroTitle || contactHeroSummary" class="tenant-container pt-16 pb-12">
          <p v-if="contactHeroEyebrow" class="tenant-kicker mb-6">{{ contactHeroEyebrow }}</p>
          <h1 v-if="contactHeroTitle" class="tenant-display-md text-default">
            {{ contactHeroTitle }}
          </h1>
          <p v-if="contactHeroSummary" class="mt-5 max-w-xl text-sm leading-relaxed text-muted">
            {{ contactHeroSummary }}
          </p>
        </header>

        <!-- Top grid: form (wide) + dark aside -->
        <div
          class="tenant-container grid gap-6 pb-6"
          :class="hasAnyBrandContact ? 'lg:grid-cols-[1.6fr_1fr]' : 'lg:grid-cols-1'"
        >

          <!-- MESSAGE FORM -->
          <section class="border border-default bg-default p-10 lg:p-11">
            <p class="tenant-eyebrow mb-4 text-muted">{{ t('site.contact_page.send_message') }}</p>
            <h2 class="tenant-display tenant-italic text-3xl text-default">{{ formHeading }}</h2>
            <p class="mt-4 text-sm leading-relaxed text-muted">{{ formSubtitle }}</p>

            <div class="mt-10">
              <TenantInquiryForm :key="aboutProduct" :subjects="subjectOptions" :initial-message="aboutPrefix" :disabled="isDraftPreview" />
            </div>
          </section>

          <!-- DARK ASIDE: brand contact — hidden when no emails are configured -->
          <aside v-if="hasAnyBrandContact" class="bg-inverted p-10 text-inverted lg:p-11">
            <p class="tenant-eyebrow mb-4 text-inverted/60">{{ t('site.contact_page.brand_inquiries') }}</p>
            <h2 class="tenant-display tenant-italic text-3xl text-inverted">{{ t('site.contact_page.reach_us_direct') }}</h2>

            <dl class="mt-8 space-y-0">
              <div v-if="siteConfig.press_email" class="flex justify-between gap-4 border-b border-inverted/10 py-4">
                <dt class="tenant-eyebrow text-inverted/60">{{ t('site.contact_page.press') }}</dt>
                <dd class="m-0 tenant-display tenant-italic"><a :href="`mailto:${siteConfig.press_email}`" class="border-b border-inverted/30 pb-px text-inverted no-underline">{{ siteConfig.press_email }}</a></dd>
              </div>
              <div v-if="siteConfig.partnerships_email" class="flex justify-between gap-4 border-b border-inverted/10 py-4">
                <dt class="tenant-eyebrow text-inverted/60">{{ t('site.contact_page.partnerships') }}</dt>
                <dd class="m-0 tenant-display tenant-italic"><a :href="`mailto:${siteConfig.partnerships_email}`" class="border-b border-inverted/30 pb-px text-inverted no-underline">{{ siteConfig.partnerships_email }}</a></dd>
              </div>
              <div v-if="siteConfig.catering_email" class="flex justify-between gap-4 border-b border-inverted/10 py-4">
                <dt class="tenant-eyebrow text-inverted/60">{{ vertCopy.contactSubjectCatering }}</dt>
                <dd class="m-0 tenant-display tenant-italic"><a :href="`mailto:${siteConfig.catering_email}`" class="border-b border-inverted/30 pb-px text-inverted no-underline">{{ siteConfig.catering_email }}</a></dd>
              </div>
              <div v-if="siteConfig.careers_email" class="flex justify-between gap-4 border-b border-inverted/10 py-4">
                <dt class="tenant-eyebrow text-inverted/60">{{ t('site.contact_page.careers') }}</dt>
                <dd class="m-0 tenant-display tenant-italic"><a :href="`mailto:${siteConfig.careers_email}`" class="border-b border-inverted/30 pb-px text-inverted no-underline">{{ siteConfig.careers_email }}</a></dd>
              </div>
            </dl>

          </aside>
        </div>

        <TenantPageRenderer
          v-if="contactAdditionalPage?.blocks.length"
          :page="contactAdditionalPage"
        />
      </div>
    </div>

  </NuxtLayout>
</template>

<script setup lang="ts">
import TenantInquiryForm from '~/components/tenant/TenantInquiryForm.vue'

definePageMeta({ layout: false })

const { previewAuthorized, organization } = useTenantOrganization()
const { site } = organization
const isPlatform = organization.site.slug === 'platform'
if (isPlatform) throw createError({ statusCode: 404 })
// A legal practice's contact page is its authored page; a venue's is this form and its branches.
const legalPractice = isLegalPractice(organization.vertical)

const { locale, t } = useI18n()
const vertCopy = computed(() => getVerticalCopy(organization.vertical, locale.value))

const businessName = organization.name
// A preview is the real site, so the form is real too — but an owner looking
// at an unlaunched site should not be able to file a guest thread against it.
const isDraftPreview = computed(() => previewAuthorized)

// ── Bootstrap: config + tenant page in one call ───────────
const { config: siteConfig, tenantPage } = await usePublicPageData()
const contactHero = computed(() => tenantPage.value?.blocks.find(block => block.type === 'hero') ?? null)
const contactHeroEyebrow = computed(() => String(contactHero.value?.data.eyebrow || ''))
const contactHeroTitle = computed(() => String(contactHero.value?.data.title || tenantPage.value?.title || t('site.contact_page.headline') || ''))
const contactHeroSummary = computed(() => String(contactHero.value?.data.subtitle || contactHero.value?.data.description || tenantPage.value?.summary || ''))
const contactAdditionalPage = computed(() => tenantPage.value
  ? { ...tenantPage.value, blocks: tenantPage.value.blocks.filter(block => block.type !== 'hero') }
  : null)

const hasAnyBrandContact = computed(() =>
  siteConfig.value.press_email || siteConfig.value.partnerships_email ||
  siteConfig.value.catering_email || siteConfig.value.careers_email
)

// A guest arriving from a product priced in words has the product named for
// them: the first line of their message is what they clicked, in the site's
// language, and the rest is theirs to write.
const route = useRoute()
const aboutProduct = computed(() => (typeof route.query.about === 'string' ? route.query.about.trim().slice(0, 120) : ''))
const aboutPrefix = computed(() => (aboutProduct.value ? `${t('site.contact_page.about_product', { product: aboutProduct.value })}\n\n` : ''))

const formHeading = computed(() => {
  if (aboutProduct.value) {
    return t('site.contact_page.about_product', { product: aboutProduct.value })
  }
  return t('site.contact_page.headline')
})

const formSubtitle = computed(() => vertCopy.value.contactSubtitle)

// ── Tenant form ──────────────────────────────────────────
const subjectOptions = computed(() => {
  if (organization.vertical === 'lodging') {
    return [
      { key: 'general', label: t('site.contact_page.general') },
      { key: 'catering', label: vertCopy.value.contactSubjectCatering },
      { key: 'partnerships', label: t('site.contact_page.partnerships') },
      { key: 'press', label: t('site.contact_page.press') },
    ]
  }
  return [
    { key: 'general', label: t('site.contact_page.general') },
    { key: 'press', label: t('site.contact_page.press') },
    { key: 'partnerships', label: t('site.contact_page.partnerships') },
    { key: 'catering', label: vertCopy.value.contactSubjectCatering },
    { key: 'careers', label: t('site.contact_page.careers') },
  ]
})
// ── SEO ──────────────────────────────────────────────────
// A page about the business: its image is the organization's.
useSocialMetadata(() => ({
  path: '/contact',
  socialImage: organization.social_image,
  title: tenantPage.value?.title || businessName,
  description: tenantPage.value?.summary || '',
  schemaPageType: 'ContactPage',
  breadcrumbs: [
    { name: tenantPage.value?.title || 'Contact', url: '/contact' },
  ],
}))
</script>
