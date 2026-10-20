<template>
  <NuxtLayout :name="template.layout">
    <TenantContact v-if="template.slug === 'blawby'" />

    <!-- Brand contact page (tenant sites only — the platform marketing contact page was retired in favor of /help) -->
    <div v-else>

      <!-- Brand contact layout — shows for all tenant shapes -->
      <div>
        <!-- Page header -->
        <header v-if="contactHeroEyebrow || contactHeroTitle || contactHeroSummary" class="mx-auto max-w-7xl px-4 pt-16 pb-12 sm:px-6 lg:px-8">
          <p v-if="contactHeroEyebrow" class="saya-kicker mb-6">{{ contactHeroEyebrow }}</p>
          <h1 v-if="contactHeroTitle" class="saya-display-md text-default">
            {{ contactHeroTitle }}
          </h1>
          <p v-if="contactHeroSummary" class="mt-5 max-w-xl text-sm leading-relaxed text-muted">
            {{ contactHeroSummary }}
          </p>
        </header>

        <!-- Top grid: form (wide) + dark aside -->
        <div
          class="mx-auto grid max-w-7xl gap-6 px-4 pb-6 sm:px-6 lg:px-8"
          :class="hasAnyBrandContact ? 'lg:grid-cols-[1.6fr_1fr]' : 'lg:grid-cols-1'"
        >

          <!-- MESSAGE FORM -->
          <section class="border border-default bg-default p-10 lg:p-11">
            <p class="saya-eyebrow mb-4 text-muted">{{ t('saya.contact_page.send_message') }}</p>
            <h2 class="saya-display saya-italic text-3xl text-default">{{ t('saya.contact_page.anything_not_location_specific') }}</h2>
            <p class="mt-4 text-sm leading-relaxed text-muted">{{ t('saya.contact_page.specific_questions') }}</p>

            <form class="mt-10 space-y-7" novalidate @submit.prevent="handleTenantContact">
              <div v-if="tenantSubmitError" role="alert" class="rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-3 text-sm text-red-500">
                {{ tenantSubmitError }}
              </div>

              <div class="grid gap-6 sm:grid-cols-2">
                <TenantFormField
                  v-slot="{ id, describedBy, invalid }"
                  :label="t('saya.contact_page.your_name')"
                  name="name"
                  required
                  :error="tenantFieldError('name')"
                >
                  <input :id="id" v-model="tenantForm.name" type="text" :class="inputClass" :aria-describedby="describedBy" :aria-invalid="invalid" />
                </TenantFormField>
                <TenantFormField
                  v-slot="{ id, describedBy, invalid }"
                  :label="t('saya.contact_page.email')"
                  name="email"
                  required
                  :error="tenantFieldError('email')"
                >
                  <input :id="id" v-model="tenantForm.email" type="email" :class="inputClass" :aria-describedby="describedBy" :aria-invalid="invalid" />
                </TenantFormField>
              </div>

              <TenantFormField :label="t('saya.contact_page.what_about')" name="subject">
                <div class="mt-2 flex flex-wrap gap-2">
                  <button
                    v-for="opt in subjectOptions"
                    :key="opt.key"
                    type="button"
                    :class="[
                      'rounded-full border px-4 py-2 text-xs font-medium uppercase tracking-widest transition',
                      tenantForm.subject === opt.key
                        ? 'border-inverted bg-inverted text-inverted'
                        : 'border-default bg-default text-muted hover:border-muted hover:text-default'
                    ]"
                    @click="tenantForm.subject = opt.key"
                  >
                    {{ opt.label }}
                  </button>
                </div>
              </TenantFormField>

              <TenantFormField
                v-slot="{ id, describedBy, invalid }"
                :label="t('saya.contact_page.your_message')"
                name="message"
                required
                :error="tenantFieldError('message')"
              >
                <textarea :id="id" v-model="tenantForm.message" rows="6" :class="inputClass" :aria-describedby="describedBy" :aria-invalid="invalid" />
              </TenantFormField>

              <TenantButton type="submit" :loading="tenantSubmitting" :disabled="isDraftPreview">
                {{ t('saya.contact_page.send_message') }}
              </TenantButton>
            </form>
          </section>

          <!-- DARK ASIDE: brand contact — hidden when no emails are configured -->
          <aside v-if="hasAnyBrandContact" class="bg-inverted p-10 text-inverted lg:p-11">
            <p class="saya-eyebrow mb-4 text-inverted/60">{{ t('saya.contact_page.brand_inquiries') }}</p>
            <h2 class="saya-display saya-italic text-3xl text-inverted">{{ t('saya.contact_page.reach_us_direct') }}</h2>

            <dl class="mt-8 space-y-0">
              <div v-if="siteConfig.press_email" class="flex justify-between gap-4 border-b border-inverted/10 py-4">
                <dt class="saya-eyebrow text-inverted/60">{{ t('saya.contact_page.press') }}</dt>
                <dd class="m-0 saya-display saya-italic"><a :href="`mailto:${siteConfig.press_email}`" class="border-b border-inverted/30 pb-px text-inverted no-underline">{{ siteConfig.press_email }}</a></dd>
              </div>
              <div v-if="siteConfig.partnerships_email" class="flex justify-between gap-4 border-b border-inverted/10 py-4">
                <dt class="saya-eyebrow text-inverted/60">{{ t('saya.contact_page.partnerships') }}</dt>
                <dd class="m-0 saya-display saya-italic"><a :href="`mailto:${siteConfig.partnerships_email}`" class="border-b border-inverted/30 pb-px text-inverted no-underline">{{ siteConfig.partnerships_email }}</a></dd>
              </div>
              <div v-if="siteConfig.catering_email" class="flex justify-between gap-4 border-b border-inverted/10 py-4">
                <dt class="saya-eyebrow text-inverted/60">{{ vertCopy.contactSubjectCatering }}</dt>
                <dd class="m-0 saya-display saya-italic"><a :href="`mailto:${siteConfig.catering_email}`" class="border-b border-inverted/30 pb-px text-inverted no-underline">{{ siteConfig.catering_email }}</a></dd>
              </div>
              <div v-if="siteConfig.careers_email" class="flex justify-between gap-4 border-b border-inverted/10 py-4">
                <dt class="saya-eyebrow text-inverted/60">{{ t('saya.contact_page.careers') }}</dt>
                <dd class="m-0 saya-display saya-italic"><a :href="`mailto:${siteConfig.careers_email}`" class="border-b border-inverted/30 pb-px text-inverted no-underline">{{ siteConfig.careers_email }}</a></dd>
              </div>
            </dl>

          </aside>
        </div>

        <!-- Per-location stack -->
        <section class="mt-24 bg-elevated">
          <div class="mx-auto max-w-7xl px-4 py-24 sm:px-6 lg:px-8">
            <div class="mb-12 max-w-2xl">
              <p class="saya-kicker mb-6">{{ t('saya.contact_page.by_location') }}</p>
              <h2 class="saya-display-md text-default">
                {{ vertCopy.contactLocationsByHeading }}
              </h2>
              <p class="mt-5 text-sm leading-relaxed text-muted">
                {{ vertCopy.contactLocationsByNote }}
              </p>
            </div>

            <div class="flex flex-col gap-6">
              <article
                v-for="loc in locations"
                :key="loc.id"
                class="grid overflow-hidden border border-default bg-default lg:grid-cols-[minmax(280px,360px)_1fr]"
              >
                <!-- Mini map -->
                <div class="aspect-4/3 bg-muted lg:aspect-auto lg:min-h-64">
                  <iframe
                    v-if="safeUrl(loc.map_embed_url)"
                    :src="safeUrl(loc.map_embed_url)"
                    :title="`${loc.title} on Google Maps`"
                    class="h-full w-full border-0"
                    style="filter:grayscale(0.12)"
                    loading="lazy"
                    referrerpolicy="strict-origin-when-cross-origin"
                    sandbox="allow-scripts allow-same-origin"
                  />
                  <div v-else class="flex h-full w-full items-center justify-center">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="size-8 text-muted">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M15 10.5a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
                      <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1 1 15 0Z" />
                    </svg>
                  </div>
                </div>

                <!-- Details -->
                <div class="flex flex-col gap-6 p-9">
                  <div class="flex flex-wrap items-start justify-between gap-4">
                    <div>
                      <p v-if="addressPlaceName(loc.address ?? null)" class="saya-eyebrow mb-2 text-muted">{{ addressPlaceName(loc.address ?? null) }}</p>
                      <h3 class="saya-display saya-italic text-4xl text-default leading-none">{{ loc.title }}</h3>
                    </div>
                    <div class="flex items-center gap-2 text-xs uppercase tracking-widest text-default">
                      <span class="size-1.5 rounded-full" :class="loc.is_open ? 'bg-green-400' : 'bg-zinc-400'" />
                      {{ loc.hours_today || '—' }}
                    </div>
                  </div>

                  <div class="grid grid-cols-2 gap-5 border-t border-default pt-6 sm:grid-cols-4">
                    <div>
                      <p class="saya-eyebrow mb-2 text-muted">{{ t('saya.contact_page.address') }}</p>
                      <p class="text-sm leading-relaxed text-default">{{ formatLocAddress(loc) }}</p>
                    </div>
                    <div v-if="loc.phone">
                      <p class="saya-eyebrow mb-2 text-muted">{{ t('saya.contact_page.phone') }}</p>
                      <a :href="`tel:${loc.phone}`" class="border-b border-default pb-px text-sm text-default no-underline hover:opacity-70">{{ formatPhone(loc.phone) }}</a>
                    </div>
                    <div v-if="loc.email">
                      <p class="saya-eyebrow mb-2 text-muted">{{ t('saya.contact_page.email') }}</p>
                      <a :href="`mailto:${loc.email}`" class="border-b border-default pb-px text-sm text-default no-underline hover:opacity-70 break-all">{{ loc.email }}</a>
                    </div>
                    <div v-if="loc.hours_today">
                      <p class="saya-eyebrow mb-2 text-muted">{{ t('saya.contact_page.today') }}</p>
                      <p class="text-sm text-default">{{ loc.hours_today }}</p>
                    </div>
                  </div>

                  <div class="flex flex-wrap items-center gap-3">
                    <NuxtLink
                      v-if="!loc.home_slug"
                      :to="localePath(`/locations/${loc.slug}/contact`)"
                      class="inline-flex items-center rounded-full bg-inverted px-5 py-2.5 text-[11px] font-medium uppercase tracking-widest text-inverted no-underline transition hover:opacity-80"
                    >
                      {{ t('saya.contact_page.plan_visit') }}
                    </NuxtLink>
                    <NuxtLink
                      :to="localePath(publicLocationPath(loc))"
                      class="inline-flex items-center rounded-full border border-default px-5 py-2.5 text-[11px] font-medium uppercase tracking-widest text-default no-underline transition hover:bg-muted"
                    >
                      {{ t('saya.contact_page.directions') }}
                    </NuxtLink>
                    <NuxtLink
                      v-if="vertCopy.ctaRoute && vertCopy.reservationExploreLabel"
                      :to="localePath(vertCopy.ctaRoute)"
                      class="inline-flex items-center rounded-full border border-default px-5 py-2.5 text-[11px] font-medium uppercase tracking-widest text-default no-underline transition hover:bg-muted"
                    >
                      {{ vertCopy.reservationExploreLabel }}
                    </NuxtLink>
                  </div>
                </div>
              </article>
            </div>
          </div>
        </section>

        <TenantPageRenderer
          v-if="contactAdditionalPage?.blocks.length"
          :page="contactAdditionalPage"
          template="saya"
        />
      </div>
    </div>

  </NuxtLayout>
</template>

<script setup lang="ts">
import { formatPhone } from '~/utils/phone'
import type { SubmissionMeasurement } from '~/composables/useOrganizationConversionTracking'

definePageMeta({ layout: false })

const { previewAuthorized, organization } = useTenantOrganization()
const { template, id: organizationId } = organization
const isPlatform = organization.template.slug === 'platform'
if (isPlatform) throw createError({ statusCode: 404 })

const { locale, localePath, t } = useI18n()
const vertCopy = computed(() => getVerticalCopy(organization.vertical, locale.value))
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// Plain-Tailwind form styling — replaces UInput/UTextarea's default look
// now that this page no longer depends on Nuxt UI (see SayaFormField.vue).
import { FORM_INPUT_CLASS } from '~/utils/form-constants'
import { addressPlaceName, formatPostalAddress, type PostalAddress } from '~/utils/postal-address'
import { publicLocationPath } from '~/utils/product-presentation'
const inputClass = FORM_INPUT_CLASS

const businessName = organization.name
// A preview is the real site, so the form is real too — but an owner looking
// at an unlaunched site should not be able to file a guest thread against it.
const isDraftPreview = computed(() => previewAuthorized)

// ── Bootstrap: locations + config in one call ─────────────
const { locations, config: siteConfig, tenantPage } = await usePublicPageData()
const contactHero = computed(() => tenantPage.value?.blocks.find(block => block.type === 'hero') ?? null)
const contactHeroEyebrow = computed(() => String(contactHero.value?.data.eyebrow || ''))
const contactHeroTitle = computed(() => String(contactHero.value?.data.title || tenantPage.value?.title || t('saya.contact_page.headline') || ''))
const contactHeroSummary = computed(() => String(contactHero.value?.data.subtitle || contactHero.value?.data.description || tenantPage.value?.summary || ''))
const contactAdditionalPage = computed(() => tenantPage.value
  ? { ...tenantPage.value, blocks: tenantPage.value.blocks.filter(block => block.type !== 'hero') }
  : null)

interface ContactLocation {
  address?: PostalAddress | null
}

interface TenantContactForm {
  name: string
  email: string
  subject: string
  message: string
}

interface TenantFieldError {
  name: keyof TenantContactForm
  message: string
}

function formatLocAddress(loc: ContactLocation) {
  return formatPostalAddress(loc.address ?? null)
}

function safeUrl(val: unknown): string | undefined {
  if (!val || typeof val !== 'string') return undefined
  try {
    const u = new URL(val.trim())
    return ['http:', 'https:'].includes(u.protocol) ? u.toString() : undefined
  } catch { return undefined }
}

const hasAnyBrandContact = computed(() =>
  siteConfig.value.press_email || siteConfig.value.partnerships_email ||
  siteConfig.value.catering_email || siteConfig.value.careers_email
)

// ── Tenant form ──────────────────────────────────────────
const subjectOptions = computed(() => [
  { key: 'general', label: t('saya.contact_page.general') },
  { key: 'press', label: t('saya.contact_page.press') },
  { key: 'partnerships', label: t('saya.contact_page.partnerships') },
  { key: 'catering', label: vertCopy.value.contactSubjectCatering },
  { key: 'careers', label: t('saya.contact_page.careers') }
])

// A guest arriving from a product priced in words has the product named for
// them: the first line of their message is what they clicked, in the site's
// language, and the rest is theirs to write.
const route = useRoute()
const aboutProduct = typeof route.query.about === 'string' ? route.query.about.trim().slice(0, 120) : ''
const aboutPrefix = aboutProduct ? `${t('saya.contact_page.about_product', { product: aboutProduct })}\n\n` : ''
const tenantForm = ref<TenantContactForm>({
  name: '',
  email: '',
  subject: 'general',
  message: aboutPrefix,
})
const tenantSubmitting = ref(false)
const { mirrorSubmission, pageEventId } = useOrganizationConversionTracking()
const tenantErrors = ref<TenantFieldError[]>([])
const tenantSubmitError = ref<string | null>(null)
const tenantFieldError = (name: keyof TenantContactForm) =>
  tenantErrors.value.find(error => error.name === name)?.message ?? null

const validateTenantContact = (state: TenantContactForm): TenantFieldError[] => {
  const errors: TenantFieldError[] = []
  if (!state.name) errors.push({ name: 'name', message: t('saya.contact_page.enter_name') })
  if (!state.email) errors.push({ name: 'email', message: t('saya.contact_page.enter_email') })
  else if (!emailPattern.test(state.email)) errors.push({ name: 'email', message: t('saya.contact_page.invalid_email') })
  // The prefilled product line is context, not the guest's message.
  const written = state.message.startsWith(aboutPrefix) ? state.message.slice(aboutPrefix.length) : state.message
  if (!written.trim()) errors.push({ name: 'message', message: t('saya.contact_page.enter_message') })
  return errors
}

const handleTenantContact = async () => {
  if (isDraftPreview.value) return
  if (!organizationId) {
    tenantSubmitError.value = t('saya.contact_page.message_failed')
    return
  }
  tenantSubmitError.value = null
  tenantErrors.value = validateTenantContact(tenantForm.value)
  if (tenantErrors.value.length > 0) return

  tenantSubmitting.value = true
  let submitted: { success: true; measurement?: SubmissionMeasurement }
  try {
    submitted = await publicApiMutation<{ success: true; measurement?: SubmissionMeasurement }>(`/api/public/contact`, {
      method: 'POST',
      body: { ...tenantForm.value, locale: locale.value, page_event_id: await pageEventId() },
      validate: (value): value is { success: true; measurement?: SubmissionMeasurement } => isRecord(value) && value.success === true,
    })
  } catch {
    tenantSubmitError.value = t('saya.contact_page.message_failed')
    tenantSubmitting.value = false
    return
  }
  mirrorSubmission('contact_submit', submitted.measurement)

  await navigateTo(localePath('/contact/confirmed'))
  tenantSubmitting.value = false
}

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
