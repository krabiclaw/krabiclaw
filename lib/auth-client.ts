// Better Auth client for Nuxt/Vue
import { createAuthClient } from 'better-auth/vue'
import { adminClient, anonymousClient, organizationClient, phoneNumberClient, lastLoginMethodClient } from 'better-auth/client/plugins'
import { organizationAccessControl, organizationRoles } from '~/utils/organization-access'
import { oauthProviderClient } from '@better-auth/oauth-provider/client'
import { stripeClient } from '@better-auth/stripe/client'
import { pageEventIdFor, whenLeaving } from '~/utils/pageview-tracking-runtime.client'

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
  },
  plugins: [
    lastLoginMethodClient(),
    adminClient(),
    anonymousClient(),
    organizationClient({ ac: organizationAccessControl, roles: organizationRoles, teams: { enabled: true } }),
    phoneNumberClient(),
    oauthProviderClient(),
    stripeClient({ subscription: true }),
  ]
})

export const { signIn, signOut, useSession } = authClient
