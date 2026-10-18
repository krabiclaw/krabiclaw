import { HTTPError } from 'nitro';
import type { H3Event } from 'nitro';
import { createDpopReplayStore } from 'better-auth/oauth2'
import { APIError, getEndpoints } from 'better-auth/api'
import { oauthProviderResourceClient } from '@better-auth/oauth-provider/resource-client'
import type { JWTPayload } from 'jose'
import { createAuth, getAuthSession, type CloudflareEnv } from '~/server/utils/auth'
import { hasPlatformEventPermission } from '~/server/utils/platform-admin-users'
import { queryFirst } from '~/server/db'
import { assertOrganizationWideAccess, isOrganizationWideRole, resolveOrganizationMembership, memberAccessPrincipal, type ResolvedMembership, roleAllows, type OrganizationPermissions } from '~/server/utils/member-access'
import { getOrganizationEntitlements } from '~/server/utils/billing-access'
import { cloudflareEnv } from '~/server/utils/api-response'
import { publicTenantVisibilitySql } from '~/server/utils/public-base'
import { tenantOrganizationOrigin } from '~/utils/tenant-organization-origin'

export type McpToolRole = 'owner' | 'admin' | 'member'

/**
 * The role floor each tool declares, as a permission.
 *
 * `minimumRole` stays on the tool definition because it is published to MCP
 * clients in `_meta`, but the decision it drives comes from the same matrix as
 * every other authorization in the repository (utils/organization-access.ts)
 * rather than from a rank ladder that could disagree with it. `member` is
 * scoped to assigned work; `admin` is the organization management floor;
 * `owner` owns billing and deletion.
 */
const TOOL_ROLE_PERMISSIONS: Record<McpToolRole, OrganizationPermissions> = {
  member: { scheduling: ['own'] },
  admin: { settings: ['update'] },
  owner: { organization: ['delete'] },
}

export interface McpUserContext {
  env: CloudflareEnv
  db: D1Database
  userId: string
  isPlatformAdmin: boolean
  scopes: string[]
  oauthClientId?: string | null
  sessionId?: string | null
  oauthClaims?: Pick<JWTPayload, 'jti' | 'iat' | 'exp'>
  // Only populated for session-based auth (ChowBot/dashboard) — bearer-token
  // auth (e.g. ChatGPT connector) has no browser session to read this from.
  activeOrganizationId?: string
}

export interface McpOrganizationContext extends McpUserContext {
  organizationId: string
  organizationSlug?: string
  subdomain?: string | null
  customDomain?: string | null
  publicUrl?: string | null
  role: McpToolRole
  // The membership this call resolved for (organizationId, userId). Tool
  // executors authorize from it rather than pairing role with an organization
  // id from elsewhere.
  membership: ResolvedMembership
}

export interface RequireMcpUserOptions {
  audiences?: string[]
  requiredScopes?: string[]
}

export async function requireMcpUser(
  event: H3Event,
  options: RequireMcpUserOptions = {},
): Promise<McpUserContext> {
  const env = cloudflareEnv(event)
  const db = env?.DB
  if (!env || !db) {
    throw new HTTPError({ statusCode: 500, statusMessage: 'Database not available' })
  }

  const authHeader = (event.req.headers.get('authorization'))
  if (authHeader) {
    return await verifyOAuthRequest(event, authHeader, env, db, options)
  }

  const session = await getAuthSession(event, env)
  if (!session?.user?.id) {
    throw new HTTPError({ statusCode: 401, statusMessage: 'Authentication required' })
  }

  // Session-based auth has no token to derive scopes from, so the caller's
  // requested scopes are taken as granted; organization membership authorizes it.
  const sessionRecord = session.session as typeof session.session & { activeOrganizationId?: string }
  const user = {
    env,
    db,
    userId: session.user.id,
    isPlatformAdmin: await hasPlatformEventPermission(event, env, { platform: ['access'] }),
    scopes: options.requiredScopes ?? ['tenant'],
    sessionId: session.session.id,
    activeOrganizationId: typeof sessionRecord.activeOrganizationId === 'string' ? sessionRecord.activeOrganizationId : undefined,
  }
  return user
}

async function verifyOAuthRequest(
  event: H3Event,
  authorization: string,
  env: CloudflareEnv,
  db: D1Database,
  options: RequireMcpUserOptions,
): Promise<McpUserContext> {
  const baseUrl = env.BETTER_AUTH_URL?.replace(/\/$/, '')
  if (!baseUrl) throw new HTTPError({ statusCode: 500, statusMessage: 'BETTER_AUTH_URL is required' })
  const token = authorization.slice(authorization.indexOf(' ') + 1).trim()
  const tokenFingerprint = (await sha256Base64Url(token)).slice(0, 12)

  const audiences = options.audiences?.length
    ? options.audiences
    : [`${baseUrl}/api/mcp`]
  // Use ?? (not ?.length ? :) so a caller can explicitly opt out of any scope
  // requirement by passing requiredScopes: [].
  const requiredScopes = options.requiredScopes ?? ['tenant']
  const auth = createAuth(env)
  const context = await auth.$context

  let payload: JWTPayload & { client_id?: unknown }
  try {
    payload = await oauthProviderResourceClient(auth).getActions().verifyAccessTokenRequest({
      authorizationHeader: authorization,
      dpopProofJwt: event.req.headers.get('dpop'),
      method: event.req.method,
      url: event.req.url,
    }, {
      jwksUrl: `${baseUrl}/api/auth/jwks`,
      requiredScopes,
      verifyOptions: {
        audience: audiences,
        issuer: baseUrl,
      },
      dpop: { replayStore: createDpopReplayStore(context.internalAdapter) },
    })
  } catch (error) {
    // claimed_* fields are decoded WITHOUT signature verification — never use
    // them for auth decisions, only to see what a rejected token *claims*
    // (aud/exp/iss mismatches are otherwise invisible: the verifier only
    // reports a reason code, not the values that produced it).
    logMcpAuth(event, 'warn', 'credential_rejected', {
      path: event.path,
      token_fingerprint: tokenFingerprint,
      token_shape: token.split('.').length === 3 ? 'jwt' : 'opaque',
      reason: error instanceof Error ? error.message : String(error),
      audiences_checked: audiences,
      required_scopes: requiredScopes,
      now_iso: new Date().toISOString(),
      ...(await decodeJwtClaimsUnsafe(token)),
    })
    throw error
  }

  const scopes = parseScopesFromJwtPayload(payload.scope)

  const userId = typeof payload.sub === 'string' ? payload.sub : null
  if (!userId) {
    logMcpAuth(event, 'warn', 'credential_rejected', {
      path: event.path,
      token_fingerprint: tokenFingerprint,
      reason: 'subject_missing',
    })
    throw new APIError('UNAUTHORIZED', { message: 'The access token has no user identity' })
  }
  const oauthClientId = typeof payload.client_id === 'string' ? payload.client_id : null

  const isPlatformAdmin = await hasPlatformEventPermission(event, env, { platform: ['access'] })

  logMcpAuth(event, 'info', 'credential_accepted', {
    path: event.path,
    token_fingerprint: tokenFingerprint,
    audiences_checked: audiences,
  })

  return {
    env,
    db,
    userId,
    oauthClientId,
    sessionId: typeof payload.sid === 'string' ? payload.sid : null,
    oauthClaims: { jti: payload.jti, iat: payload.iat, exp: payload.exp },
    isPlatformAdmin,
    scopes,
  }
}

/** Native organization endpoints receive the already-authenticated MCP principal. */
export async function requireMcpOrganizationApi(event: H3Event | undefined, user: McpOrganizationContext) {
  const auth = createAuth(user.env)
  if (!event) throw new HTTPError({ statusCode: 500, statusMessage: 'Authenticated MCP request is required' })
  const headers = new Headers(event.req.headers)
  const authorization = headers.get('authorization')
  if (!authorization) return { api: auth.api, headers }
  const claims = user.oauthClaims
  if (!authorization.startsWith('Bearer ') || !claims || typeof claims.jti !== 'string' || !claims.jti
    || typeof claims.iat !== 'number' || !Number.isFinite(claims.iat) || typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)) {
    throw new HTTPError({ statusCode: 401, statusMessage: 'The verified OAuth identity is incomplete', data: { code: 'authentication_required' } })
  }
  const context = await auth.$context
  const currentUser = await context.internalAdapter.findUserById(user.userId)
  if (!currentUser) throw new HTTPError({ statusCode: 401, statusMessage: 'The authenticated user was not found', data: { code: 'authentication_required' } })
  // This per-call view uses the existing access token's identity and lifetime.
  // It carries no active browser workspace and creates no stored session.
  const api = getEndpoints(Promise.resolve({ ...context, session: {
    user: currentUser,
    session: { id: claims.jti, token: authorization.slice(7), userId: user.userId,
      createdAt: new Date(claims.iat * 1000), updatedAt: new Date(claims.iat * 1000), expiresAt: new Date(claims.exp * 1000) },
  } }), auth.options).api
  headers.delete('authorization')
  headers.delete('cookie')
  return { api, headers }
}

// Decodes a JWT's payload segment without verifying the signature — used only
// for diagnostic logging on a REJECTED token, so we can see what it claims
// (aud/exp/iss/sub) instead of just a reason code. Never use this output for
// an auth decision. Silently returns {} for opaque tokens or malformed JWTs.
// claimed_sub is hashed+truncated the same way token_fingerprint is — it's a
// stable per-user identifier decoded from an unverified token, so it's logged
// as a correlatable fingerprint rather than the raw id. aud/iss/scope aren't
// user-identifying (they're the resource URL and permission strings), so
// those are logged as-is for debugging value.
async function decodeJwtClaimsUnsafe(token: string): Promise<Record<string, unknown>> {
  const parts = token.split('.')
  if (parts.length !== 3) return {}
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Record<string, unknown>
    return {
      claimed_aud: Array.isArray(payload.aud) ? payload.aud.slice(0, 5).join(', ').substring(0, 100) : (typeof payload.aud === 'string' ? payload.aud.substring(0, 100) : null),
      claimed_iss: typeof payload.iss === 'string' ? payload.iss.substring(0, 100) : null,
      claimed_sub_fingerprint: typeof payload.sub === 'string' ? (await sha256Base64Url(payload.sub)).slice(0, 12) : null,
      claimed_scope: typeof payload.scope === 'string' ? payload.scope.substring(0, 200) : null,
      claimed_exp_iso: typeof payload.exp === 'number' ? new Date(payload.exp * 1000).toISOString() : null,
      claimed_iat_iso: typeof payload.iat === 'number' ? new Date(payload.iat * 1000).toISOString() : null,
    }
  } catch {
    return { claimed_decode_error: true }
  }
}

function logMcpAuth(
  event: H3Event,
  level: 'info' | 'warn',
  authEvent: string,
  fields: Record<string, unknown>,
) {
  console[level]('[MCP_AUTH]', JSON.stringify({
    event: authEvent,
    ray_id: (event.req.headers.get('cf-ray')) ?? null,
    user_agent: (event.req.headers.get('user-agent')) ?? null,
    ...fields,
  }))
}

async function sha256Base64Url(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Buffer.from(digest).toString('base64url')
}

function parseScopesFromJwtPayload(scopeClaim: unknown) {
  if (typeof scopeClaim !== 'string') return []
  return scopeClaim.split(' ').filter(Boolean)
}

export async function requireMcpOrganization(
  event: H3Event,
  organizationId: string,
  minimumRole: McpToolRole = 'admin',
  authenticatedUser?: McpUserContext,
): Promise<McpOrganizationContext> {
  const user = authenticatedUser ?? await requireMcpUser(event)

  const organization = await queryFirst<{ id: string; subdomain: string | null; custom_domain: string | null; public_url: string | null }>(
    user.db,
    `
      SELECT o.id, o.subdomain, (SELECT domain FROM organization_domains WHERE organization_id = o.id AND role = 'canonical' AND status = 'active' AND type = 'custom') AS custom_domain, (SELECT 'https://' || domain FROM organization_domains WHERE organization_id = o.id AND role = 'canonical' AND status = 'active' AND ${publicTenantVisibilitySql('o', false)}) AS public_url
      FROM organization o
      WHERE o.id = ?
      LIMIT 1
    `,
    [organizationId],
  )

  if (!organization) {
    throw new HTTPError({ statusCode: 404, statusMessage: 'Organization not found or access denied' })
  }
  const membership = await resolveOrganizationMembership(user.env, {
    organizationId: organization.id,
    userId: user.userId,
  })
  if (!membership) throw new HTTPError({ statusCode: 404, statusMessage: 'Organization not found or access denied' })

  const role = normalizeRole(membership.role)
  if (!role || !await roleSatisfies(organization.id, membership.role, minimumRole)) {
    throw new HTTPError({ statusCode: 403, statusMessage: 'Insufficient permissions' })
  }

  // Member tools check their own scheduling, service or appointment target.
  if (!isOrganizationWideRole(role) && minimumRole !== 'member') {
    await assertOrganizationWideAccess(user.db, memberAccessPrincipal(membership, { env: user.env }))
  }

  return {
    ...user,
    organizationId: organization.id,
    organizationSlug: membership.organizationSlug || undefined,
    subdomain: organization.subdomain ?? null,
    customDomain: organization.custom_domain ?? null,
    publicUrl: organization.public_url ? tenantOrganizationOrigin({
      platformDomain: user.env.NUXT_PUBLIC_PLATFORM_DOMAIN ?? '',
      freeOrganizationDomain: user.env.NUXT_PUBLIC_FREE_ORGANIZATION_DOMAIN ?? '',
      subdomain: organization.subdomain ?? '',
      canonicalDomain: organization.public_url,
    }) : null,
    role,
    // Kept so the tool executors authorize from the membership this call
    // resolved rather than reassembling one out of role and organizationId.
    membership,
  }
}

export async function getVisibleOrganizationContext(
  event: H3Event,
  organizationId: string,
): Promise<{ role: McpToolRole; organizationId: string } | null> {
  try {
    const context = await requireMcpOrganization(event, organizationId, 'member')
    return { role: context.role, organizationId: context.organizationId }
  } catch (error) {
    const statusCode = typeof (error as { statusCode?: unknown })?.statusCode === 'number'
      ? Number((error as { statusCode: number }).statusCode)
      : typeof (error as { status?: unknown })?.status === 'number'
        ? Number((error as { status: number }).status)
        : null
    if (statusCode === 403 || statusCode === 404) {
      return null
    }
    throw error
  }
}

export async function getActiveEntitlements(env: CloudflareEnv, organizationId: string, keys: string[]): Promise<Set<string>> {
  if (!keys.length) return new Set()
  const entitlements = await getOrganizationEntitlements(env, organizationId)
  return new Set(keys.filter(key => entitlements[key] === true))
}

export async function roleSatisfies(organizationId: string, actual: string, minimum: McpToolRole): Promise<boolean> {
  return await roleAllows({ organizationId, role: actual, permissions: TOOL_ROLE_PERMISSIONS[minimum] })
}

export function normalizeRole(role: string | null | undefined): McpToolRole | null {
  if (role === 'owner' || role === 'admin' || role === 'member') return role
  return null
}
