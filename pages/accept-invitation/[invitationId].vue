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
        <h1 class="text-2xl font-semibold tracking-tight text-highlighted">Join {{ invitation.organization.name }}</h1>
        <p class="mt-2 text-sm text-muted">
          You've been invited to join {{ invitation.organization.name }} on KrabiClaw as {{ roleLabel }}.
          The invitation is for {{ invitation.email }} and expires on {{ expiresOn }}.
        </p>
      </div>

      <!-- The session resolves on the client after mount; until it is known
           both renders show this, so the choices never flash at a signed-in person. -->
      <div v-if="sessionLoading" class="text-sm text-muted">Checking your session…</div>

      <template v-else-if="signedInEmail && !invitedAccount">
        <UAlert color="warning" variant="soft" :description="`You're signed in as ${signedInEmail}, but this invitation is for ${invitation.email}.`" />
        <UButton block size="lg" :loading="busy" @click="switchAccount">Sign out and continue as {{ invitation.email }}</UButton>
      </template>

      <template v-else-if="invitedAccount">
        <p class="text-sm text-muted">Signed in as {{ signedInEmail }}.</p>
        <UButton block size="lg" :loading="busy" @click="accept">Accept invitation</UButton>
        <UButton block size="lg" color="neutral" variant="ghost" :disabled="busy" @click="decline">Decline</UButton>
      </template>

      <form v-else-if="codeSent" class="space-y-3" @submit.prevent="signInWithCode">
        <p class="text-sm text-muted">We sent a 6-digit code to {{ invitation.email }}. It expires in 5 minutes.</p>
        <UFormField label="Code">
          <UInput v-model="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000" class="w-full font-mono tracking-widest" autofocus />
        </UFormField>
        <UButton type="submit" block size="lg" :loading="busy" :disabled="code.length !== 6">Sign in</UButton>
        <UButton block color="neutral" variant="ghost" :disabled="busy" @click="sendCode">Send a new code</UButton>
      </form>

      <template v-else>
        <p class="text-sm text-muted">Sign in with {{ invitation.email }} to answer this invitation. We'll email you a code; no password needed.</p>
        <UButton block size="lg" :loading="busy" @click="sendCode">Email me a code</UButton>
      </template>

      <UButton :to="appUrl" external color="neutral" variant="link" block>Open this invitation in the KrabiClaw app</UButton>
      <UAlert v-if="failure" color="error" variant="soft" :description="failure" />
    </template>

    <div v-else-if="declined">
      <h1 class="text-2xl font-semibold tracking-tight text-highlighted">Invitation declined</h1>
      <p class="mt-2 text-sm text-muted">You won't join this workspace. Ask the person who invited you if you change your mind.</p>
    </div>

    <div v-else-if="unavailable">
      <h1 class="text-2xl font-semibold tracking-tight text-highlighted">{{ unavailable.title }}</h1>
      <p class="mt-2 text-sm text-muted">{{ unavailable.message }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { authClient } from '~/lib/auth-client'
import PushAsk from '~/components/dashboard/PushAsk.vue'
import { NOTIFICATION_CATEGORY_LABELS } from '~/shared/notification-categories'
import { ApiClientError } from '~/utils/api-clients'

definePageMeta({ layout: 'access', auth: false })
useResponseHeader('cache-control').value = 'private, no-store'
useSeoMeta({ title: 'Accept invitation | KrabiClaw', robots: 'noindex, nofollow' })

type Invitation = { email: string; organization: { name: string }; role: string; expiresAt: string }
type Unavailable = { title: string; message: string }

const route = useRoute()
const invitationId = String(route.params.invitationId || '')
const appUrl = `krabiclaw://invitation?id=${encodeURIComponent(invitationId)}`

// Each refusal is the server's own coded answer; its code says which state the page is in.
function unavailableFor(error: unknown): Unavailable {
  const code = error instanceof ApiClientError ? error.code : undefined
  const message = getErrorMessage(error, 'This invitation could not be opened.')
  if (code === 'INVITATION_NOT_FOUND') return { title: 'Invitation not found', message: `${message}. Ask the person who invited you to send it again.` }
  if (code === 'INVITATION_ACCEPTED') return { title: 'Invitation already accepted', message: `${message}. Sign in to open the workspace.` }
  if (code === 'INVITATION_REJECTED' || code === 'INVITATION_CANCELED') return { title: 'Invitation closed', message: `${message}. Ask for a new one if you still want to join.` }
  if (code === 'INVITATION_EXPIRED') return { title: 'Invitation expired', message: `${message}. Ask the person who invited you to send it again.` }
  return { title: 'Something went wrong', message }
}

const unavailable = ref<Unavailable | null>(null)
const invitation = ref<Invitation | null>(null)
try {
  invitation.value = await applicationFetch<Invitation>(`/api/invitations/${encodeURIComponent(invitationId)}`, {
    validate: (value): value is Invitation => isRecord(value) && typeof value.email === 'string' && isRecord(value.organization)
      && typeof value.organization.name === 'string' && typeof value.role === 'string' && typeof value.expiresAt === 'string',
  })
} catch (error) {
  unavailable.value = unavailableFor(error)
}

const ROLE_LABELS: Record<string, string> = { owner: 'an owner', admin: 'an admin', member: 'a team member' }
const roleLabel = computed(() => ROLE_LABELS[invitation.value?.role ?? ''] ?? 'a team member')
const expiresOn = computed(() => invitation.value
  ? new Date(invitation.value.expiresAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
  : '')

const session = authClient.useSession()
const sessionLoading = computed(() => session.value.isPending)
// An anonymous guest identity is not an account that can join a workspace.
const signedInEmail = computed(() => session.value.data?.user && !session.value.data.user.isAnonymous ? session.value.data.user.email : null)
// Better Auth accepts an invitation only for the account with the invited address.
const invitedAccount = computed(() => Boolean(signedInEmail.value && invitation.value
  && signedInEmail.value.toLowerCase() === invitation.value.email.toLowerCase()))

const busy = ref(false)
const failure = ref<string | null>(null)
const codeSent = ref(false)
const code = ref('')
const declined = ref(false)
const joined = ref<{ organizationName: string; lede: string; destination: string } | null>(null)
const askingPush = ref(false)
const linking = ref<'apple' | 'google' | null>(null)
const pushSubscription = usePushSubscription()
const preferences = useNotificationPreferences(() => session.value.data?.user?.id)

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

const sendCode = () => step(async () => {
  const { error } = await authClient.emailOtp.sendVerificationOtp({ email: invitation.value!.email, type: 'sign-in' })
  if (error) throw new Error(error.message || 'The code could not be sent.')
  code.value = ''
  codeSent.value = true
})

const signInWithCode = () => step(async () => {
  const { error } = await authClient.signIn.emailOtp({ email: invitation.value!.email, otp: code.value })
  if (error) throw new Error(error.message || 'That code did not work.')
  await session.value.refetch()
})

const accept = () => step(async () => {
  const result = await authClient.organization.acceptInvitation({ invitationId })
  if (result.error) throw new Error(result.error.message || 'The invitation could not be accepted.')
  const member = result.data.member
  const organizationName = invitation.value!.organization.name
  const destination = member.role === 'member'
    ? `/dashboard/account/profile/calendar/${encodeURIComponent(member.organizationId)}`
    : '/dashboard'
  // Joining has succeeded: a browser whose push state cannot be read is reported and not asked.
  await pushSubscription.refresh().catch(error => globalThis.reportError(error))
  if (pushSubscription.state.value.askable) {
    // Members hear only what is assigned to them and their team conversations, which reach them by push alone.
    await preferences.load(true)
    askingPush.value = true
  }
  const labels = preferences.labels.value ?? NOTIFICATION_CATEGORY_LABELS
  joined.value = {
    organizationName,
    destination,
    lede: member.role === 'member'
      ? `Get the ${labels.reservations_bookings.toLowerCase()} assigned to you and team messages. Team messages only arrive as notifications.`
      : `Get new ${labels.reservations_bookings.toLowerCase()} and ${labels.guest_messages.toLowerCase()} as they arrive.`,
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
  codeSent.value = false
})
</script>
