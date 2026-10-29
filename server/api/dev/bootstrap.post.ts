import { HTTPError, defineHandler } from 'nitro'
import { readBody } from 'nitro/h3'
import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { createAuth } from '~/server/utils/auth'
import { assertDevRouteAllowed } from '~/server/utils/dev-route-auth'
import { executeBatch } from '~/server/db'
import { provisionOrganization } from '~/server/utils/organization-provisioning'
import { PLATFORM_THEME_ID } from '~/utils/template-registry'

// A fresh local E2E database holds nothing, and the Worker serves no platform
// request until one organization runs the platform template. Production's
// platform organization exists only as data; this creates the local one the
// same way, after an administrator and an ordinary provisioned organization
// have been made through Better Auth and provisioning.
export default defineHandler(async (event) => {
  assertDevRouteAllowed(event)
  const body = await readBody(event) as { admin?: { id?: unknown; email?: unknown; name?: unknown; password?: unknown } } | undefined
  const { id, email, name, password } = body?.admin ?? {}
  if (typeof id !== 'string' || typeof email !== 'string' || typeof name !== 'string' || typeof password !== 'string') {
    throw new HTTPError({ statusCode: 400, message: 'admin.id, admin.email, admin.name and admin.password are required' })
  }
  const env = cloudflareEnv(event)
  const db = env.DB
  if (!db) throw new HTTPError({ statusCode: 500, message: 'Database not available' })
  const auth = createAuth(env)
  const created = await auth.api.createUser({ body: { email, name, password, role: 'admin', data: { id, emailVerified: true } } })
  if (created.user.id !== id) throw new HTTPError({ statusCode: 500, message: 'Better Auth did not keep the requested administrator ID' })
  const organization = await auth.api.createOrganization({
    body: { name: 'KrabiClaw', slug: 'platform', userId: id, default_currency: 'USD', timezone: 'America/Los_Angeles' },
  })
  if (!organization) throw new HTTPError({ statusCode: 500, message: 'Better Auth did not create the platform organization' })
  const provisioned = await provisionOrganization(env, db, id, {
    organizationId: organization.id, name: 'KrabiClaw', subdomain: 'krabiclaw', vertical: 'service', sourceLocale: 'en', origin: event.req,
  })
  if (provisioned.status !== 200) throw new HTTPError({ statusCode: provisioned.status, message: `Provisioning the platform organization failed: ${JSON.stringify(provisioned.data)}` })
  await executeBatch(db, [{
    query: "UPDATE organization SET theme_id = ? WHERE id = ? AND onboarding_status = 'active'",
    params: [PLATFORM_THEME_ID, organization.id],
  }], { operation: 'assign the local platform template' })
  return jsonResponse({ admin: { id }, platformOrganizationId: organization.id }, { status: 201 })
})
