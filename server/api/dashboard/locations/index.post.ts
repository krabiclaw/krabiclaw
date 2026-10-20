// POST /api/dashboard/locations
// The location record's create walk commits here: what names it and the clock
// its sessions run on. Everything else is a section of the location once it
// exists. Requires an existing site — onboarding creates the first location.
import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { getAuthSession } from '~/server/utils/auth'
import { getDashboardContext } from '~/server/utils/dashboard-context'
import { createLocation, type CreateLocationInput, type LocationRecord } from '~/server/utils/location-management'
import { purgePublicResourceCacheNow } from '~/server/utils/public-resource-cache'
import { assertOrganizationWideAccess, memberAccessPrincipal } from '~/server/utils/member-access'

export default defineHandler(async (event) => {
  const env = cloudflareEnv(event)
  const db = env.DB
  if (!db) return jsonResponse({ error: 'Database not available' }, { status: 500 })

  const session = await getAuthSession(event, env)
  if (!session?.user?.id) return jsonResponse({ error: 'Authentication required' }, { status: 401 })

  const { organization } = await getDashboardContext(event)
  await assertOrganizationWideAccess(db, memberAccessPrincipal(organization, { env, event }))

  const body = await readBody(event) as { title?: unknown; timezone?: unknown; opening_hours?: unknown; special_hours?: unknown } | null
  const title = typeof body?.title === 'string' ? body.title : ''
  const timezone = typeof body?.timezone === 'string' ? body.timezone : null
  const result = await createLocation(env, db, organization.id, {
    title,
    timezone,
    // Read as the client sent them; createLocation parses both and refuses what does not parse.
    opening_hours: body?.opening_hours as CreateLocationInput['opening_hours'],
    special_hours: body?.special_hours as CreateLocationInput['special_hours'],
  }, session.user.id)
  if (result.status !== 201) return jsonResponse(result.data, { status: result.status })

  await purgePublicResourceCacheNow(env, organization.id)
  return jsonResponse({ success: true, location: (result.data as { location: LocationRecord }).location }, { status: 201 })
})
import { defineHandler } from 'nitro';
import { readBody } from 'nitro/h3';
