<template>
  <div class="space-y-6">
    <PushAsk v-if="joined && askingPush" :title="`You've joined ${joined.organizationName}`" :lede="joined.lede" @done="askingPush = false" />

    <template v-else-if="joined">
      <div>
        <h1 class="text-2xl font-semibold tracking-tight text-highlighted">You've joined {{ joined.organizationName }}</h1>
        <p class="mt-2 text-sm text-muted">You signed in with {{ invitation?.email }}. Add Apple or Google to sign in to this same account with them, here and in the KrabiClaw app.</p>
      </div>
      <AuthAppleButton label="Also sign in with Apple" :loading="linking === 'apple'" :disabled="linking !== null" @activate="link('apple')" />
      <AuthGoogleButton label="Also sign in with Google" :loading="linking === 'google'" :disabled="linking !== null" @activate="link('google')" />
      <UAlert v-if="failure" color="error" variant="soft" :description="failure" />
      <UButton :to="joined.destination" block size="lg" color="neutral" variant="ghost">Continue</UButton>
    </template>

    <template v-else-if="invitation">
      <div>
        <h1 class="text-2xl font-semibold tracking-tight text-highlighted">Join {{ invitation.organizationName }}</h1>
        <p class="mt-2 text-sm text-muted">
          You've been invited to join {{ invitation.organizationName }} on KrabiClaw as {{ roleLabel }}.
          The invitation is for {{ invitation.email }} and expires on {{ expiresOn }}.
        </p>
      </div>

      <p class="text-sm text-muted">Signed in as {{ invitation.email }}.</p>
      <UButton block size="lg" :loading="busy" @click="accept">Accept invitation</UButton>
      <UButton block size="lg" color="neutral" variant="ghost" :disabled="busy" @click="decline">Decline</UButton>
      <UButton :to="appUrl" external color="neutral" variant="link" block>Open this invitation in the KrabiClaw app</UButton>
      <UAlert v-if="failure" color="error" variant="soft" :description="failure" />
    </template>

    <template v-else-if="!signedInEmail">
      <h1 class="text-2xl font-semibold tracking-tight text-highlighted">Join a workspace</h1>
      <p class="text-sm text-muted">Sign in or create an account using the email address that received this invitation.</p>
      <UButton :to="loginUrl" block size="lg">Sign in</UButton>
      <UButton :to="signupUrl" block size="lg" color="neutral" variant="outline">Create an account</UButton>
      <UButton :to="appUrl" external color="neutral" variant="link" block>Open this invitation in the KrabiClaw app</UButton>
    </template>

    <div v-else-if="declined">
      <h1 class="text-2xl font-semibold tracking-tight text-highlighted">Invitation declined</h1>
      <p class="mt-2 text-sm text-muted">You won't join this workspace. Ask the person who invited you if you change your mind.</p>
    </div>

    <div v-else-if="lookupError" class="space-y-3">
      <h1 class="text-2xl font-semibold tracking-tight text-highlighted">Invitation unavailable</h1>
      <p class="text-sm text-muted">{{ lookupError.message }}</p>
      <template v-if="lookupError.code === 'YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION'">
        <p class="text-sm text-muted">You're signed in as {{ signedInEmail }}. Use the account that received the invitation.</p>
        <UButton block size="lg" :loading="busy" @click="switchAccount">Use a different account</UButton>
      </template>
      <UAlert v-if="failure" color="error" variant="soft" :description="failure" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { authClient } from '~/lib/auth-client'
import PushAsk from '~/components/dashboard/PushAsk.vue'
import { NOTIFICATION_CATEGORY_LABELS } from '~/shared/notification-categories'
import { buildLoginUrl } from '~/shared/auth/return-target'
import { normalizeApiError } from '~/utils/api-clients'

definePageMeta({ layout: 'access', auth: false })
useResponseHeader('cache-control').value = 'private, no-store'
useSeoMeta({ title: 'Accept invitation | KrabiClaw', robots: 'noindex, nofollow' })

type Invitation = { email: string; organizationName: string; organizationSlug: string; role: string; expiresAt: string }

const route = useRoute()
const invitationId = String(route.params.invitation_id || '')
const invitationPath = '/accept-invitation/' + encodeURIComponent(invitationId)
const loginUrl = buildLoginUrl({ redirect: invitationPath })
const signupUrl = { path: '/signup', query: { redirect: invitationPath } }
const appUrl = 'krabiclaw://invitation?id=' + encodeURIComponent(invitationId)

const session = await applicationFetch<typeof authClient.$Infer.Session | null>('/api/auth/get-session', {
  validate: (value): value is typeof authClient.$Infer.Session | null => value === null || isRecord(value),
})
const signedInEmail = session && !session.user.isAnonymous ? session.user.email : null
const lookupError = ref<{ code: string; message: string } | null>(null)
const invitation = ref<Invitation | null>(null)
if (signedInEmail) {
  try {
    invitation.value = await applicationFetch<Invitation>('/api/auth/organization/get-invitation', {
      query: { id: invitationId },
      validate: (value): value is Invitation => isRecord(value) && typeof value.email === 'string'
        && typeof value.organizationName === 'string' && typeof value.organizationSlug === 'string'
        && typeof value.role === 'string' && typeof value.expiresAt === 'string' && Number.isFinite(Date.parse(value.expiresAt)),
    })
  } catch (error) {
    const { code, message } = normalizeApiError(error)
    lookupError.value = { code, message }
  }
}

const ROLE_LABELS: Record<string, string> = { owner: 'an owner', admin: 'an admin', member: 'a team member' }
const roleLabel = computed(() => ROLE_LABELS[invitation.value?.role ?? ''] ?? 'a team member')
const expiresOn = computed(() => invitation.value
  ? new Date(invitation.value.expiresAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
  : '')

const busy = ref(false)
const failure = ref<string | null>(null)
const declined = ref(false)
const joined = ref<{ organizationName: string; lede: string; destination: string } | null>(null)
const askingPush = ref(false)
const linking = ref<'apple' | 'google' | null>(null)
const pushSubscription = usePushSubscription()
const preferences = useNotificationPreferences(() => session?.user.id)

async function step(operation: () => Promise<void>) {
  busy.value = true
  failure.value = null
  try {
    await operation()
  } catch (error) {
    failure.value = getErrorMessage(error, 'Something went wrong. Please try again.')
  } finally {
    busy.value = false
  }
}

const accept = () => step(async () => {
  const result = await authClient.organization.acceptInvitation({ invitationId })
  if (result.error) throw new Error(result.error.message || 'The invitation could not be accepted.')
  const member = result.data.member
  const organizationName = invitation.value!.organizationName
  const destination = member.role === 'member'
    ? `/dashboard/account/profile/calendar/${encodeURIComponent(member.organizationId)}`
    : '/dashboard/' + encodeURIComponent(invitation.value!.organizationSlug)
  // Joining has succeeded: a browser whose push state cannot be read is reported and not asked.
  await pushSubscription.refresh().catch(error => globalThis.reportError(error))
  if (pushSubscription.state.value.askable) {
    // Members hear about assigned work and their team conversations through their enabled channels.
    await preferences.load(true)
    askingPush.value = true
  }
  const labels = preferences.labels.value ?? NOTIFICATION_CATEGORY_LABELS
  joined.value = {
    organizationName,
    destination,
    lede: member.role === 'member'
      ? `Get the ${labels.reservations_bookings.toLowerCase()} assigned to you and team messages. Team messages only arrive as notifications.`
      : `Get new ${labels.reservations_bookings.toLowerCase()} and ${labels.messages.toLowerCase()} as they arrive.`,
  }
})

const decline = () => step(async () => {
  const { error } = await authClient.organization.rejectInvitation({ invitationId })
  if (error) throw new Error(error.message || 'The invitation could not be declined.')
  invitation.value = null
  declined.value = true
})

// Better Auth links the provider to this account and returns to Login & security,
// which also reports a refusal such as an Apple ID already signed in as another account.
async function link(provider: 'apple' | 'google') {
  linking.value = provider
  failure.value = null
  const callbackURL = '/dashboard/account/profile/login'
  const { error } = await authClient.linkSocial({ provider, callbackURL, errorCallbackURL: callbackURL })
  if (error) {
    failure.value = error.message || 'That sign-in could not be added.'
    linking.value = null
  }
}

// Better Auth resolves with { error } rather than throwing. Unreported, a failed
// sign-out left this page looking like it had switched account while the
// original session was still the one the invitation would be accepted by.
const switchAccount = () => step(async () => {
  const { error } = await authClient.signOut()
  if (error) throw new Error(error.message || 'Could not sign out. Please try again.')
  await navigateTo(loginUrl, { external: true })
})
</script>
