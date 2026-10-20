<template>
  <UCard variant="subtle" class="rounded-2xl">
    <div class="space-y-4 p-2 text-center">
      <h1 class="text-xl font-semibold text-highlighted">{{ heading }}</h1>
      <p class="text-sm text-muted">{{ message }}</p>
      <UButton v-if="state === 'ready'" size="lg" :loading="submitting" @click="submit">
        Unsubscribe
      </UButton>
      <UButton v-else-if="state === 'done'" to="/dashboard/account/profile/notifications" variant="subtle" size="lg">
        Manage all notifications
      </UButton>

      <!-- Turning everything in a category off is rarely what someone wants;
           the settings index is one link away before they commit to it. -->
      <p v-if="state === 'ready'" class="text-sm text-muted">
        Or <NuxtLink to="/dashboard/account/profile/notifications" class="underline underline-offset-2">choose exactly what you receive</NuxtLink>.
      </p>
    </div>
  </UCard>
</template>

<script setup lang="ts">
import { NOTIFICATION_CATEGORY_LABELS, isNotificationCategory } from '~/shared/notification-categories'

// The click, not the page load, performs the write. A mail client or link
// scanner that prefetches the URL must not silently unsubscribe someone —
// which is also why the one-click header points at the POST endpoint and this
// page only ever reads the query.
// The `access` layout: a centred public panel that pulls in the platform
// stylesheet, the same frame sign-in and password reset use. This link arrives
// from an email, so it is reached signed out.
definePageMeta({ layout: 'access', auth: false })

const route = useRoute()
const state = ref<'ready' | 'done' | 'invalid'>('invalid')
const submitting = ref(false)
const failure = ref('')

const category = computed(() => (isNotificationCategory(route.query.category) ? route.query.category : null))
const categoryLabel = computed(() => (category.value ? NOTIFICATION_CATEGORY_LABELS[category.value] : ''))

onMounted(() => {
  state.value = category.value && typeof route.query.user === 'string' && typeof route.query.token === 'string'
    ? 'ready'
    : 'invalid'
})

const heading = computed(() => {
  if (state.value === 'done') return 'You are unsubscribed'
  if (state.value === 'invalid') return 'This link is not valid'
  return `Unsubscribe from ${categoryLabel.value}?`
})

const message = computed(() => {
  if (failure.value) return failure.value
  if (state.value === 'done') return `You will no longer receive ${categoryLabel.value} emails. Everything else is unchanged.`
  if (state.value === 'invalid') return 'This unsubscribe link is incomplete or has expired. Open your notification settings to change what you receive.'
  return 'You will stop receiving these emails. Other notifications are unaffected.'
})

async function submit() {
  submitting.value = true
  failure.value = ''
  try {
    // Same signed query the List-Unsubscribe header carries, so both routes in
    // and the API have one contract.
    await publicApiMutation('/api/public/notifications/unsubscribe', {
      method: 'POST',
      query: { user: route.query.user, category: route.query.category, token: route.query.token },
      validate: (value): value is { success: true; category: string } => isRecord(value) && value.success === true && typeof value.category === 'string' && value.category === route.query.category,
    })
    state.value = 'done'
  } catch (cause) {
    failure.value = cause instanceof Error ? cause.message : 'Unsubscribing failed. Please try again.'
  } finally {
    submitting.value = false
  }
}

useSocialMetadata({
  path: '/unsubscribe',
  title: 'Unsubscribe | KrabiClaw',
  description: 'Manage your email subscription preferences.',
  socialImage: null,
  discoverability: 'private',
})
</script>
