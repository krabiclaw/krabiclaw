<template>
  <!-- The bottom bar every site footer ends with. It carries no colour of its
       own: each footer's palette is inherited, and hover dims what it gave.
       Stacked on a phone — identity first, then the controls — and one row
       from sm up. -->
  <div class="flex flex-col gap-5 text-xs">
  <!-- Shopify's row of cards and wallets: what the business's Stripe settings take, each as its own mark. -->
  <ul v-if="paymentBadges.length" class="m-0 flex list-none flex-wrap gap-2 p-0" :aria-label="t('legal.payment_methods')">
    <li v-for="badge in paymentBadges" :key="badge.icon" class="flex h-6 w-10 items-center justify-center rounded border border-default bg-white" :class="badge.tint" :title="badge.label">
      <UIcon :name="badge.icon" class="h-3.5 w-7" :class="badge.iconClass" :aria-label="badge.label" />
    </li>
  </ul>
  <div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
    <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
      <p class="m-0">{{ t('legal.copyright', { year, name }) }}</p>
      <!-- The accounts the owner connected in Integrations, and only those. -->
      <div v-if="socialProfiles.length" class="flex items-center gap-3">
        <a
          v-for="profile in socialProfiles"
          :key="profile.network"
          :href="profile.url"
          :aria-label="SOCIAL_LABELS[profile.network]"
          target="_blank"
          rel="noopener noreferrer"
          class="inline-flex p-1 transition hover:opacity-70"
        >
          <UIcon :name="`i-simple-icons-${profile.network}`" class="size-4" />
        </a>
      </div>
    </div>
    <div class="flex flex-wrap items-center gap-x-6 gap-y-3">
      <!-- Route-owned representations resolve after the footer's SSR render.
           Mount the interactive selector after hydration; SEO alternates stay SSR. -->
      <ClientOnly>
        <select
          v-if="locales.length > 1"
          :value="locale"
          :aria-label="t('legal.language')"
          class="cursor-pointer appearance-none bg-transparent p-0 transition hover:opacity-70"
          @change="setLocale(($event.target as HTMLSelectElement).value)"
        >
          <option v-for="item in locales" :key="item.code" :value="item.code">{{ item.name }}</option>
        </select>
      </ClientOnly>
      <button
        v-if="colorMode"
        type="button"
        class="inline-flex p-1 transition hover:opacity-70"
        :aria-label="isDark ? t('legal.switch_to_light_mode') : t('legal.switch_to_dark_mode')"
        @click="setPreference(isDark ? 'light' : 'dark')"
      >
        <UIcon :name="isDark ? 'i-lucide-sun' : 'i-lucide-moon'" class="size-4" />
      </button>
      <!-- The site's own policies, where it has published them. -->
      <NuxtLink
        v-for="policy in policies"
        :key="policy"
        :to="localePath(`/policies/${policy}`)"
        class="no-underline transition hover:opacity-70"
      >
        {{ t(`legal.${policy.replace('-', '_')}`) }}
      </NuxtLink>
      <ZarazConsentButton />
      <a
        v-if="poweredByUrl"
        :href="poweredByUrl"
        target="_blank"
        rel="noopener"
        class="no-underline transition hover:opacity-70"
      >
        {{ t('legal.powered_by') }}
      </a>
      <slot />
    </div>
  </div>
  </div>
</template>

<script setup lang="ts">
import { isRecord, publicApiRequest } from '~/utils/api-clients'

defineProps<{
  /** Whose copyright the line states. */
  name: string
  /** Offer the light/dark switch. */
  colorMode?: boolean
}>()

const SOCIAL_LABELS = { facebook: 'Facebook', instagram: 'Instagram' } as const

const { t, locale, locales, setLocale, localePath } = useI18n()
const organization = useTenantOrganization().organization
const socialProfiles = organization?.social_profiles ?? []
const policies = organization?.policies ?? []
// Theme state is read from the one composable that owns it.
const { value: theme, setPreference } = usePlatformTheme()
const isDark = computed(() => theme.value === 'dark')
const year = new Date().getFullYear()
// Every tenant site credits KrabiClaw, tagged so the platform's own analytics
// can attribute the visit to the site and theme that sent it.
const platformOrigin = useRuntimeConfig().public.siteUrl
const requestHost = useRequestURL().host
const themeSlug = organization?.template.slug
const poweredByUrl = themeSlug && themeSlug !== 'platform'
  ? `${platformOrigin}/?${new URLSearchParams({ utm_source: requestHost, utm_medium: 'referral', utm_campaign: 'powered_by', utm_content: themeSlug })}`
  : null

// A business site's accepted payments, read after hydration so no page render waits on Stripe.
type AcceptedPayments = { types: string[]; country: string | null }
const isAccepted = (value: unknown): value is AcceptedPayments => isRecord(value) && Array.isArray(value.types) && value.types.every(type => typeof type === 'string') && (value.country === null || typeof value.country === 'string')
const { data: accepted } = useAsyncData('accepted-payments', () => publicApiRequest<AcceptedPayments>('/api/public/payment-methods', { validate: isAccepted }), { server: false, lazy: true, immediate: Boolean(poweredByUrl) })
// Stripe takes Visa, Mastercard and American Express everywhere it operates, and Discover in the US, Canada and Japan.
const DISCOVER_COUNTRIES = new Set(['US', 'CA', 'JP'])
const paymentBadges = computed(() => {
  const types = new Set(accepted.value?.types ?? [])
  return [
    ...(types.has('card') ? [
      { icon: 'i-logos-visa', label: 'Visa' },
      { icon: 'i-logos-mastercard', label: 'Mastercard' },
      { icon: 'i-logos-amex', label: 'American Express' },
      ...(DISCOVER_COUNTRIES.has(accepted.value?.country ?? '') ? [{ icon: 'i-logos-discover', label: 'Discover' }] : []),
    ] : []),
    ...(types.has('apple_pay') ? [{ icon: 'i-logos-apple-pay', label: 'Apple Pay' }] : []),
    ...(types.has('google_pay') ? [{ icon: 'i-logos-google-pay', label: 'Google Pay' }] : []),
    ...(types.has('klarna') ? [{ icon: 'i-simple-icons-klarna', label: 'Klarna', tint: 'bg-[#FFB3C7]! border-transparent', iconClass: 'text-black' }] : []),
    ...(types.has('afterpay_clearpay') ? [{ icon: 'i-simple-icons-afterpay', label: 'Afterpay', tint: 'bg-[#B2FCE4]! border-transparent', iconClass: 'text-black' }] : []),
  ] as Array<{ icon: string; label: string; tint?: string; iconClass?: string }>
})
</script>
