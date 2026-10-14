import { APIError, betterAuth, type Account, type BetterAuthPlugin } from 'better-auth'
import { createAuthMiddleware, getOAuthState, isAPIError } from 'better-auth/api'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { hashPassword } from 'better-auth/crypto'
import { DISCORD_BOT_PERMISSIONS } from '~/server/utils/discord-bot'
import { loginMethodForPath } from '~/shared/auth/login-method'
import { admin, anonymous, bearer, genericOAuth, getOrgAdapter, hasPermission, jwt, lastLoginMethod, organization, phoneNumber, type UserWithAnonymous } from 'better-auth/plugins'
import { stripe as betterAuthStripe } from '@better-auth/stripe'
import { oauthProvider } from '@better-auth/oauth-provider'
import { cimd } from '@better-auth/cimd'
import { fetchCimdMetadataResource } from '~/server/utils/cimd-metadata-fetch'
import type { GenericEndpointContext } from '@better-auth/core'
import { HTTPError, type H3Event } from 'nitro';
import { createDb, execute, executeBatch, queryAll, queryFirst, schema, type BatchQuery } from '~/server/db'
import { publicResourceCacheInvalidationQuery } from '~/server/utils/public-resource-cache'
import { sendWhatsAppOtp } from '~/server/utils/whatsapp'
import { parsePhoneOrThrow } from '~/utils/phone'
import { isCurrencyCode } from '~/shared/currencies'
import { isValidTimezone } from '~/utils/timezone'
import { createCanonicalNotification, notifyNewUserSignup } from '~/server/utils/notification-center'
import { measurementOutcome, readPageEventId, recordAndDeliverConversion } from '~/server/utils/organization-conversions'
import { getPlatformOrganization } from '~/server/utils/platform-organization'
import { sendPasswordResetEmail, sendVerificationEmail } from '~/server/utils/auth-email'
import { validatePassword } from '~/utils/password-validation'
import { organizationEventQuery } from '~/server/utils/organization-events'
import type { InferSelectModel } from 'drizzle-orm'
import { organizationAccessControl, organizationRoles } from '~/utils/organization-access'
import { platformAdminAccessControl, platformAdminRoles } from '~/utils/platform-admin-access'
import { createStripePlanLoader } from '~/server/utils/better-auth-stripe'
import { handleStripeGa4Event } from '~/server/utils/stripe-ga4'
import { notifyPaymentsInvoiceEvent } from '~/server/domain/payments/billing-notifications'
import { setUpPaymentsBillingForSubscriptionEvent } from '~/server/domain/payments/usage'
import { ingestStripeFeeReportEvent } from '~/server/domain/payments/costs'
import { createStripeClient } from '~/server/utils/stripe-client'
import { deleteBuyerCustomers } from '~/server/utils/billing-customer'
import { anonymousLinkQueries, linkGuestIdentitiesByVerifiedEmail } from '~/server/utils/guest-accounts'
import { unwrapInstrumentedD1 } from '~/server/utils/request-metrics'
import { timingSafeEqualText } from '~/server/utils/dev-route-auth'
import { notifyOrganizationInvited } from '~/server/utils/notifications'
import { cleanupOrganizationBeforeDelete } from '~/server/utils/tenant-deletion'
import { APPLE_AUTHORIZATION_CODE_HEADER, exchangeAppleAuthorizationCode, revokeAppleGrant } from '~/server/utils/apple-revocation'
import { deleteLodgingOrganization, deleteLodgingUser, hasLodgingMembership, isLodgingOrganization, notifyLodgingMembershipChanged } from '~/server/utils/lodging-service'
import { reconcileZarazAnalytics } from '~/server/utils/zaraz-analytics'

type MemberRow = InferSelectModel<typeof schema.member>

type IntegrationCallbackContext = GenericEndpointContext['context'] & { integrationAccountId?: string }

/** The account Better Auth just linked, carried only in this callback's hook context. */
async function integrationAccountLinked(account: { id: string; userId: string }, ctx: GenericEndpointContext | null) {
  if (ctx?.path !== '/callback/:id') return
  const state = await getOAuthState()
  if (state?.link?.userId !== account.userId) return
  const context = ctx.context as IntegrationCallbackContext
  context.integrationAccountId = account.id
}

export const OAUTH_SIGNING_POLICY = {
  algorithm: 'RS256',
  resourceSeedMode: 'merge',
} as const

export function oauthSigningConfig(authBaseUrl: string) {
  return {
    resourceSeedMode: OAUTH_SIGNING_POLICY.resourceSeedMode,
    resources: [
      {
        identifier: `${authBaseUrl}/api/mcp`,
        name: 'KrabiClaw tenant MCP',
        allowedScopes: ['openid', 'email', 'offline_access', 'tenant'],
        signingAlgorithm: OAUTH_SIGNING_POLICY.algorithm,
      },
    ],
  }
}

export const organizationOptions = {
  ac: organizationAccessControl,
  roles: organizationRoles,
  teams: { enabled: true, defaultTeam: { enabled: false }, allowRemovingAllTeams: true },
  // A business cannot exist without the currency it sells in and the clock it
  // reports in, so Better Auth requires both when the organization is created.
  schema: {
    organization: {
      additionalFields: {
        default_currency: { type: 'string', required: true, input: true },
        timezone: { type: 'string', required: true, input: true },
      },
    },
  },
} as const

function assertOrganizationFacts(data: { default_currency?: unknown; timezone?: unknown }) {
  if (data.default_currency !== undefined && !isCurrencyCode(data.default_currency)) throw new APIError('BAD_REQUEST', { message: 'default_currency must be a supported ISO 4217 currency' })
  if (data.timezone !== undefined && !isValidTimezone(typeof data.timezone === 'string' ? data.timezone : null)) throw new APIError('BAD_REQUEST', { message: 'timezone must be an IANA time zone' })
}


/**
 * Better Auth Stripe wraps the organization plugin's delete hook with its own
 * subscription guard. This plugin is deliberately registered after Stripe so
 * that provider-owned billing checks run first; only then do we release the
 * Krabiclaw resources Better Auth cannot know about. Once the organization is
 * gone, Zaraz is reconciled so its measurement id stops being served.
 */
function organizationDeletionCleanupPlugin(env: CloudflareEnv): BetterAuthPlugin {
  return {
    id: 'organization-deletion-cleanup',
    init(ctx) {
      const orgPlugin = ctx.getPlugin('organization')
      if (!orgPlugin) throw new Error('Organization plugin is required')
      const existingHooks = orgPlugin.options.organizationHooks ?? {}
      const beforeDeleteOrganization = existingHooks.beforeDeleteOrganization
      const afterDeleteOrganization = existingHooks.afterDeleteOrganization
      orgPlugin.options.organizationHooks = {
        ...existingHooks,
        beforeDeleteOrganization: async (data, hookCtx) => {
          await beforeDeleteOrganization?.(data, hookCtx)
          // The lodging Worker removes the organization's homes, Channex
          // properties and team data first; a failure there keeps the
          // organization, so nothing is left behind keyed to a deleted id.
          if (await isLodgingOrganization(env.DB, data.organization.id)) await deleteLodgingOrganization(env, data.organization.id)
          await cleanupOrganizationBeforeDelete(env, data.organization.id)
        },
        afterDeleteOrganization: async (data, hookCtx) => {
          await afterDeleteOrganization?.(data, hookCtx)
          await reconcileZarazAnalytics(env, env.DB)
        },
      }
    },
  }
}

// The generic @better-auth/core AuthContext type doesn't line up with this
// app's concrete plugin/options shape (each plugin narrows it further), so
// derive the type actually produced by this file's own createAuth() instead.

export interface CloudflareEnv {
  DB: D1Database
  IMAGES: ImagesBinding
  BETTER_AUTH_SECRET: string
  BETTER_AUTH_URL?: string
  GOOGLE_CLIENT_ID: string
  GOOGLE_CLIENT_SECRET: string
  APPLE_APP_BUNDLE_ID: string
  STRIPE_SECRET_KEY?: string
  STRIPE_WEBHOOK_SECRET?: string
  STRIPE_CONNECT_WEBHOOK_SECRET?: string
  GA4_API_SECRET?: string
  GOOGLE_ADS_DEVELOPER_TOKEN?: string
  AI_SEARCH?: AiSearchNamespace
  AI_SEARCH_INSTANCE_ID?: string
  PLATFORM_SEARCH_REINDEX_SECRET?: string
  APPLE_TEAM_ID?: string
  APPLE_KEY_ID?: string
  APPLE_PRIVATE_KEY?: string
  LODGING_SERVICE_SECRET?: string
  LODGING_API_URL?: string
  CF_ACCOUNT_ID?: string
  CLOUDFLARE_API_TOKEN?: string
  CLOUDFLARE_IMAGES_API_TOKEN?: string
  CF_ZONE_ID?: string
  CF_CUSTOM_HOSTNAMES_API_TOKEN?: string
  CF_SAAS_CNAME_TARGET?: string
  NUXT_PUBLIC_FREE_ORGANIZATION_DOMAIN?: string
  NUXT_PUBLIC_PLATFORM_DOMAIN?: string
  WHATSAPP_ACCESS_TOKEN?: string
  WHATSAPP_PHONE_NUMBER_ID?: string
  WHATSAPP_VERIFY_TOKEN?: string
  E2E_ALLOW_DEV_ROUTES?: string
  E2E_DEV_ROUTE_SECRET?: string
  FACEBOOK_APP_ID?: string
  FACEBOOK_APP_SECRET?: string
  FACEBOOK_CONFIG_ID?: string
  INSTAGRAM_APP_ID?: string
  INSTAGRAM_APP_SECRET?: string
  DISCORD_CLIENT_ID?: string
  DISCORD_CLIENT_SECRET?: string
  DISCORD_BOT_TOKEN?: string
  RESEND_API_KEY?: string
  RESEND_WEBHOOK_SECRET?: string
  RESEND_PRODUCT_NEWS_SEGMENT_ID?: string
  RESEND_PRODUCT_NEWS_TOPIC_ID?: string
  EMAIL_FROM?: string
  EMAIL_DELIVERY_MODE?: string
  EMAIL_REPLY_SECRET?: string
  MEDIA_BUCKET?: R2Bucket
  ORGANIZATION_CACHE?: KVNamespace
  GUEST_INBOX_HUBS?: DurableObjectNamespace
  db?: ReturnType<typeof createDb>
  [key: string]: ApiValue
}

export function shouldBypassE2eAuthRateLimit(
  env: Pick<CloudflareEnv, 'E2E_ALLOW_DEV_ROUTES' | 'E2E_DEV_ROUTE_SECRET'>,
  request: Request,
): boolean {
  if (env.E2E_ALLOW_DEV_ROUTES !== 'true') return false
  const expectedSecret = env.E2E_DEV_ROUTE_SECRET?.trim() ?? ''
  const providedSecret = request.headers.get('x-dev-route-secret') ?? ''
  return !!expectedSecret
    && !!providedSecret
    && timingSafeEqualText(providedSecret, expectedSecret)
}

// WeakMap keyed on the D1 binding instance — safe for the Worker lifecycle
const authCache = new WeakMap<D1Database, unknown>()

// The same normalization every trusted-origin comparison in this file relies on.
export function normalizeOrigin(value: string | undefined): string | null {
  const trimmed = value?.trim().replace(/\/$/, '')
  if (!trimmed) return null
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    return new URL(withProtocol).origin
  } catch {
    return null
  }
}

function wildcardOrigin(origin: string | null): string | null {
  if (!origin) return null
  const url = new URL(origin)
  return `${url.protocol}//*.${url.host}`
}

export function localDevelopmentOrigin(value: string | undefined): string | null {
  const origin = normalizeOrigin(value)
  if (!origin) return null
  const url = new URL(origin)
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return null
  return origin
}

function trustedOriginsForAuth(env: CloudflareEnv): string[] | ((_request?: Request) => string[]) {
  const origins = new Set<string>()
  const authOrigin = normalizeOrigin(env.BETTER_AUTH_URL)
  const platformOrigin = normalizeOrigin(env.NUXT_PUBLIC_PLATFORM_DOMAIN)
  const freeOrganizationOrigin = normalizeOrigin(env.NUXT_PUBLIC_FREE_ORGANIZATION_DOMAIN)
  for (const origin of [authOrigin, platformOrigin, freeOrganizationOrigin, wildcardOrigin(freeOrganizationOrigin)]) {
    if (origin) origins.add(origin)
  }
  if (import.meta.dev || env.E2E_ALLOW_DEV_ROUTES === 'true') {
    const port = env.PORT || '3000'
    if (import.meta.dev) {
      origins.add(`http://localhost:${port}`)
      origins.add(`http://127.0.0.1:${port}`)
      origins.add(`http://*.localhost:${port}`)
    }

    return (request?: Request) => {
      const requestOrigin = request && (import.meta.dev || shouldBypassE2eAuthRateLimit(env, request))
        ? localDevelopmentOrigin(request.headers.get('origin') ?? undefined)
        : null
      return requestOrigin ? [...origins, requestOrigin] : [...origins]
    }
  }
  return [...origins]
}

/**
 * What has to hold, and what has to be undone elsewhere, before an account is
 * deleted (docs/shared-auth-contract.md D6). Each step fails the deletion: the
 * account stays until all of them succeed.
 */
async function prepareAccountDeletion(env: CloudflareEnv, db: ReturnType<typeof createDb>, userId: string, request: Request | undefined) {
  // An organization keeps an owner. Deleting its only owner would leave a
  // business nobody can manage, so ownership is transferred or the
  // organization deleted first.
  const soleOwned = await queryAll<{ name: string }>(db, `
    SELECT o.name FROM member m JOIN organization o ON o.id = m."organizationId"
    WHERE m."userId" = ? AND (',' || m.role || ',') LIKE '%,owner,%'
      AND NOT EXISTS (
        SELECT 1 FROM member other
        WHERE other."organizationId" = m."organizationId" AND other."userId" <> m."userId"
          AND (',' || other.role || ',') LIKE '%,owner,%'
      )
    ORDER BY o.name
  `, [userId])
  if (soleOwned.length) {
    throw new APIError('BAD_REQUEST', {
      code: 'SOLE_ORGANIZATION_OWNER',
      message: `Transfer ownership of, or delete, ${soleOwned.map(organization => organization.name).join(', ')} before deleting your account.`,
    })
  }

  // An account signed in with Apple proves it again at deletion so its grant can be revoked.
  const appleAccount = await queryFirst<{ accountId: string }>(db, `SELECT "accountId" FROM account WHERE "userId" = ? AND "providerId" = 'apple'`, [userId])
  const appleCode = request?.headers.get(APPLE_AUTHORIZATION_CODE_HEADER)?.trim()
  if (appleAccount && !appleCode) {
    throw new APIError('BAD_REQUEST', { code: 'APPLE_REAUTHENTICATION_REQUIRED', message: 'Sign in with Apple again to delete this account.' })
  }
  if (!appleAccount && appleCode) {
    throw new APIError('BAD_REQUEST', { code: 'APPLE_ACCOUNT_MISMATCH', message: 'This account has no Apple ID linked.' })
  }
  const appleGrant = appleAccount && appleCode ? await exchangeAppleAuthorizationCode(env, appleCode, appleAccount.accountId) : null

  if (await hasLodgingMembership(db, userId)) await deleteLodgingUser(env, userId)
  if (appleGrant) await revokeAppleGrant(env, appleGrant)
}

export function createAuth(env: CloudflareEnv) {
  if (!env?.DB) throw new HTTPError({ statusCode: 503, statusMessage: 'Database unavailable' })
  const d1 = unwrapInstrumentedD1(env.DB)
  const cached = authCache.get(d1)
  if (cached) return cached as ReturnType<typeof buildAuth>
  return buildAuth(env)
}

function buildAuth(env: CloudflareEnv) {
  const d1 = unwrapInstrumentedD1(env.DB)
  const db = d1 === env.DB && env.db ? env.db : createDb(d1)
  // Members are indexed for the dashboard's search; a change to one is a change
  // to every site of the organization. Better Auth has already committed the
  // member row by the time its after-hook runs, and D1 has no transaction a
  // hook could join, so the change record and the audit row commit together
  // with each other, and a failure of either reaches the caller.
  const recordMemberChange = async (organizationId: string, audit: BatchQuery[] = []) => {
    await executeBatch(db, [publicResourceCacheInvalidationQuery(organizationId, 'member-change'), ...audit])
  }
  const configuredOrganizationOptions = {
    ...organizationOptions,
    organizationHooks: {
      beforeCreateOrganization: async ({ organization }: { organization: Record<string, unknown> }) => assertOrganizationFacts(organization),
      beforeUpdateOrganization: async ({ organization }: { organization: Record<string, unknown> }) => assertOrganizationFacts(organization),
      // A removed member or changed role reads differently on every site, and
      // a lodging organization's Worker closes that member's live sockets and
      // drops their home assignments. Better Auth's /organization/leave runs
      // no member hook, so the after-hook below covers it.
      afterRemoveMember: async ({ member, organization }: { member: { userId: string }; organization: { id: string } }) => {
        await recordMemberChange(organization.id)
        if (await isLodgingOrganization(db, organization.id)) await notifyLodgingMembershipChanged(env, { organizationId: organization.id, userId: member.userId, change: 'removed' })
      },
      afterUpdateMemberRole: async ({ member, organization }: { member: { userId: string; role: string }; organization: { id: string } }) => {
        await recordMemberChange(organization.id)
        if (await isLodgingOrganization(db, organization.id)) await notifyLodgingMembershipChanged(env, { organizationId: organization.id, userId: member.userId, change: 'role_changed', role: member.role })
      },
      afterAddTeamMember: async ({ team, user }: { team: { organizationId: string }; user: { id: string } }) => {
        const { materializeMemberSessions } = await import('~/server/utils/availability')
        await materializeMemberSessions(db, { organizationId: team.organizationId, userId: user.id, actorId: 'system' })
        await recordMemberChange(team.organizationId)
      },
      afterRemoveTeamMember: async ({ team }: { team: { organizationId: string } }) => recordMemberChange(team.organizationId),
      afterDeleteTeam: async ({ team }: { team: { organizationId: string } }) => recordMemberChange(team.organizationId),
      afterUpdateTeam: async ({ organization }: { organization: { id: string } }) => recordMemberChange(organization.id),
    },
    sendInvitationEmail: async (data: {
      id: string
      role: string
      email: string
      organization: { id: string; name: string }
      inviter: { user: { name: string; email: string } }
      invitation: { expiresAt: Date; inviterId: string }
    }) => {
      await notifyOrganizationInvited(env, db, {
        organizationId: data.organization.id,
        invitationId: data.id,
        expiresAt: data.invitation.expiresAt.toISOString(),
        inviterUserId: data.invitation.inviterId,
        email: data.email,
        role: data.role,
        organizationName: data.organization.name,
        inviterName: data.inviter.user.name || data.inviter.user.email,
      })
    },
  } as const
  const authBaseUrl = env.BETTER_AUTH_URL?.replace(/\/$/, '')
  if (!authBaseUrl) throw new Error('BETTER_AUTH_URL is required')
  if (!env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY is required')
  const stripeClient = createStripeClient(env.STRIPE_SECRET_KEY)
  const loadStripePlans = createStripePlanLoader(stripeClient, env)

  const instance = betterAuth({
    baseURL: authBaseUrl,
    onAPIError: { errorURL: `${authBaseUrl}/oauth/error` },
    basePath: '/api/auth',
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: trustedOriginsForAuth(env),
    // A phone number is a notification channel a signed-in person verifies, never
    // a way to sign in. The phone plugin's password sign-in and reset are off, and
    // its verify is accepted only as an update of the caller's own number: without
    // updatePhoneNumber it signs in whoever holds that number.
    //
    // An administrator does not delete accounts: /admin/remove-user would skip
    // the ownership guard, Apple revocation and lodging cleanup that
    // /delete-user runs in deleteUser.beforeDelete.
    disabledPaths: ['/sign-in/phone-number', '/phone-number/request-password-reset', '/phone-number/reset-password', '/admin/remove-user'],
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path === '/phone-number/verify' && ctx.body?.updatePhoneNumber !== true) {
          throw new APIError('BAD_REQUEST', { message: 'A phone number is verified from your account profile, not used to sign in.' })
        }
      }),
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path === '/organization/leave') {
          const left = ctx.context.returned
          if (left instanceof Error || !ctx.context.session) return
          const organizationId = (ctx.body as { organizationId: string }).organizationId
          await recordMemberChange(organizationId)
          if (await isLodgingOrganization(db, organizationId)) await notifyLodgingMembershipChanged(env, { organizationId, userId: ctx.context.session.user.id, change: 'removed' })
          return
        }
        if (ctx.path !== '/callback/:id') return
        const state = await getOAuthState()
        const location = ctx.context.responseHeaders?.get('location')
        if (!state?.link || !location) return
        const callback = new URL(state.callbackURL, authBaseUrl)
        // Only a successful integration link continues to resource selection.
        if (new URL(location, authBaseUrl).href !== callback.href) return
        const integration = callback.pathname.match(/^\/dashboard\/[^/]+\/integrations\/(facebook|instagram|discord|google-analytics|google-search-console|google-calendar|google-ads)$/)?.[1]
          ?? (/^\/dashboard\/[^/]+\/calendar\/settings\/availability\/google-calendar$/.test(callback.pathname) || /^\/dashboard\/account\/profile\/calendar\/[^/]+\/google-calendar$/.test(callback.pathname) ? 'google-calendar' : undefined)
        if (!integration) return
        const provider = integration.startsWith('google-') ? 'google' : integration
        if (ctx.params?.id !== provider) return
        const accountId = (ctx.context as IntegrationCallbackContext).integrationAccountId
        if (accountId) callback.searchParams.set('account_id', accountId)
        else callback.searchParams.set('error', 'unable_to_link_account')
        // No account list, timestamp guess, credential copy or custom OAuth state.
        throw ctx.redirect(callback.href)
      }),
    },
    // Better Auth reads the session from the database on every getSession call,
    // and a dashboard render makes several: the route middleware, the capability
    // check, the SSR context loader and the page's own loader each ask
    // independently. Measured on a tenant-page editor render: 63 auth queries,
    // 68 D1 round trips in total.
    //
    // This is Better Auth's own answer, from its performance guide: the session
    // travels in a short-lived signed cookie, so validity is read from the cookie
    // instead of the database. Documented trade: "revoked sessions may remain
    // active on other devices until the cookie cache expires (maxAge)."
    session: {
      cookieCache: {
        enabled: true,
        maxAge: 5 * 60, // Cache duration in seconds
        // Better Auth refreshes the v16 boolean contract from the same session.
        version: 'v16',
      },
    },
    user: {
      // POST /delete-user is the one way an account is deleted
      // (/admin/remove-user is disabled), so everything that must hold or be
      // undone before the account goes runs here, before Better Auth deletes
      // its sessions, accounts and user row.
      deleteUser: {
        enabled: true,
        beforeDelete: async (user, request) => prepareAccountDeletion(env, db, user.id, request),
      },
    },
    rateLimit: {
      customRules: {
        '/sign-in/*': (request, currentRule) => shouldBypassE2eAuthRateLimit(env, request)
          ? false
          : currentRule,
      },
    },
    database: drizzleAdapter(db, {
      provider: 'sqlite',
      schema,
    }),
    databaseHooks: {
      session: {
        create: {
          after: async (session) => {
            const user = await (await createAuth(env).$context).adapter.findOne<Pick<UserWithAnonymous, 'id' | 'email' | 'emailVerified' | 'isAnonymous'>>({
              model: 'user', where: [{ field: 'id', value: session.userId }], select: ['id', 'email', 'emailVerified', 'isAnonymous'],
            })
            if (!user) throw new Error('A session was created for a user that does not exist')
            await linkGuestIdentitiesByVerifiedEmail(db, user)
          },
        },
      },
      account: {
        create: { after: integrationAccountLinked },
        update: { after: integrationAccountLinked },
      },
      user: {
        delete: {
          before: async (user) => {
            // A deleted account's Customer at every business it paid goes with it, and the cards saved there.
            await deleteBuyerCustomers(db, stripeClient, user.id)
            await execute(db, "DELETE FROM activity_entries WHERE kind='notification' AND scope_kind='global' AND target_user_id=?", [user.id])
          },
        },
        update: {
          after: async (user) => {
            // A renamed member reads under the new name wherever they are a member.
            const memberships = await queryAll<{ organizationId: string }>(db, 'SELECT "organizationId" FROM member WHERE "userId" = ?', [user.id])
            for (const membership of memberships ?? []) await recordMemberChange(membership.organizationId)
          }
        },
        create: {
          after: async (user, context) => {
            if ((user as { isAnonymous?: boolean }).isAnonymous) return
            // Organizations are created on demand — either by organization-provisioning.ts
            // (first site) or by an admin/invitation flow the user is joining.
            // Signup itself must not assume why the user is here: they may be
            // accepting an invitation into an existing org, in which case a
            // personal org here would just be an orphaned, siteless duplicate.
            await notifyNewUserSignup(db)
            // One registered account, once per user, through every way an
            // account is created (password, social, phone, an anonymous guest
            // becoming a user). Login, provider linking and invitation
            // acceptance by an existing user never reach this hook. A user an
            // admin created did not register. Only a request that already
            // carries the visitor's analytics cookies gives the event a
            // browser session.
            if (context?.path === '/admin/create-user') return
            const [result] = await Promise.allSettled([(async () => {
              await recordAndDeliverConversion(env, db, context?.request ?? null, {
                organizationId: (await getPlatformOrganization(db)).id,
                eventName: 'sign_up', stage: 'completed', surface: 'auth',
                entityType: 'user', entityId: user.id,
                originEventId: readPageEventId(context?.request?.headers.get('x-analytics-page-event')),
              })
            })()])
            const measurement = measurementOutcome(result!)
            // The user already exists. Report measurement separately from the auth result,
            // including for internal creations that have no HTTP response context.
            context?.setHeader('x-signup-measurement', encodeURIComponent(JSON.stringify(measurement)))
            if (measurement.status === 'failed') console.error('signup_measurement_failed', { userId: user.id, reason: measurement.reason })
          }
        }
      },
      // Better Auth's org-plugin after-hooks only pass the affected row, not the
      // acting session, so member.update/delete events are attributed to no actor.
      member: {
        create: {
          after: async (member: MemberRow) => {
            await recordMemberChange(member.organizationId)
          }
        },
        update: {
          after: async (member: MemberRow) => {
            await recordMemberChange(member.organizationId, [organizationEventQuery({
              organizationId: member.organizationId,
              eventType: 'member.role_changed',
              entityType: 'member',
              entityId: member.id,
              metadata: { userId: member.userId, role: member.role },
            })])
          }
        },
        delete: {
          after: async (member: MemberRow) => {
            await recordMemberChange(member.organizationId, [organizationEventQuery({
              organizationId: member.organizationId,
              eventType: 'member.removed',
              entityType: 'member',
              entityId: member.id,
              metadata: { userId: member.userId },
            })])
          }
        }
      },
    },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      minPasswordLength: 8,
      maxPasswordLength: 128,
      password: {
        async hash(password: string) {
          const passwordError = validatePassword(password)
          if (passwordError) {
            throw APIError.from('BAD_REQUEST', {
              code: 'INVALID_PASSWORD',
              message: passwordError,
            })
          }
          return hashPassword(password)
        },
      },
      autoSignIn: false,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => {
        await sendPasswordResetEmail(env, {
          email: user.email,
          resetUrl: url,
        }).catch(async (error) => {
          // Better Auth keeps the reset response generic to prevent enumeration.
          // Its callback failure must still be visible to platform operators.
          await createCanonicalNotification(db, {
            scope: 'global',
            template: 'auth.reset_password_email_failed',
            severity: 'error',
            title: 'Password reset email failed',
            message: error instanceof Error ? error.message : String(error),
          })
          throw error
        })
      },
      onPasswordReset: async ({ user }) => {
        console.info('auth_password_reset_complete', { email: user.email })
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      sendOnSignIn: true,
      autoSignInAfterVerification: false,
      sendVerificationEmail: async ({ user, url }) => {
        await sendVerificationEmail(env, {
          email: user.email,
          verificationUrl: url,
        }).catch(async (error) => {
          await createCanonicalNotification(db, {
            scope: 'global',
            template: 'auth.verification_email_failed',
            severity: 'error',
            title: 'Verification email failed',
            message: error instanceof Error ? error.message : String(error),
          })
          throw error
        })
      },
    },
    plugins: [
      bearer(),
      lastLoginMethod({ customResolveMethod: ctx => loginMethodForPath(ctx.path, ctx.body) }),
      jwt({
        // The plugin's default after-hook mints a fresh JWT on every
        // /get-session — reading the jwks row, decrypting the private key and
        // signing — purely to return a `set-auth-jwt` response header. Nothing
        // in this codebase reads that header; MCP and the OAuth provider get
        // their tokens from /api/auth/token and the oauthProvider plugin, which
        // are unaffected. Measured on a tenant-page editor render: 9 jwks reads
        // and 9 signatures for a header no caller consumes.
        disableSettingJwtHeader: true,
        jwks: {
          keyPairConfig: { alg: OAUTH_SIGNING_POLICY.algorithm },
        },
        jwt: {
          // Explicit issuer so oauthProvider's getOAuthServerConfig advertises the
          // same value as authorization_servers in /.well-known/oauth-protected-resource.
          // Without this, oauth-provider falls back to ctx.context.baseURL
          // (https://krabiclaw.com/api/auth) but jwt() signs with options.baseURL
          // (https://krabiclaw.com) — the mismatch causes ChatGPT to reject the connector.
          issuer: authBaseUrl,
        },
      }),
      anonymous({
        generateRandomEmail: () => `anon-${crypto.randomUUID()}@customers.krabiclaw.local`,
        // The anonymous user is deleted by the plugin right after this returns,
        // and every domain FK to it is ON DELETE SET NULL. Everything that
        // identifies the person moves to the real user first, in one batch.
        onLinkAccount: async ({ anonymousUser, newUser }) => {
          const from = anonymousUser.user.id
          const to = newUser.user.id
          if (from === to) return
          await executeBatch(db, anonymousLinkQueries(from, to, new Date().toISOString()), { operation: 'anonymous-account-link' })
        },
      }),
      oauthProvider({
        loginPage: '/oauth/login',
        consentPage: '/oauth/consent',
        allowPublicClientPrelogin: true,
        // Account selection is driven entirely by an explicit prompt=select_account
        // from the client (handled upstream in the provider before this hook runs).
        // shouldRedirect must stay false here — returning true unconditionally
        // re-forces select_account on every authorize call, including the one
        // fired by "Continue as X" on /oauth/login itself, producing an infinite
        // login <-> authorize redirect loop.
        selectAccount: {
          page: '/oauth/login',
          shouldRedirect: async () => false,
        },
        allowDynamicClientRegistration: false,
        allowUnauthenticatedClientRegistration: false,
        enforcePerClientResources: false,
        scopes: ['openid', 'email', 'offline_access', 'tenant'],
        ...oauthSigningConfig(authBaseUrl),
        // Well-known metadata is served at /api/auth/.well-known/* by the plugin's
        // onRequest hook. Root-level /.well-known/* are covered by Nitro routes.
        silenceWarnings: {
          oauthAuthServerConfig: true,
          openidConfig: true,
        },
      }),
      cimd({
        // Required: @better-auth/cimd hands the network boundary to the
        // application. See server/utils/cimd-metadata-fetch.ts.
        fetchClientMetadataResource: fetchCimdMetadataResource,
      }),
      organization(configuredOrganizationOptions),
      betterAuthStripe({
        stripeClient,
        stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET ?? '',
        organization: { enabled: true },
        subscription: {
          enabled: true,
          plans: () => loadStripePlans(),
          requireEmailVerification: true,
          authorizeReference: async ({ user, referenceId }, ctx) => {
            const member = await getOrgAdapter(ctx.context, configuredOrganizationOptions).findMemberByOrgId({
              userId: user.id,
              organizationId: referenceId,
            })
            if (!member) return false
            return await hasPermission({
              organizationId: referenceId,
              role: member.role,
              options: configuredOrganizationOptions,
              permissions: { billing: ['update'] },
            }, ctx)
          },
        },
        // The plugin's own /api/auth/stripe/webhook handlers own the
        // `subscription` table, and Stripe's delivery retries are the retry
        // mechanism. This hook adds analytics, Payments status alerts, Payments fees
        // billing set-up and fee report ingestion; a throw here returns a non-2xx so
        // Stripe redelivers the event.
        onEvent: async (event) => {
          await handleStripeGa4Event(env, db, stripeClient, event)
          await notifyPaymentsInvoiceEvent(db, stripeClient, env, event)
          await setUpPaymentsBillingForSubscriptionEvent(db, stripeClient, env, event)
          await ingestStripeFeeReportEvent(db, stripeClient, env, event)
        },
      }),
      organizationDeletionCleanupPlugin(env),
      admin({
        ac: platformAdminAccessControl,
        adminRoles: ['admin'],
        defaultRole: 'user',
        roles: platformAdminRoles,
        impersonationSessionDuration: 15 * 60,
      }),
      phoneNumber({
        sendOTP: async ({ phoneNumber: phone, code }) => {
          try {
            await sendWhatsAppOtp(env, phone, code)
          } catch (error) {
            console.error('auth_whatsapp_otp_failed', {
              error: error instanceof Error ? error.message : String(error),
            })
            throw error
          }
        },
        otpLength: 6,
        expiresIn: 300,
        phoneNumberValidator: async (phone) => {
          try {
            parsePhoneOrThrow(phone)
            return true
          } catch {
            return false
          }
        },
      }),
      // Instagram Login for professional accounts has no built-in Better Auth
      // provider, so it is a Generic OAuth provider on the same linkSocial path
      // as Google and Facebook. Its code exchange is not the standard one — the
      // grant answers a one-hour token that must be traded for the sixty-day
      // one — so getToken performs both and Better Auth stores the result.
      // Renewing that token is the one step Better Auth cannot perform (see
      // instagramAccessToken in server/utils/instagram.ts).
      genericOAuth({
        config: [{
          providerId: 'instagram',
          clientId: env.INSTAGRAM_APP_ID ?? '',
          clientSecret: env.INSTAGRAM_APP_SECRET,
          authorizationUrl: 'https://www.instagram.com/oauth/authorize',
          scopes: ['instagram_business_basic', 'instagram_business_content_publish', 'instagram_business_manage_insights'],
          pkce: false,
          disableSignUp: true,
          getToken: async ({ code, redirectURI }) => {
            if (!env.INSTAGRAM_APP_ID || !env.INSTAGRAM_APP_SECRET) throw new Error('Missing Instagram OAuth configuration')
            const grant = await fetch('https://api.instagram.com/oauth/access_token', {
              method: 'POST',
              headers: { 'content-type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({
                client_id: env.INSTAGRAM_APP_ID,
                client_secret: env.INSTAGRAM_APP_SECRET,
                grant_type: 'authorization_code',
                redirect_uri: redirectURI,
                code,
              }),
            })
            if (!grant.ok) throw new Error(`Instagram token exchange failed: ${(await grant.text()).slice(0, 300)}`)
            // Documented as `{ data: [{ access_token, user_id, permissions }] }`
            // (developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login).
            type Grant = { access_token?: string; permissions?: string | string[] }
            const body = await grant.json() as Grant & { data?: Grant[] }
            const shortLived = body.data?.[0] ?? body
            if (!shortLived.access_token) throw new Error('Instagram did not return an access token')

            const exchange = await fetch(`https://graph.instagram.com/access_token?${new URLSearchParams({
              grant_type: 'ig_exchange_token',
              client_secret: env.INSTAGRAM_APP_SECRET,
              access_token: shortLived.access_token,
            })}`)
            if (!exchange.ok) throw new Error(`Instagram long-lived token exchange failed: ${(await exchange.text()).slice(0, 300)}`)
            const longLived = await exchange.json() as { access_token?: string; expires_in?: number }
            if (!longLived.access_token || typeof longLived.expires_in !== 'number') {
              throw new Error('Instagram did not return a long-lived access token and its lifetime')
            }
            const permissions = shortLived.permissions ?? []
            return {
              tokenType: 'bearer',
              accessToken: longLived.access_token,
              accessTokenExpiresAt: new Date(Date.now() + longLived.expires_in * 1000),
              scopes: Array.isArray(permissions) ? permissions : permissions.split(',').filter(Boolean),
            }
          },
          // `id` is the app-scoped id Meta's deauthorize and data-deletion
          // callbacks name, so it is the Better Auth account id; `user_id` is
          // the professional account publishing addresses, which the
          // organization stores with its selection.
          getUserInfo: async (tokens) => {
            const response = await fetch(`https://graph.instagram.com/v23.0/me?${new URLSearchParams({
              fields: 'id,user_id,username',
              access_token: tokens.accessToken ?? '',
            })}`)
            if (!response.ok) throw new Error(`Instagram account lookup failed: ${(await response.text()).slice(0, 300)}`)
            const account = await response.json() as { id?: string; username?: string }
            if (!account.id || !account.username) throw new Error('Instagram did not return the connected account')
            return { id: account.id, name: account.username, email: null, emailVerified: false }
          },
        }],
      }),
    ],
    socialProviders: {
      // The native app signs in with the identity token Sign in with Apple hands
      // it. Better Auth verifies that token against Apple's keys with the app's
      // bundle id as audience, so no client secret is involved and there is no
      // web redirect flow. Apple is not a trusted linking provider: an existing
      // account links it explicitly, and only with a verified email claim.
      apple: {
        clientId: env.APPLE_APP_BUNDLE_ID,
        appBundleIdentifier: env.APPLE_APP_BUNDLE_ID,
      },
      google: {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        prompt: 'select_account',
      },
      // Facebook Login for Business: a configuration id carries the Page
      // permissions and yields a system-user token that does not expire, so
      // there is nothing to refresh. It is linked to a Krabiclaw user for Page
      // access, never used to create one.
      facebook: {
        clientId: env.FACEBOOK_APP_ID ?? '',
        clientSecret: env.FACEBOOK_APP_SECRET ?? '',
        configId: env.FACEBOOK_CONFIG_ID,
        // The configuration carries every permission. Meta refuses a scope
        // list beside config_id ("Invalid Scopes"), including Better Auth's
        // default email and public_profile, so none is sent.
        disableDefaultScope: true,
        disableSignUp: true,
      },
      // Linked to a Krabiclaw user to choose where posts go, never used to
      // create one. The `bot` scope adds the KrabiClaw bot, with these
      // permissions, to the server the owner picks on Discord's consent screen.
      discord: {
        clientId: env.DISCORD_CLIENT_ID ?? '',
        clientSecret: env.DISCORD_CLIENT_SECRET ?? '',
        permissions: DISCORD_BOT_PERMISSIONS,
        disableSignUp: true,
      },
    },
    account: {
      // Integration tokens live on these rows; Better Auth encrypts them with
      // BETTER_AUTH_SECRET and reads rows written before this was set as-is.
      encryptOAuthTokens: true,
      accountLinking: {
        enabled: true,
        // Facebook, Instagram and Discord are linked only from an authenticated
        // session, for Page and publishing access. Instagram returns no email
        // at all and a business's Facebook or Google account is rarely the
        // address its owner signs in with, so linking may not require one.
        trustedProviders: ['google', 'facebook', 'instagram', 'discord'],
        allowDifferentEmails: true,
      }
    }
  })

  authCache.set(d1, instance)
  return instance
}

export async function findVerifiedAuthUserByPhone(
  env: CloudflareEnv,
  phoneNumber: string,
): Promise<{ id: string; phoneNumber: string; phoneNumberVerified: boolean } | null> {
  const context = await createAuth(env).$context
  return await context.adapter.findOne({
    model: 'user',
    where: [
      { field: 'phoneNumber', value: phoneNumber },
      { field: 'phoneNumberVerified', value: true },
    ],
  })
}

export type AuthUserIdentity = Pick<ReturnType<typeof createAuth>['$Infer']['Session']['user'], 'id' | 'name' | 'image'>

// content_documents stores author_id as a plain
// reference — that's fine, it's just a foreign-looking string, not a query.
// The name/image shown next to an author is Better Auth's data, so it must be
// read through Better Auth's own adapter (findMany, batched by id) rather than
// a raw SQL join against the user table.
export async function findAuthUsersByIds(env: CloudflareEnv, userIds: Array<string | null | undefined>): Promise<Map<string, AuthUserIdentity>> {
  const uniqueIds = Array.from(new Set(userIds.filter((id): id is string => Boolean(id))))
  if (uniqueIds.length === 0) return new Map()

  const context = await createAuth(env).$context
  const rows = await context.adapter.findMany<AuthUserIdentity>({
    model: 'user',
    where: [{ field: 'id', operator: 'in', value: uniqueIds }],
    select: ['id', 'name', 'image'],
    limit: uniqueIds.length,
  })
  return new Map(rows.map(row => [row.id, row]))
}

/**
 * A Better Auth linked account, as an integration refers to it: the row an
 * organization names by `account_id`, the user it belongs to, and the scopes
 * Better Auth recorded across every link of it.
 */
type LinkedAccount = Pick<Account, 'id' | 'userId' | 'providerId' | 'accountId' | 'scope'>

/** Reads a linked account through Better Auth's adapter. Null when it has been unlinked. */
export async function readLinkedAccount(env: CloudflareEnv, accountId: string): Promise<LinkedAccount | null> {
  const context = await createAuth(env).$context
  return context.adapter.findOne<LinkedAccount>({
    model: 'account',
    where: [{ field: 'id', value: accountId }],
    select: ['id', 'userId', 'providerId', 'accountId', 'scope'],
  })
}

/**
 * A usable access token for a linked account, refreshed by Better Auth when
 * it has expired.
 *
 * Called without request headers and with the account's own user: an
 * organization acts through the account it selected, which may have been
 * linked by another of its administrators, and Better Auth resolves a
 * session's user ahead of the one named here.
 */
export async function linkedAccountAccessToken(
  env: CloudflareEnv,
  accountId: string,
): Promise<{ accessToken: string; accessTokenExpiresAt: Date | undefined }> {
  const account = await readLinkedAccount(env, accountId)
  if (!account) throw new Error('The account this integration was connected through is no longer linked. Connect it again.')
  let token
  try {
    token = await createAuth(env).api.getAccessToken({ body: { accountId, userId: account.userId } })
  } catch (error) {
    if (!isAPIError(error)) throw error
    // Better Auth's status is a name (BAD_REQUEST); Nitro needs its numeric statusCode.
    throw new HTTPError({
      statusCode: error.statusCode,
      message: error.body?.code ? `${error.body.code}: ${error.message}` : error.message,
      data: error.body,
      cause: error,
    })
  }
  if (!token.accessToken) throw new Error(`Better Auth returned no access token for the linked ${account.providerId} account.`)
  return { accessToken: token.accessToken, accessTokenExpiresAt: token.accessTokenExpiresAt }
}

/**
 * The linked account an organization may be connected through: one the
 * caller linked themselves, or the one the organization already uses. Another
 * member's account is never selectable by naming its id, and an account that
 * was not granted what the integration needs is refused rather than failing
 * later at the provider.
 */
export async function requireIntegrationAccount(
  env: CloudflareEnv,
  accountId: string,
  expected: { userId: string; currentAccountId: string | null | undefined; providerId: string; scopes: readonly string[] },
): Promise<LinkedAccount> {
  const account = await readLinkedAccount(env, accountId)
  if (!account || account.providerId !== expected.providerId
    || (account.userId !== expected.userId && account.id !== expected.currentAccountId)) {
    throw new HTTPError({ statusCode: 404, message: 'That account is not linked to you.' })
  }
  const missing = expected.scopes.filter(scope => !account.scope?.split(',').some(granted => granted.trim() === scope))
  if (missing.length) {
    throw new HTTPError({ statusCode: 403, message: `That account has not granted ${missing.join(', ')}. Connect it again.` })
  }
  return account
}

export async function getAuthSession(event: H3Event, env: CloudflareEnv): Promise<Awaited<ReturnType<ReturnType<typeof createAuth>['api']['getSession']>>> {
  return createAuth(env).api.getSession({
    headers: event.req.headers,
  })
}

/**
 * The Better Auth user a public durable interaction belongs to.
 *
 * A request with a session keeps that user, anonymous or not. A request with
 * none gets a new anonymous Better Auth user, and the session cookie Better Auth
 * issues for it is forwarded on this response so the next interaction from the
 * same browser reuses it. Call it only once the write is about to happen: a page
 * view or a rejected submission must not mint an identity.
 */
export async function ensureInteractionUser(event: H3Event, env: CloudflareEnv): Promise<string> {
  const session = await getAuthSession(event, env)
  if (session?.user) return session.user.id
  const auth = createAuth(env)
  const { headers, response } = await auth.api.signInAnonymous({
    headers: event.req.headers,
    returnHeaders: true,
  })
  if (!response?.user?.id) throw new Error('Better Auth did not return an anonymous user')
  for (const cookie of headers.getSetCookie()) {
    event.res.headers.append('set-cookie', cookie)
  }
  return response.user.id
}
