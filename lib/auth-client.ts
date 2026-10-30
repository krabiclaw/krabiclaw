// Better Auth client for Nuxt/Vue
import { createAuthClient } from 'better-auth/vue'
import { adminClient, anonymousClient, emailOTPClient, organizationClient, phoneNumberClient, lastLoginMethodClient } from 'better-auth/client/plugins'
import { organizationAccessControl, organizationRoles } from '~/utils/organization-access'
import { oauthProviderClient } from '@better-auth/oauth-provider/client'
import { stripeClient } from '@better-auth/stripe/client'
import { pageEventIdFor, whenLeaving } from '~/utils/pageview-tracking-runtime.client'
import { forgetPushSubscription } from '~/composables/usePushSubscription'

// Every auth request names the page visit it came from, so the signup it may produce is recorded with
// that visit's page, language and attribution. The server believes it only for the visitor's own session.
export const authClient = createAuthClient({
  fetchOptions: {
    async onRequest(context) {
      const pageEventId = import.meta.client
        ? await Promise.race([pageEventIdFor(window.location.pathname), whenLeaving()])
        : null
      if (pageEventId) context.headers.set('x-analytics-page-event', pageEventId)
    },
    // Once signed out, this browser drops its subscription so whoever signs in next starts with push
    // off. The sign-out has already happened, so a subscription the browser keeps is reported, not
    // turned into a failed sign-out.
    async onSuccess(context) {
      if (import.meta.client && new URL(context.request.url, window.location.origin).pathname.endsWith('/sign-out')) {
        await forgetPushSubscription().catch(error => globalThis.reportError(error))
      }
    },
  },
  plugins: [
    lastLoginMethodClient(),
    adminClient(),
    anonymousClient(),
    organizationClient({ ac: organizationAccessControl, roles: organizationRoles, teams: { enabled: true } }),
    phoneNumberClient(),
    emailOTPClient(),
    oauthProviderClient(),
    stripeClient({ subscription: true }),
  ]
})

export const { signIn, signOut, useSession } = authClient
