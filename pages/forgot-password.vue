<template>
  <div>
    <h1 class="text-2xl font-semibold tracking-tight text-highlighted">Reset your password</h1>
    <p class="mt-2 text-sm text-muted">Enter the email you use for Krabiclaw and we'll send you a secure reset link.</p>

    <UAlert v-if="notice" color="success" variant="soft" :description="notice" class="mt-4" />
    <UAlert v-if="error" color="error" variant="soft" :description="error" class="mt-4" />

    <form class="mt-6 space-y-4" @submit.prevent="handleSubmit">
      <UFormField label="Email" name="email" size="lg">
        <UInput v-model="email" type="email" placeholder="you@example.com" :disabled="loading" autocomplete="email" size="lg" class="w-full" />
      </UFormField>
      <UButton type="submit" size="lg" block :loading="loading">
        Send reset link
      </UButton>
      <p class="text-sm">
        <NuxtLink to="/login" class="text-primary font-medium hover:underline no-underline">Back to sign in</NuxtLink>
      </p>
    </form>
  </div>
</template>

<script setup>
definePageMeta({ layout: 'access', auth: false })

import { authClient } from '~/lib/auth-client'

useSocialMetadata({
  schema: false,
  path: '/forgot-password',
  title: 'Reset your password',
  description: 'Request a password reset link for your Krabiclaw account.',
  discoverability: 'private',
})

const loading = ref(false)
const email = ref('')
const error = ref(null)
const notice = ref(null)

const handleSubmit = async () => {
  const normalizedEmail = email.value.trim()
  if (!normalizedEmail) {
    error.value = 'Enter your email address to continue.'
    return
  }

  loading.value = true
  error.value = null
  notice.value = null

  try {
    const result = await authClient.requestPasswordReset({
      email: normalizedEmail,
      redirectTo: `${window.location.origin}/reset-password`,
    })

    if (result?.error) {
      error.value = result.error.message ?? 'Could not send reset email.'
      return
    }

    notice.value = `If ${normalizedEmail} is registered, a reset link is on the way.`
  } catch (err) {
    error.value = err?.message ?? 'Could not send reset email.'
  } finally {
    loading.value = false
  }
}
</script>
