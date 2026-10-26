<template>
  <div>
    <h1 class="text-2xl font-semibold tracking-tight text-highlighted">Sign in</h1>

    <UAlert v-if="notice" color="success" variant="soft" :description="notice" class="mt-4" />
    <UAlert v-if="operationError" color="error" variant="soft" :description="operationError" class="mt-4" />

    <div class="mt-6 space-y-3">
      <AuthGoogleButton label="Sign in with Google" :loading="googleLoading" :last-used="lastUsedMethod === 'google'" @activate="signInWithGoogle(postLoginUrl)" />
      <USeparator label="or" />
      <AuthEmailSignInForm :key="queryEmail" :callback-url="postLoginUrl" :initial-email="queryEmail" :last-used="lastUsedMethod === 'email'" @verification-required="showVerification" />

      <UAlert v-if="verificationEmail" color="neutral" variant="soft" description="Verify your email before signing in.">
        <template #actions>
          <UButton variant="outline" :loading="resending" @click="resendVerification">Resend verification</UButton>
        </template>
      </UAlert>
    </div>

    <p class="mt-6 text-center text-sm text-muted">Don't have an account? <NuxtLink :to="signupUrl" class="font-semibold text-primary">Sign up</NuxtLink></p>
  </div>
</template>

<script setup lang="ts">
import { authClient } from '~/lib/auth-client'
import { buildPostLoginUrl, validatedInternalPath } from '~/shared/auth/return-target'

definePageMeta({ layout: 'access', auth: false })
// A page about the business: its image is the organization's.
const { social_image: organizationSocialImage } = useTenantOrganization().organization
useSocialMetadata({
  schema: false,
  path: '/login',
  socialImage: organizationSocialImage,
  title: 'Sign in',
  description: 'Sign in to your KrabiClaw account to manage your site, bookings and content.',
  discoverability: 'private',
})

const route = useRoute()
const queryEmail = typeof route.query.email === 'string' ? route.query.email : ''
const redirect = computed(() => validatedInternalPath(route.query.redirect))
const postLoginUrl = computed(() => buildPostLoginUrl({ redirect: redirect.value }))
const signupUrl = computed(() => redirect.value ? { path: '/signup', query: { redirect: redirect.value } } : '/signup')
// Which button they pressed last, from Better Auth's lastLoginMethod plugin.
// It is a method name only — never an identity — so nothing here remembers who
// the previous person was. Client-only: the cookie is not read during SSR.
const lastUsedMethod = ref<string | null>(null)
onMounted(() => { lastUsedMethod.value = authClient.getLastUsedLoginMethod() })

const verificationEmail = ref('')
const resending = ref(false)
const notice = ref<string | null>(null)
const operationError = ref<string | null>(null)
const { loading: googleLoading, error: googleError, signInWithGoogle } = useAuthOperation()
watch(googleError, value => { operationError.value = value })

// Better Auth returns a link it refused to the same callback with `error` added.
if (route.query.verified === '1' && route.query.error) operationError.value = 'This verification link has expired or was already used. Sign in to get a new one.'
else if (route.query.verified === '1') notice.value = 'Your email is verified. You can sign in now.'
else if (route.query.reset === 'success') notice.value = 'Your password was updated. Sign in with your new password.'

// The session is read through applicationFetch, which forwards the visitor's
// cookie during SSR: Better Auth's client resolves an absolute base URL on the
// server, and useFetch does not forward cookies to one, so the server never saw
// the session and the redirect only ever happened after hydration.
const session = await applicationFetch<typeof authClient.$Infer.Session | null>('/api/auth/get-session', {
  validate: (value): value is typeof authClient.$Infer.Session | null => value === null || typeof value === 'object',
})
// Keep an anonymous session while signing in so Better Auth can link its purchases.
const isAuthenticated = computed(() => Boolean(session?.user?.id && !session.user.isAnonymous))
if (isAuthenticated.value) await navigateTo(postLoginUrl.value, { external: true, redirectCode: 302 })

function showVerification(email: string) {
  verificationEmail.value = email
}

function verificationCallback() {
  const url = new URL('/login', window.location.origin)
  url.searchParams.set('verified', '1')
  if (redirect.value) url.searchParams.set('redirect', redirect.value)
  return url.toString()
}

async function resendVerification() {
  if (!verificationEmail.value || resending.value) return
  resending.value = true
  operationError.value = null
  try {
    const result = await authClient.sendVerificationEmail({ email: verificationEmail.value, callbackURL: verificationCallback() })
    if (result?.error) operationError.value = result.error.message || 'Could not resend verification email.'
    else notice.value = `If ${verificationEmail.value} is registered, a fresh verification email is on the way.`
  } catch (error) {
    operationError.value = error instanceof Error ? error.message : 'Could not resend verification email.'
  } finally {
    resending.value = false
  }
}
</script>
