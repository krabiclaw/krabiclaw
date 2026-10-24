<template>
  <div v-if="!isAuthenticated">
    <!-- Signing up by email used to push back to /login with a small alert, so
         the page looked unchanged and owners retried the form. Verification is
         its own step, so it gets its own screen. -->
    <div v-if="pendingEmail" class="text-center">
      <div class="mx-auto flex size-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
        <UIcon name="i-lucide-mail-check" class="size-7" />
      </div>
      <h1 class="mt-5 text-2xl font-semibold tracking-tight text-highlighted">Check your email</h1>
      <p class="mt-3 text-sm leading-relaxed text-muted">
        We sent a verification link to <span class="font-semibold text-default">{{ pendingEmail }}</span>.
        Open it to finish setting up your account.
      </p>

      <UAlert v-if="resendNotice" color="success" variant="soft" :description="resendNotice" class="mt-5 text-left" />
      <UAlert v-if="resendError" color="error" variant="soft" :description="resendError" class="mt-5 text-left" />

      <div class="mt-7 space-y-3">
        <UButton color="neutral" variant="outline" size="lg" block :loading="resending" @click="resendVerification">
          Resend the email
        </UButton>
        <UButton block color="neutral" variant="ghost" size="sm" @click="useDifferentEmail">
          Use a different email address
        </UButton>
      </div>
      <p class="mt-6 text-sm text-muted">Already verified? <NuxtLink :to="loginUrl" class="font-semibold text-primary">Sign in</NuxtLink></p>
    </div>

    <div v-else>
    <h1 class="text-2xl font-semibold tracking-tight text-highlighted">Create your account</h1>

    <UAlert v-if="error" color="error" variant="soft" :description="error" class="mt-4" />

    <!-- Agreement is its own action before either way of signing up, and starts unchecked. -->
    <UCheckbox v-model="agreed" class="mt-6" name="terms-agreement">
      <template #label>
        I agree to the <NuxtLink to="/policies/terms" target="_blank" class="font-semibold text-primary">Terms of Service</NuxtLink>
        and the <NuxtLink to="/policies/acceptable-use" target="_blank" class="font-semibold text-primary">Acceptable Use Policy</NuxtLink>,
        which do not tolerate abusive content or users, and the <NuxtLink to="/policies/privacy" target="_blank" class="font-semibold text-primary">Privacy Policy</NuxtLink>.
      </template>
    </UCheckbox>
    <div class="mt-4 space-y-3" :class="agreed ? '' : 'pointer-events-none opacity-50'" :aria-disabled="!agreed" :inert="!agreed">
      <AuthGoogleButton label="Sign up with Google" :loading="loading" @activate="googleSignup" />
      <USeparator label="or use email" />
      <AuthEmailSignUpForm :callback-url="verificationCallback" :initial-email="queryEmail" @success="emailSignupComplete" />
    </div>
    <p class="mt-6 text-center text-sm text-muted">Already have an account? <NuxtLink :to="loginUrl" class="font-semibold text-primary">Sign in</NuxtLink></p>
    </div>
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
  path: '/signup',
  socialImage: organizationSocialImage,
  title: 'Create your account',
  description: 'Create a free KrabiClaw account and build your business site through ChatGPT.',
  discoverability: 'private',
})

const route = useRoute()
const redirect = computed(() => validatedInternalPath(route.query.redirect))
const queryEmail = typeof route.query.email === 'string' ? route.query.email : ''
const postLoginUrl = computed(() => buildPostLoginUrl({ redirect: redirect.value }))
const loginUrl = computed(() => redirect.value ? { path: '/login', query: { redirect: redirect.value } } : '/login')
const requestUrl = useRequestURL()
const verificationCallback = computed(() => {
  const url = new URL('/login', requestUrl.origin)
  url.searchParams.set('verified', '1')
  if (redirect.value) url.searchParams.set('redirect', redirect.value)
  return url.toString()
})
const { loading, error, signInWithGoogle } = useAuthOperation()
const pendingEmail = ref('')
const agreed = ref(false)
const resending = ref(false)
const resendNotice = ref<string | null>(null)
const resendError = ref<string | null>(null)

// The session is read through applicationFetch, which forwards the visitor's
// cookie during SSR: Better Auth's client resolves an absolute base URL on the
// server, and useFetch does not forward cookies to one, so the server never saw
// the session and the redirect only ever happened after hydration.
const session = await applicationFetch<typeof authClient.$Infer.Session | null>('/api/auth/get-session', {
  validate: (value): value is typeof authClient.$Infer.Session | null => value === null || typeof value === 'object',
})
// Keep an anonymous session while signing up so Better Auth can link its purchases.
const isAuthenticated = computed(() => Boolean(session?.user?.id && !session.user.isAnonymous))
if (isAuthenticated.value) await navigateTo(postLoginUrl.value, { external: true, redirectCode: 302 })

async function googleSignup() {
  if (!agreed.value) return
  await signInWithGoogle(postLoginUrl.value)
}

async function emailSignupComplete(email: string) {
  pendingEmail.value = email
}

function useDifferentEmail() {
  pendingEmail.value = ''
  resendNotice.value = null
  resendError.value = null
}

async function resendVerification() {
  if (!pendingEmail.value || resending.value) return
  resending.value = true
  resendNotice.value = null
  resendError.value = null
  try {
    const result = await authClient.sendVerificationEmail({ email: pendingEmail.value, callbackURL: verificationCallback.value })
    if (result?.error) resendError.value = result.error.message || 'Could not resend the verification email.'
    else resendNotice.value = `If ${pendingEmail.value} is registered, another verification email is on the way.`
  } catch (resendFailure) {
    resendError.value = resendFailure instanceof Error ? resendFailure.message : 'Could not resend the verification email.'
  } finally {
    resending.value = false
  }
}
</script>
