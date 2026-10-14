import { defineHandler } from 'nitro'
import { getQuery } from 'nitro/h3'

import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { getAuthSession } from '~/server/utils/auth'
import { organizationById, resolveOrganizationMembership } from '~/server/utils/member-access'

// Who is calling the lodging service, and as what in the organization it named.
// The lodging Worker forwards the native app's bearer session here on every
// request, so the session and the member row are read fresh each time: a bearer
// caller has no cookie cache, and membership is never cached.
export default defineHandler(async (event) => {
  const env = cloudflareEnv(event)
  const session = await getAuthSession(event, env)
  if (!session) return jsonResponse({ error: 'Authentication required' }, { status: 401 })

  const organizationId = getQuery(event).organizationId
  if (typeof organizationId !== 'string' || !organizationId.trim()) {
    return jsonResponse({ error: 'organizationId is required' }, { status: 400 })
  }

  const membership = await resolveOrganizationMembership(env, { organizationId, userId: session.user.id }, event)
  const organization = await organizationById(env, organizationId, event)
  if (!organization) return jsonResponse({ error: 'Organization not found' }, { status: 404 })
  if (!membership) return jsonResponse({ error: 'Not a member of this organization' }, { status: 403 })

  return jsonResponse({
    user: { id: session.user.id, name: session.user.name, email: session.user.email, image: session.user.image ?? null },
    session: { id: session.session.id, expiresAt: session.session.expiresAt, impersonatedBy: session.session.impersonatedBy ?? null },
    organization: {
      id: organization.id,
      slug: organization.slug,
      name: organization.name,
      default_currency: organization.default_currency,
      timezone: organization.timezone,
    },
    member: { id: membership.memberId, role: membership.role },
  })
})
