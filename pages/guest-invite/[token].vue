<template>
  <div class="space-y-6">
    <template v-if="invite">
      <div>
        <h1 class="text-2xl font-semibold tracking-tight text-highlighted">{{ invite.organization_name }} invited you to your conversation</h1>
        <p class="mt-2 text-sm text-muted">
          Sign in to read and reply to messages about your stay{{ invite.location_title ? ` at ${invite.location_title}` : '' }}.
          Replies from your host appear in your KrabiClaw inbox.
        </p>
      </div>

      <!-- The session resolves on the client after mount; until it is known
           both renders show this, so a signed-in guest never sees the choices
           flash before their claim starts. -->
      <div v-if="sessionLoading || claiming" class="text-sm text-muted">
        {{ claiming ? 'Opening your conversation…' : 'Checking your session…' }}
      </div>

      <template v-else-if="!signedIn">
        <AuthGoogleButton :loading="googleLoading" @activate="signInWithGoogle(pagePath)" />
        <UButton :to="emailLoginUrl" color="neutral" variant="outline" size="lg" block :ui="{ base: 'justify-start' }">
          Sign in with email
        </UButton>
        <UButton color="neutral" variant="ghost" size="lg" block @click="claim">
          Continue without an account
        </UButton>
      </template>

      <UAlert v-if="failure" color="error" variant="soft" :title="failure.title" :description="failure.message" />
      <UButton v-if="failure && signedIn" block size="lg" @click="claim">Try again</UButton>
      <UButton v-if="failure && signedIn" block size="lg" color="neutral" variant="ghost" @click="switchAccount">Sign in with a different account</UButton>
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

definePageMeta({ layout: 'access', auth: false })
useResponseHeader('cache-control').value = 'private, no-store'
useSeoMeta({ title: 'Your conversation | KrabiClaw', robots: 'noindex, nofollow' })

type Invite = { organization_name: string; location_title: string | null; expires_at: string }
type Failure = { title: string; message: string }

const route = useRoute()
const token = String(route.params.token || '')
const pagePath = `/guest-invite/${encodeURIComponent(token)}`
const emailLoginUrl = buildLoginUrl({ redirect: pagePath })

// Each refusal is the server's own coded answer; its status says which state the page is in.
function failureFor(error: unknown): Failure {
  const status = error && typeof error === 'object' ? Reflect.get(error, 'statusCode') ?? Reflect.get(error, 'status') : undefined
  const message = getErrorMessage(error, 'This invite could not be opened.')
  if (status === 404) return { title: 'Invite not found', message: `${message}. Ask your host for a new link.` }
  if (status === 410) return { title: 'This invite has ended', message: `${message}. Ask your host for a new link.` }
  if (status === 409) return { title: 'This conversation already has a guest', message: `${message}. Sign in with the account that joined it, or ask your host.` }
  return { title: 'Something went wrong', message }
}

const failure = ref<Failure | null>(null)
const invite = ref<Invite | null>(null)
try {
  invite.value = await applicationFetch<Invite>(`/api/guest-invites/${encodeURIComponent(token)}`, {
    validate: (value): value is Invite => isRecord(value) && typeof value.organization_name === 'string'
      && (value.location_title === null || typeof value.location_title === 'string') && typeof value.expires_at === 'string',
  })
} catch (error) {
  failure.value = failureFor(error)
}

const session = authClient.useSession()
const sessionLoading = computed(() => session.value.isPending)
// An anonymous session is offered the same choices: signing in links it, continuing keeps it.
const signedIn = computed(() => Boolean(session.value.data?.user && !session.value.data.user.isAnonymous))
const { loading: googleLoading, error: googleError, signInWithGoogle } = useAuthOperation()
watch(googleError, value => { if (value) failure.value = { title: 'Google sign in failed', message: value } })
const claiming = ref(false)
const attempted = ref(false)

async function claim() {
  claiming.value = true
  failure.value = null
  try {
    const result = await applicationFetch<{ thread_id: string; path: string }>(`/api/guest-invites/${encodeURIComponent(token)}/claim`, {
      method: 'POST',
      validate: (value): value is { thread_id: string; path: string } => isRecord(value) && typeof value.thread_id === 'string'
        && value.path === `/dashboard/account/messages/${encodeURIComponent(value.thread_id)}`,
    })
    await navigateTo(result.path)
  } catch (error) {
    failure.value = failureFor(error)
  } finally {
    claiming.value = false
  }
}

// A guest who signed in for this link is taken straight to the conversation.
watch([sessionLoading, signedIn], async () => {
  if (!invite.value || sessionLoading.value || !signedIn.value || attempted.value) return
  attempted.value = true
  await claim()
}, { immediate: true })

async function switchAccount() {
  const { error } = await authClient.signOut()
  if (error) {
    failure.value = { title: 'Could not sign out', message: error.message || 'Please try again.' }
    return
  }
  failure.value = null
  attempted.value = false
}
</script>
