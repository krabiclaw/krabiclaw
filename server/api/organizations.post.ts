import { platformLocale } from '~/shared/platform-locales'
import { defineHandler } from 'nitro';
import { readBody } from 'nitro/h3';
import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { getAuthSession } from '~/server/utils/auth'
import { resolveRequestedOrganization } from '~/server/utils/dashboard-context'
import { activateSessionOrganization } from '~/server/utils/session-organization'
import { provisionOrganization, VALID_VERTICALS } from '~/server/utils/organization-provisioning'
import type { OrganizationVertical } from '~/utils/vertical-copy'

// Provisions an organization the caller already belongs to: gives it its
// address, its template and its seeded structure. The organization is explicit:
// the dashboard sends the route's `org` query param (dashboardFetch), API
// callers send `organizationId` in the body. Nothing is inferred from memberships.
export default defineHandler(async (event) => {
  const body = await readBody<{ name?: string; subdomain?: string; vertical?: string; organizationId?: string; sourceLocale?: string }>(event)
  const name = body?.name?.trim()
  const subdomain = body?.subdomain?.trim()
  const vertical = body?.vertical
  const explicitOrganizationId = body?.organizationId?.trim() || null

  if (!name || !subdomain) {
    return jsonResponse({ error: 'name and subdomain are required' }, { status: 400 })
  }
  if (!vertical || !VALID_VERTICALS.includes(vertical as OrganizationVertical)) {
    return jsonResponse({
      error: `vertical is required and must be one of: ${VALID_VERTICALS.join(', ')}`
    }, { status: 400 })
  }
  const sourceLocale = typeof body?.sourceLocale === 'string' ? body.sourceLocale : ''
  if (!platformLocale(sourceLocale)) return jsonResponse({ error: 'sourceLocale is required and must name a supported website language' }, { status: 400 })

  const env = cloudflareEnv(event)
  const db = env.DB
  if (!db) return jsonResponse({ error: 'Database not available' }, { status: 500 })

  const session = await getAuthSession(event, env)
  if (!session?.user?.id) return jsonResponse({ error: 'Authentication required' }, { status: 401 })

  const organization = await resolveRequestedOrganization(event, db, session.user.id, { explicitOrganizationId })
  if (!organization) {
    return jsonResponse({
      error: 'organizationId (or the dashboard `org` query param) is required and must name an organization you belong to',
    }, { status: 400 })
  }

  const result = await provisionOrganization(env, db, session.user.id, {
    organizationId: organization.id,
    name,
    subdomain,
    vertical: vertical as OrganizationVertical,
    sourceLocale,
    origin: event.req,
  })
  // Provisioning is not finished until the caller's session is on the new
  // organization; without it they are returned to a dashboard that cannot see
  // the tenant they just created. Swallowing this reported a completed
  // provisioning that had half happened, which is worse to debug than a 500.
  if (result.status === 200) await activateSessionOrganization(event, env, organization.id)
  return jsonResponse(result.data, { status: result.status })
})
