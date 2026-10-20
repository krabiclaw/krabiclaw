<template>
  <main class="platform-theme min-h-screen bg-default px-5 py-12 text-default">
    <div class="mx-auto max-w-xl space-y-6">
      <h1 class="text-2xl font-semibold text-highlighted">{{ t('booking.change_review') }}</h1>
      <USkeleton v-if="status === 'idle' || status === 'pending'" class="h-64 w-full" />
      <UAlert v-else-if="error" color="error" :title="t('booking.change_unavailable')" :description="t('booking.change_link_help')" />
      <template v-else-if="proposal">
        <UCard variant="subtle">
          <dl class="space-y-5">
            <div v-for="field in fields" :key="field.label">
              <dt class="font-semibold text-highlighted">{{ field.label }}</dt>
              <dd class="mt-1 text-muted">{{ field.before }} <span aria-hidden="true">→</span> {{ field.after }}</dd>
            </div>
          </dl>
        </UCard>
        <template v-if="proposal.status === 'pending'">
          <p class="text-sm text-muted">{{ t('booking.change_pending') }}</p>
          <UAlert v-if="decisionError" color="error" :description="decisionError" />
          <div class="flex justify-between gap-4">
            <UButton :label="t('booking.change_decline')" color="neutral" variant="outline" :disabled="sending" @click="respond('decline')" />
            <UButton :label="t('booking.change_accept')" :loading="sending" @click="respond('accept')" />
          </div>
        </template>
        <UAlert v-else color="success" :title="t(proposal.status === 'accepted' ? 'booking.change_accepted' : 'booking.change_declined')" :description="t(proposal.status === 'accepted' ? 'booking.change_updated' : 'booking.change_unchanged')" />
      </template>
    </div>
  </main>
</template>

<script setup lang="ts">
import { $fetch } from 'ofetch'
import { platformLocale } from '~/shared/platform-locales'
import type { respondToBookingChange } from '~/server/domain/guest-threads/booking-changes'

definePageMeta({ layout: 'standalone' })
const route = useRoute()
const { locale, t } = useI18n()
const app = useNuxtApp()
const publicLocale = useState<string>('public-locale')
const platformMessages = useState<Record<string, string> | null>('platform-locale-messages')
function setGuestLocale(value: string) {
  const catalog = platformLocale(value)
  if (!catalog) throw createError({ statusCode: 500, statusMessage: 'Guest language is unavailable' })
  publicLocale.value = catalog.locale
  platformMessages.value = { ...catalog.messages }
  app.$setAppLocale(catalog.locale, { ...catalog.messages })
}
// This private link also runs on the platform domain, without a tenant locale.
if (typeof route.params.locale === 'string') setGuestLocale(route.params.locale)
useSocialMetadata(() => ({
  path: route.path,
  title: t('booking.change_review'),
  description: t('booking.change_review'),
  socialImage: null,
  discoverability: 'private',
}))
useHead({ meta: [{ name: 'referrer', content: 'no-referrer' }] })
type Proposal = Awaited<ReturnType<typeof respondToBookingChange>>
const endpoint = `/api/public/booking-changes/${encodeURIComponent(String(route.params.threadId))}/${encodeURIComponent(String(route.params.requestId))}`
const token = computed(() => route.hash.slice(1))
const { data: proposal, status, error } = await useAsyncData(endpoint, () => $fetch<Proposal>(endpoint, { headers: { authorization: `Bearer ${token.value}` } }), { server: false })
watch(() => proposal.value?.locale, value => { if (value) setGuestLocale(value) }, { immediate: true })
const sending = ref(false)
const decisionError = ref('')
// One instant, one label: the server formats both sides in the booking's own
// zone, so this page never re-derives a local time the email disagrees with.
const fields = computed(() => {
  if (!proposal.value) return []
  const copy = getVerticalCopy(proposal.value.vertical, locale.value)
  return [
    { label: copy.locationLabel, before: proposal.value.originalLocationTitle, after: proposal.value.locationTitle },
    { label: copy.dateLabel, before: proposal.value.before.whenLabel, after: proposal.value.after.whenLabel },
    { label: copy.guestsLabel, before: String(proposal.value.before.partySize), after: String(proposal.value.after.partySize) },
  ]
})
async function respond(decision: 'accept' | 'decline') {
  if (sending.value) return
  sending.value = true
  decisionError.value = ''
  try {
    proposal.value = await $fetch<Proposal>(endpoint, { method: 'POST', headers: { authorization: `Bearer ${token.value}` }, body: { decision } })
  } catch {
    decisionError.value = t('booking.change_failed')
  } finally {
    sending.value = false
  }
}
</script>
