import { defineHandler } from 'nitro'
import { getRouterParam, readBody } from 'nitro/h3'
import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { getAuthSession } from '~/server/utils/auth'
import { activateOnboardingDraft } from '~/server/utils/onboarding-apply'
import { firstHomeSetupPath, firstMenuSectionSetupPath, firstPracticeAreaPath } from '~/server/utils/dashboard-links'
import { activateSessionOrganization } from '~/server/utils/session-organization'

export default defineHandler(async (event) => {
  const env = cloudflareEnv(event)
  if (!env.DB) return jsonResponse({ error: 'Database not available' }, { status: 500 })
  const session = await getAuthSession(event, env)
  if (!session?.user?.id) return jsonResponse({ error: 'Authentication required' }, { status: 401 })
  const draftId = getRouterParam(event, 'draft_id')
  if (!draftId) return jsonResponse({ error: 'Draft id is required' }, { status: 400 })
  const body = await readBody(event) as { updated_at?: unknown }
  if (typeof body?.updated_at !== 'string' || !body.updated_at) return jsonResponse({ error: 'Saved draft revision is required' }, { status: 400 })
  const { first_menu_setup: firstMenuSetup, source_type: sourceType, ...result } = await activateOnboardingDraft(env, env.DB, {
    userId: session.user.id,
    draftId,
    updated_at: body.updated_at,
    origin: event.req,
    initialVisibility: 'inactive',
    activateSession: organizationId => activateSessionOrganization(event, env, organizationId),
  })
  const slug = result.organization_slug
  let nextUrl = `/dashboard/${encodeURIComponent(slug)}`
  if (result.vertical === 'lodging') nextUrl = firstHomeSetupPath(slug)
  else if (firstMenuSetup) nextUrl = firstMenuSectionSetupPath(slug, result.location_id)
  else if (result.vertical === 'service' && sourceType === 'manual') nextUrl = firstPracticeAreaPath(slug)
  return jsonResponse({ success: true, ...result, next_url: nextUrl })
})
