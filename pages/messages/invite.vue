<template>
  <div class="space-y-4">
    <h1 class="text-2xl font-semibold tracking-tight text-highlighted">Join a conversation</h1>
    <UAlert v-if="!token" color="error" title="Invitation link is incomplete" />
    <UAlert v-else-if="session.isPending" color="neutral" title="Checking your account…" />
    <UAlert v-else-if="session.error" color="error" title="Your account could not be loaded" :description="session.error.message" />
    <template v-else-if="!signedIn">
      <p class="text-sm text-muted">Sign in using the email address that received this invitation.</p>
      <UButton :to="loginUrl" block size="lg">Sign in</UButton>
      <UButton :to="signupUrl" block size="lg" color="neutral" variant="outline">Create an account</UButton>
    </template>
    <template v-else>
      <p class="text-sm text-muted">Signed in as {{ session.data?.user.email }}. Use the email address that received this invitation.</p>
      <UButton label="Accept invitation" block size="lg" :loading="accepting" @click="accept" />
      <UButton label="Use a different account" block size="lg" color="neutral" variant="outline" :disabled="accepting" @click="switchAccount" />
      <UAlert v-if="failure" color="error" variant="soft" :description="failure" />
    </template>
  </div>
</template>

<script setup lang="ts">
import { authClient } from '~/lib/auth-client'
import { buildLoginUrl } from '~/shared/auth/return-target'
import { getErrorMessage } from '~/utils/errors'

definePageMeta({ layout: 'access', auth: false })
useResponseHeader('cache-control').value = 'private, no-store'
useResponseHeader('referrer-policy').value = 'no-referrer'
useSeoMeta({ title: 'Join a conversation | KrabiClaw', robots: 'noindex, nofollow' })

const route = useRoute()
const session = authClient.useSession()
const token = computed(() => typeof route.query.token === 'string' ? route.query.token : '')
const redirect = computed(() => `/messages/invite?token=${encodeURIComponent(token.value)}`)
const loginUrl = computed(() => buildLoginUrl({ redirect: redirect.value }))
const signupUrl = computed(() => ({ path: '/signup', query: { redirect: redirect.value } }))
const signedIn = computed(() => Boolean(session.value.data?.user && !session.value.data.user.isAnonymous))
const accepting = ref(false)
const failure = ref<string | null>(null)

async function accept() {
  accepting.value = true
  failure.value = null
  try {
    const result = await applicationFetch('/api/messages/invites/accept', {
      method: 'POST', body: { token: token.value },
      validate: (value): value is { conversation_id: string; organization_id: string } =>
        isRecord(value) && typeof value.conversation_id === 'string' && value.conversation_id !== '' && typeof value.organization_id === 'string',
    })
    await navigateTo(`/dashboard/account/messages/${encodeURIComponent(result.conversation_id)}`, { replace: true })
  } catch (cause) {
    failure.value = getErrorMessage(cause, 'The invitation could not be accepted')
  } finally {
    accepting.value = false
  }
}

async function switchAccount() {
  failure.value = null
  try {
    const { error } = await authClient.signOut()
    if (error) throw new Error(error.message || 'Could not sign out')
    await navigateTo(loginUrl.value, { external: true })
  } catch (cause) {
    failure.value = getErrorMessage(cause, 'Could not sign out')
  }
}
</script>
