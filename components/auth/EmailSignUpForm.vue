<template>
  <form method="post" class="space-y-3" @submit.prevent="submit">
    <UFormField label="Email" name="signup-email" :error="emailError" size="lg">
      <UInput v-model="email" type="email" placeholder="you@example.com" :disabled="loading" autocomplete="email" size="lg" class="w-full" />
    </UFormField>
    <UFormField label="Password" name="signup-password" :error="passwordError" size="lg">
      <UInput v-model="password" type="password" placeholder="••••••••" :disabled="loading" autocomplete="new-password" size="lg" class="w-full" />
    </UFormField>
    <UButton type="submit" size="lg" block :loading="loading">Create account</UButton>
    <UAlert v-if="error" color="error" variant="soft" :description="error" />
  </form>
</template>

<script setup lang="ts">
import { authClient } from '~/lib/auth-client'
import { validatePassword } from '~/utils/password-validation'

const props = withDefaults(defineProps<{ callbackUrl: string; initialEmail?: string }>(), { initialEmail: '' })
const emit = defineEmits<{ success: [email: string] }>()
const email = ref(props.initialEmail)
const password = ref('')
const emailError = ref('')
const passwordError = ref('')
const { loading, error, run } = useAuthOperation()

async function submit() {
  const normalizedEmail = email.value.trim()
  emailError.value = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail) ? '' : 'Please enter a valid email address.'
  passwordError.value = validatePassword(password.value)
  if (emailError.value || passwordError.value) return
  const result = await run(() => authClient.signUp.email({ email: normalizedEmail, password: password.value, name: normalizedEmail.split('@')[0] || 'User', callbackURL: props.callbackUrl }), 'Sign up failed. Please try again.') as { error?: { message?: string } & Record<string, unknown> } | null
  if (result?.error) error.value = result.error.message || 'Sign up failed. Please try again.'
  else if (result) emit('success', normalizedEmail)
}
</script>
