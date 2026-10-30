<template>
  <div class="space-y-6">
    <template v-if="joined">
      <div>
        <h1 class="text-2xl font-semibold tracking-tight text-highlighted">You joined {{ joined.organization.name }}</h1>
        <p class="mt-2 text-sm text-muted">Open the KrabiClaw app or your dashboard to get started.</p>
      </div>
      <UButton to="/dashboard" block size="lg">Go to your dashboard</UButton>
    </template>

    <template v-else-if="invite">
      <div>
        <h1 class="text-2xl font-semibold tracking-tight text-highlighted">Join {{ invite.organization.name }}</h1>
        <p class="mt-2 text-sm text-muted">
          You've been invited to join {{ invite.organization.name }} on KrabiClaw as {{ roleLabel }}.
          This link works once and expires on {{ expiresOn }}.
        </p>
      </div>

      <!-- The session resolves on the client after mount; until it is known
           both renders show this, so the choices never flash at a signed-in person. -->
      <div v-if="sessionLoading" class="text-sm text-muted">Checking your session…</div>

      <template v-else-if="signedIn">
        <p class="text-sm text-muted">Signed in as {{ session.data?.user.email }}.</p>
        <UButton block size="lg" :loading="accepting" @click="accept">Join {{ invite.organization.name }}</UButton>
        <UButton block size="lg" color="neutral" variant="ghost" :disabled="accepting" @click="switchAccount">Use a different account</UButton>
      </template>

      <template v-else>
        <AuthGoogleButton :loading="googleLoading" @activate="signInWithGoogle(pagePath)" />
        <AuthAppleButton :loading="googleLoading" @activate="signInWithApple(pagePath)" />
        <UButton :to="loginUrl" color="neutral" variant="outline" size="lg" block :ui="{ base: 'justify-start' }">
          Sign in with email
        </UButton>
        <UButton :to="signupUrl" color="neutral" variant="ghost" size="lg" block>
          Create an account
        </UButton>
      </template>

      <UButton :to="appUrl" external color="neutral" variant="link" block>Open this invite in the KrabiClaw app</UButton>

      <UAlert v-if="failure" color="error" variant="soft" :title="failure.title" :description="failure.message" />
    </template>

    <div v-else-if="failure">
      <h1 class="text-2xl font-semibold tracking-tight text-highlighted">{{ failure.title }}</h1>
      <p class="mt-2 text-sm text-muted">{{ failure.message }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { authClient } from '~/lib/auth-client'
import { buildLoginUrl } from '~/shared/auth/return-target'
import { ApiClientError } from '~/utils/api-clients'

definePageMeta({ layout: 'access', auth: false })
useResponseHeader('cache-control').value = 'private, no-store'
useSeoMeta({ title: 'Join a workspace | KrabiClaw', robots: 'noindex, nofollow' })

type Invite = { organization: { name: string }; role: string; expiresAt: string }
type Joined = { organization: { id: string; name: string }; role: string; memberId: string }
type Failure = { title: string; message: string }

const route = useRoute()
const token = String(route.params.token || '')
const pagePath = `/invite/${encodeURIComponent(token)}`
const loginUrl = buildLoginUrl({ redirect: pagePath })
const signupUrl = { path: '/signup', query: { redirect: pagePath } }
const appUrl = `krabiclaw://invite?token=${encodeURIComponent(token)}`

// Each refusal is the server's own coded answer; its code says which state the page is in.
function failureFor(error: unknown): Failure {
  const code = error instanceof ApiClientError ? error.code : undefined
  const message = getErrorMessage(error, 'This invite could not be opened.')
  if (code === 'INVITE_LINK_NOT_FOUND') return { title: 'Invite not found', message: `${message}. Ask the person who invited you for a new link.` }
  if (code === 'INVITE_LINK_USED') return { title: 'This invite was already used', message: `${message}. Each link works once; ask for a new one if you have not joined.` }
  if (code === 'INVITE_LINK_EXPIRED') return { title: 'This invite expired', message: `${message}. Invite links last seven days; ask for a new one.` }
  if (code === 'ALREADY_MEMBER') return { title: 'You are already a member', message: `${message}.` }
  return { title: 'Something went wrong', message }
}

const failure = ref<Failure | null>(null)
const invite = ref<Invite | null>(null)
try {
  invite.value = await applicationFetch<Invite>(`/api/invite-links/${encodeURIComponent(token)}`, {
    validate: (value): value is Invite => isRecord(value) && isRecord(value.organization) && typeof value.organization.name === 'string'
      && typeof value.role === 'string' && typeof value.expiresAt === 'string',
  })
} catch (error) {
  failure.value = failureFor(error)
}

const roleLabel = computed(() => invite.value?.role === 'admin' ? 'an admin' : 'a team member')
const expiresOn = computed(() => invite.value
  ? new Date(invite.value.expiresAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
  : '')

const session = authClient.useSession()
const sessionLoading = computed(() => session.value.isPending)
// An anonymous guest identity is not an account that can join a workspace.
const signedIn = computed(() => Boolean(session.value.data?.user && !session.value.data.user.isAnonymous))
const { loading: googleLoading, error: googleError, signInWithGoogle, signInWithApple } = useAuthOperation()
watch(googleError, value => { if (value) failure.value = { title: 'Sign in failed', message: value } })

const accepting = ref(false)
const joined = ref<Joined | null>(null)

async function accept() {
  accepting.value = true
  failure.value = null
  try {
    joined.value = await applicationFetch<Joined>(`/api/invite-links/${encodeURIComponent(token)}/accept`, {
      method: 'POST',
      validate: (value): value is Joined => isRecord(value) && isRecord(value.organization) && typeof value.organization.id === 'string'
        && typeof value.organization.name === 'string' && typeof value.role === 'string' && typeof value.memberId === 'string',
    })
  } catch (error) {
    failure.value = failureFor(error)
  } finally {
    accepting.value = false
  }
}

async function switchAccount() {
  const { error } = await authClient.signOut()
  if (error) {
    failure.value = { title: 'Could not sign out', message: error.message || 'Please try again.' }
    return
  }
  failure.value = null
}
</script>
