<template>
  <div class="space-y-6">
    <div>
      <h1 class="text-2xl font-semibold tracking-tight text-highlighted">Accept invitation</h1>
      <p class="mt-2 text-sm text-muted">Sign in with the email address that received this invitation.</p>
    </div>

    <!-- The session resolves on the client after mount; both the server and
         the hydrating client see it pending, so this branch is what both
         render until it is known. The sign-in buttons wait for a resolved
         signed-out session rather than flashing at a signed-in owner. -->
    <PushAsk v-if="joined" :title="`You've joined ${joined.organizationName}`" :lede="joined.lede" @done="navigateTo(joined.destination)" />

    <div v-else-if="sessionLoading || accepting" class="text-sm text-muted">
      {{ accepting ? 'Accepting invitation…' : 'Checking your session…' }}
    </div>

    <template v-else-if="!isAuthenticated">
      <AuthGoogleButton @activate="continueWithGoogle" />
      <UButton :to="emailLoginUrl" color="neutral" variant="outline" size="lg" block :ui="{ base: 'justify-start' }">
        Sign in with email
      </UButton>
    </template>

    <template v-else>
      <UAlert v-if="acceptError" color="error" variant="soft" :description="acceptError" />
      <UButton v-if="acceptError" block size="lg" :loading="accepting" @click="acceptInvitation">Try again</UButton>
      <UButton v-if="acceptError" block size="lg" color="neutral" variant="ghost" @click="switchAccount">Sign in with a different account</UButton>
    </template>
  </div>
</template>

<script setup lang="ts">
import { authClient } from '~/lib/auth-client'
import { buildLoginUrl } from '~/shared/auth/return-target'
import PushAsk from '~/components/dashboard/PushAsk.vue'
import { NOTIFICATION_CATEGORY_LABELS } from '~/shared/notification-categories'

definePageMeta({ layout: 'access' })

const route = useRoute()
const invitationId = String(route.params.invitationId || '')
const pagePath = `/accept-invitation/${encodeURIComponent(invitationId)}`
const emailLoginUrl = computed(() => buildLoginUrl({ redirect: pagePath }))
const session = authClient.useSession()
const isAuthenticated = computed(() => Boolean(session.value.data?.user))
const sessionLoading = computed(() => session.value.isPending)
const authOperation = useAuthOperation()
const accepting = ref(false)
const acceptError = ref<string | null>(null)
const attempted = ref(false)
const pushSubscription = usePushSubscription()
const preferences = useNotificationPreferences(() => session.value.data?.user?.id)
// Set once the invitation is accepted and this browser can still be asked for push.
const joined = ref<{ organizationName: string; lede: string; destination: string } | null>(null)

async function acceptInvitation() {
  accepting.value = true
  acceptError.value = null
  try {
    const result = await authClient.organization.acceptInvitation({ invitationId })
    if (result.error) throw new Error(result.error.message || 'Failed to accept invitation')
    const member = result.data?.member.role === 'member'
    const destination = member && result.data
      ? `/dashboard/account/profile/calendar/${encodeURIComponent(result.data.member.organizationId)}`
      : '/dashboard'
    await pushSubscription.refresh()
    // The ask names the organization just joined. Joining has already succeeded, so a name that
    // cannot be read is reported and the ask is left out rather than blocking the dashboard.
    const organization = pushSubscription.state.value.askable && result.data
      ? await authClient.organization.getFullOrganization({ query: { organizationId: result.data.member.organizationId } })
      : null
    if (organization?.error) globalThis.reportError(new Error(organization.error.message || 'Could not read the organization just joined'))
    if (!organization?.data) {
      await navigateTo(destination)
      return
    }
    // Members hear only what is assigned to them and their team conversations, which reach them by push alone.
    await preferences.load(true)
    const labels = preferences.labels.value ?? NOTIFICATION_CATEGORY_LABELS
    joined.value = {
      organizationName: organization.data.name,
      destination,
      lede: member
        ? `Get the ${labels.reservations_bookings.toLowerCase()} assigned to you and team messages. Team messages only arrive as notifications.`
        : `Get new ${labels.reservations_bookings.toLowerCase()} and ${labels.guest_messages.toLowerCase()} as they arrive.`,
    }
  } catch (error) {
    acceptError.value = error instanceof Error ? error.message : 'Failed to accept invitation'
  } finally {
    accepting.value = false
  }
}

watch([sessionLoading, isAuthenticated], async () => {
  if (sessionLoading.value || !isAuthenticated.value || attempted.value) return
  attempted.value = true
  await acceptInvitation()
}, { immediate: true })

async function continueWithGoogle() {
  await authOperation.signInWithGoogle(pagePath)
}

async function switchAccount() {
  // Better Auth resolves with { error } rather than throwing. Unreported, a
  // failed sign-out left this page looking like it had switched account while
  // the original session was still the one the invitation would be accepted by.
  const { error: signOutError } = await authClient.signOut()
  if (signOutError) {
    acceptError.value = signOutError.message || 'Could not sign out. Please try again.'
    return
  }
  attempted.value = false
}
</script>
